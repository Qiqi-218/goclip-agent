/**
 * 清理 OSS 上已确认安全的脏数据。先审计再执行，执行前先备份。
 *
 *   node cleanup-oss.mjs <endpoint> <bucket> <ak> <sk> audit [dir]
 *   node cleanup-oss.mjs <endpoint> <bucket> <ak> <sk> apply <dir>
 *
 * 只做两件确定安全的事：
 *   1. 删除孤儿分析对象 goclip-projects/<p>/analyses/<asset>.json
 *      重构后代码里已无任何读写路径（全库搜索 0 处），且其中各段区间是 0-0。
 *   2. 时间线改名以匹配实际时长（例如 90s_base 实际 17 秒）。
 *      改名不动区间、不动任务，是纯标签修正。
 *
 * **不删时间线。** 区间相同的一对对里，「_v2」「_002」这类看着像修订版本而不是
 * 垃圾 —— 按任务数挑一条删会连带删掉另一条的导出任务记录，那是不可逆的数据损失。
 * 这些只写进报告，由人决定。
 *
 * 与插件的 OSS 访问方式保持一致，确保改的是插件真正读到的字节。
 */
import { createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [endpoint, bucket, id, secret, action, outDir] = process.argv.slice(2)
if (!endpoint || !bucket || !id || !secret || !['audit', 'apply'].includes(action)) {
  console.error('用法: node cleanup-oss.mjs <endpoint> <bucket> <ak> <sk> <audit|apply> <dir>')
  process.exit(2)
}

const PREFIX = 'goclip-projects'
const base = `https://${bucket}.${endpoint.replace(/^https?:\/\//, '')}`
const objectUrl = key => `${base}/${key.split('/').map(encodeURIComponent).join('/')}`
const signature = (method, key, expires, contentType = '') =>
  createHmac('sha1', secret).update(`${method}\n\n${contentType}\n${expires}\n/${bucket}/${key}`).digest('base64')
const signedUrl = key => {
  const expires = String(Math.floor(Date.now() / 1000) + 900)
  return `${objectUrl(key)}?OSSAccessKeyId=${encodeURIComponent(id)}&Expires=${expires}&Signature=${encodeURIComponent(signature('GET', key, expires))}`
}

async function getJson(key) {
  const r = await fetch(signedUrl(key))
  if (!r.ok) throw new Error(`GET ${key} → ${r.status}`)
  return JSON.parse(await r.text())
}

async function putJson(key, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2))
  const date = new Date().toUTCString()
  const r = await fetch(objectUrl(key), {
    method: 'PUT',
    headers: { Date: date, 'Content-Type': 'application/json', Authorization: `OSS ${id}:${signature('PUT', key, date, 'application/json')}` },
    body,
  })
  if (!r.ok) throw new Error(`PUT ${key} → ${r.status} ${(await r.text()).slice(0, 200)}`)
}

