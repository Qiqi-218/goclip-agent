/**
 * 修复 OSS 上的项目脏数据。先 audit 看清楚，再 apply。
 *
 *   node repair-oss.mjs <endpoint> <bucket> <ak> <sk> audit [dir]
 *   node repair-oss.mjs <endpoint> <bucket> <ak> <sk> apply <dir>
 *
 * apply 会做四件事，并先把原始数据备份到 <dir>：
 *   1. 时间线区间越界  → 夹到素材实际时长
 *   2. 空/反向区间      → 丢弃该时间线
 *   3. 输出不是 oss://  → 清空 output 并把原因写进 detail（不伪造 OSS 地址）
 *   4. -p1/-p2 跨项目引用 → 把 -p1 的时间线与任务迁到 -p2，随后删除 -p1
 *
 * OSS 的签名算法与插件的 signature()/signedUrl() 一致，确保改的是插件真正读到的字节。
 */
import { createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [endpoint, bucket, id, secret, action, outDir] = process.argv.slice(2)
if (!endpoint || !bucket || !id || !secret || !['audit', 'apply'].includes(action)) {
  console.error('用法: node repair-oss.mjs <endpoint> <bucket> <ak> <sk> <audit|apply> <dir>')
  process.exit(2)
}

/** 合并目标：素材与分析都在这里，迁过来的时间线立刻可渲染。 */
const KEEP_PROJECT = 'highlight_clip_001'
/** 只引用素材、自己却没有素材的项目，其时间线与任务迁到 KEEP_PROJECT。 */
const MERGE_FROM = ['project_bv1p5h16je8n']
/** 完全空的项目，直接删。 */
const DELETE_PROJECTS = ['project_001', 'project_002']

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
    headers: {
      Date: date,
      'Content-Type': 'application/json',
      Authorization: `OSS ${id}:${signature('PUT', key, date, 'application/json')}`,
    },
    body,
  })
  if (!r.ok) throw new Error(`PUT ${key} → ${r.status} ${(await r.text()).slice(0, 200)}`)
}

