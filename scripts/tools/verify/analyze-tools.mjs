/**
 * 一份会话日志的工具调用序列与耗时。
 *
 * 存在的理由：`analyze-sessions.mjs` 是「找成本异常」的入口，它按模型调用维度看；
 * 而验证「整片重看有没有减少」要看的是**工具维度**的调用次数与墙钟耗时。
 * 把两者混在一起看会得出错误结论 —— 实测踩过：把两份日志一起扫，
 * 得到「video_find_in_video 22 次」，而新会话里一次都没有。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = process.argv[2]
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 解一份可能是一帧一追加的 zstd 日志。 */
function readLog(file) {
  const raw = readFileSync(file)
  if (!raw.subarray(0, 4).equals(MAGIC)) return raw.toString('utf8')
  const offs = []
  let at = raw.indexOf(MAGIC, 0)
  while (at !== -1) { offs.push(at); at = raw.indexOf(MAGIC, at + 4) }
  let out = ''
  for (let i = 0; i < offs.length; i += 1) {
    try { out += zstdDecompressSync(raw.subarray(offs[i], offs[i + 1] ?? raw.length)).toString('utf8') } catch { /* 帧噪声 */ }
  }
  return out
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.startsWith('session.') && entry.name.endsWith('.zstd')) out.push(p)
  }
  return out
}

const files = walk(ROOT)
if (files.length === 0) { console.error('没有找到会话日志'); process.exit(1) }
// 只取最近的一份：混扫多份会把不同会话的调用加在一起。
const file = files.map(f => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0].f
console.log(`会话: ${file.split(/[\\/]/).slice(-2)[0]}`)
console.log(`大小: ${(statSync(file).size / 1024).toFixed(0)} KB\n`)

const ev = readLog(file).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const calls = new Map()
for (const e of ev) if (e.type === 'tool/call') calls.set(e.data.callId, { name: e.data.name, at: e.time, args: e.data.arguments })

const stats = new Map()
const sequence = []
let toolMs = 0
for (const e of ev) {
  if (e.type !== 'tool/result') continue
  const call = calls.get(e.data?.message?.toolCallId)
  if (call === undefined) continue
  const ms = (call.at !== undefined && e.time !== undefined) ? e.time - call.at : null
  if (ms !== null) toolMs += ms
  const cur = stats.get(call.name) ?? { n: 0, ms: 0 }
  cur.n += 1
  if (ms !== null) cur.ms += ms
  stats.set(call.name, cur)
  sequence.push({ name: call.name, ms })
}

console.log('=== 调用序列 ===')
for (const s of sequence) console.log(`  ${String(s.ms ?? '?').padStart(7)}ms  ${s.name}`)

console.log('\n=== 按工具 ===')
console.log('  工具                              次数      总耗时      均值')
for (const [name, v] of [...stats].sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(`  ${name.padEnd(32)} ${String(v.n).padStart(4)}  ${String((v.ms / 1000).toFixed(1) + 's').padStart(9)}  ${String((v.ms / v.n / 1000).toFixed(1) + 's').padStart(9)}`)
}
console.log(`\n  工具耗时合计: ${(toolMs / 1000).toFixed(1)}s`)
console.log(`  调用总数: ${sequence.length}`)

// 与基线对照 —— 这是整件事要回答的问题。
const BASE = { findInVideo: 21, findInVideoMs: 838_800, toolMs: 1_339_000, calls: 74 }
const fiv = stats.get('video_find_in_video') ?? { n: 0, ms: 0 }
const fnd = stats.get('video_find') ?? { n: 0, ms: 0 }
console.log('\n=== 与基线对照（同一素材：43 分钟广胜寺）===')
console.log('  指标                        基线        本次      变化')
const row = (label, a, b, unit = '') => {
  const delta = a === 0 ? '—' : `${(((b - a) / a) * 100).toFixed(0)}%`
  console.log(`  ${label.padEnd(26)} ${String(a + unit).padStart(9)} ${String(b + unit).padStart(10)} ${delta.padStart(8)}`)
}
row('video_find_in_video 次数', BASE.findInVideo, fiv.n)
row('video_find_in_video 耗时', (BASE.findInVideoMs / 1000).toFixed(0), (fiv.ms / 1000).toFixed(0), 's')
row('video_find 次数', 9, fnd.n)
row('工具耗时合计', (BASE.toolMs / 1000).toFixed(0), (toolMs / 1000).toFixed(0), 's')
row('工具调用总数', BASE.calls, sequence.length)