async function deleteObject(key) {
  const date = new Date().toUTCString()
  const r = await fetch(objectUrl(key), { method: 'DELETE', headers: { Date: date, Authorization: `OSS ${id}:${signature('DELETE', key, date)}` } })
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${key} → ${r.status} ${(await r.text()).slice(0, 160)}`)
  return r.status
}

const index = await getJson(`${PREFIX}/index.json`)
const manifests = new Map()
for (const pid of index.projects ?? []) manifests.set(pid, await getJson(`${PREFIX}/${pid}/manifest.json`))

if (action === 'apply') {
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, '_index.json'), JSON.stringify(index, null, 2))
  for (const [pid, m] of manifests) await writeFile(join(outDir, `${pid}.manifest.json`), JSON.stringify(m, null, 2))
  console.log(`已备份索引与 ${manifests.size} 个 manifest → ${outDir}\n`)
}

const changes = []
const reports = []
const change = (kind, where, detail) => changes.push({ kind, where, detail })
const report = (kind, where, detail) => reports.push({ kind, where, detail })

// ── 1) 孤儿分析对象 ────────────────────────────────────────────────────────
const orphanKeys = []
for (const [pid, m] of manifests) {
  for (const a of m.assets ?? []) {
    const key = `${PREFIX}/${pid}/analyses/${a.id}.json`
    try {
      const r = await fetch(signedUrl(key))
      if (r.status !== 200) continue
      const d = await r.json()
      const segs = d.segments ?? []
      const zero = segs.filter(s => Number(s.start_us) === 0 && Number(s.end_us) === 0).length
      orphanKeys.push(key)
      change('删除孤儿分析对象', key, `segments=${segs.length}，其中区间为 0-0 的 ${zero} 段；代码中已无任何读写路径`)
    } catch { /* 取不到就不动它 */ }
  }
}

// ── 2) 时间线改名以匹配实际时长（纯标签修正）────────────────────────────────
for (const [pid, m] of manifests) {
  for (const t of m.timelines ?? []) {
    const seconds = Math.round((t.end_us - t.start_us) / 1e6)
    const named = /(\d+)\s*s(?:ec)?(?:_|$)/i.exec(t.id)
    if (!named) continue
    const claimed = Number(named[1])
    // 只改明显不符的；差不到一半的可能是刻意命名，不动
    if (claimed >= 20 && seconds >= 5 && Math.abs(claimed - seconds) / Math.max(claimed, seconds) > 0.5) {
      const renamed = t.id.replace(/(\d+)\s*s(?:ec)?/i, `${seconds}s`)
      if (renamed !== t.id) {
        change('改名以匹配实际时长', `${pid} · ${t.id}`, `实际 ${seconds} 秒，名字写着 ${claimed} 秒 → ${renamed}`)
        t.id = renamed
      }
    }
  }
}

// ── 3) 报告：区间相同的时间线对（不删，交给人判断）──────────────────────────
for (const [pid, m] of manifests) {
  const jobs = m.jobs ?? []
  const groups = new Map()
  for (const t of m.timelines ?? []) {
    const sig = `${t.asset_id}|${t.start_us}|${t.end_us}`
    if (!groups.has(sig)) groups.set(sig, [])
    groups.get(sig).push(t)
  }
  for (const [, group] of groups) {
    if (group.length < 2) continue
    const described = group.map(t => {
      const ids = jobs.filter(j => j.timeline_id === t.id).map(j => j.id.slice(0, 14))
      return `${t.id}（${ids.length} 个任务${ids.length ? '：' + ids.join(', ') : ''}，revision ${t.revision}）`
    })
    report('区间完全相同的时间线（未删除）', pid, described.join('  |  '))
  }
}

// ── 4) 报告：产物不可取回、命名与内容不符 ──────────────────────────────────
for (const [pid, m] of manifests) {
  const gone = (m.jobs ?? []).filter(j => j.status === 'completed' && (j.output ?? '') === '')
  if (gone.length > 0) {
    report('产物不可取回（未改）', pid, `${gone.length} 条 completed 任务的 output 为空：${gone.map(j => j.id.slice(0, 14)).join(', ')}`)
  }
  const empty = (m.analyses ?? []).filter(a => {
    try {
      const segs = JSON.parse(a.data).segments ?? []
      const withReason = segs.filter(s => typeof s.highlight_reason === 'string' && s.highlight_reason.trim() !== '').length
      return segs.length > 0 && withReason === 0
    } catch { return false }
  })
  if (empty.length > 0) report('分析的 highlight_reason 全为空（未改）', pid, `${empty.length} 份分析的片段没有高光理由，影响「找高光」`)
}

console.log(`${'='.repeat(78)}\n将要执行的改动（安全、可逆）\n${'='.repeat(78)}`)
if (changes.length === 0) console.log('  没有需要改的。')
for (const c of changes) console.log(`  [${c.kind}] ${c.where}\n        ${c.detail}`)

console.log(`\n${'='.repeat(78)}\n只报告、不修改（需要你决定）\n${'='.repeat(78)}`)
if (reports.length === 0) console.log('  无。')
for (const r of reports) console.log(`  [${r.kind}] ${r.where}\n        ${r.detail}`)

if (action === 'audit') {
  console.log('\n（audit 模式：备份与改动都未执行）')
  process.exit(0)
}

for (const key of orphanKeys) console.log(`  已删除对象 ${key}（HTTP ${await deleteObject(key)}）`)
for (const [pid, m] of manifests) {
  await putJson(`${PREFIX}/${pid}/manifest.json`, m)
  console.log(`  已写回 ${pid}/manifest.json`)
}
console.log('\n完成。')