async function deleteObject(key) {
  const date = new Date().toUTCString()
  const r = await fetch(objectUrl(key), {
    method: 'DELETE',
    headers: { Date: date, Authorization: `OSS ${id}:${signature('DELETE', key, date)}` },
  })
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${key} → ${r.status}`)
}

const meta = row => (typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta ?? {}))

const index = await getJson(`${PREFIX}/index.json`)
const manifests = new Map()
for (const pid of index.projects ?? []) {
  try { manifests.set(pid, await getJson(`${PREFIX}/${pid}/manifest.json`)) }
  catch (error) { console.log(`  ⚠️ 读不到 ${pid}/manifest.json：${error.message}`) }
}

// ── 先备份，再动手 ─────────────────────────────────────────────────────────
if (action === 'apply') {
  await mkdir(outDir, { recursive: true })
  for (const [pid, m] of manifests) {
    await writeFile(join(outDir, `${pid}.manifest.json`), JSON.stringify(m, null, 2))
  }
  await writeFile(join(outDir, '_index.json'), JSON.stringify(index, null, 2))
  console.log(`已备份 ${manifests.size} 个 manifest + 索引 → ${outDir}\n`)
}

const audit = []
const note = (kind, where, detail) => audit.push({ kind, where, detail })

// ── 1+2) 区间越界与空区间 ──────────────────────────────────────────────────
for (const [pid, m] of manifests) {
  const duration = new Map()
  for (const a of m.assets ?? []) duration.set(a.id, meta(a).duration_us ?? null)

  const kept = []
  for (const t of m.timelines ?? []) {
    const d = duration.get(t.asset_id)
    if (t.start_us >= t.end_us) {
      note('丢弃空/反向区间', `${pid} · timeline ${t.id}`, `start_us=${t.start_us} end_us=${t.end_us}`)
      continue
    }
    if (typeof d === 'number' && d > 0 && t.end_us > d) {
      note('区间夹到素材时长', `${pid} · timeline ${t.id}`, `end_us ${t.end_us} → ${d}`)
      t.end_us = d
    }
    kept.push(t)
  }
  m.timelines = kept
}

// ── 3) 输出不是 OSS 引用 ────────────────────────────────────────────────────
for (const [pid, m] of manifests) {
  for (const j of m.jobs ?? []) {
    const out = j.output ?? ''
    if (out === '' || out.startsWith('oss://')) continue
    note('清空非 OSS 输出', `${pid} · job ${j.id}`, out)
    j.output = ''
    const why = `原输出路径是某台机器上的本地文件（${out}），不是 OSS 对象；该产物无法通过 OSS 取回，故清空。`
    j.detail = j.detail ? `${j.detail}｜${why}` : why
  }
}

// ── 4) 跨项目引用：把 -p1 的时间线与任务迁到 KEEP_PROJECT ───────────────────
for (const from of MERGE_FROM) {
  const src = manifests.get(from)
  const dst = manifests.get(KEEP_PROJECT)
  if (!src || !dst) continue

  const timelineIds = new Set((src.timelines ?? []).map(t => t.id))
  for (const t of src.timelines ?? []) {
    if ((dst.timelines ?? []).some(x => x.id === t.id)) {
      note('跳过重名时间线', `${from} → ${KEEP_PROJECT}`, t.id)
      continue
    }
    t.project_id = KEEP_PROJECT
    dst.timelines.push(t)
    note('迁移时间线', `${from} → ${KEEP_PROJECT}`, `${t.id}（${t.start_us}–${t.end_us}）`)
  }
  for (const j of src.jobs ?? []) {
    j.timeline_id = j.timeline_id
    if ((dst.jobs ?? []).some(x => x.id === j.id)) continue
    dst.jobs.push(j)
    note('迁移任务', `${from} → ${KEEP_PROJECT}`, `${j.id}（${j.status}）`)
  }
  src.timelines = []
  src.jobs = []
  void timelineIds
}

// ── 执行写入 ───────────────────────────────────────────────────────────────
const remaining = []
for (const [pid, m] of manifests) {
  if (DELETE_PROJECTS.includes(pid)) {
    note('删除空项目', pid, `名称=${m.project?.name}，素材/时间线/任务全为 0`)
    continue
  }
  if (MERGE_FROM.includes(pid)) {
    const empty = (m.assets ?? []).length === 0 && (m.timelines ?? []).length === 0
      && (m.jobs ?? []).length === 0 && (m.analyses ?? []).length === 0
    if (empty) {
      note('删除已迁空的项目', pid, '时间线与任务已迁出，项目本身无素材无分析')
      continue
    }
  }
  remaining.push(pid)
}

console.log(`${'='.repeat(78)}\n将要做的改动\n${'='.repeat(78)}`)
if (audit.length === 0) console.log('  没有需要改的。')
for (const a of audit) console.log(`  [${a.kind}] ${a.where}\n        ${a.detail}`)
console.log(`\n保留的项目: ${remaining.join(', ')}`)

if (action === 'audit') {
  console.log('\n（audit 模式：备份与改动都未执行）')
  process.exit(0)
}

for (const pid of remaining) {
  await putJson(`${PREFIX}/${pid}/manifest.json`, manifests.get(pid))
  console.log(`  已写回 ${pid}/manifest.json`)
}
for (const pid of [...DELETE_PROJECTS, ...MERGE_FROM]) {
  if (remaining.includes(pid)) continue
  try { await deleteObject(`${PREFIX}/${pid}/manifest.json`); console.log(`  已删除 ${pid}/manifest.json`) }
  catch (error) { console.log(`  ⚠️ 删除 ${pid}/manifest.json 失败：${error.message}`) }
}
await putJson(`${PREFIX}/index.json`, { version: 1, projects: remaining })
console.log(`  已写回 index.json（${remaining.length} 个项目）`)
console.log('\n完成。')
