/**
 * Is the empty-transcript failure systemic, or was that session unlucky?
 *
 * One log proves a mechanism; it does not prove a frequency. This walks every
 * session log on this machine and reports, per model-backed evidence call, what
 * the text/reasoning token split was — an answer that is all reasoning with no
 * text is the shape that broke the transcript.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = process.argv[2]
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode a session log, which may be plain JSONL or multi-frame zstd. */
function readLog(file) {
  const raw = readFileSync(file)
  if (raw.subarray(0, 4).equals(MAGIC)) {
    const offs = []
    let at = raw.indexOf(MAGIC, 0)
    while (at !== -1) { offs.push(at); at = raw.indexOf(MAGIC, at + 4) }
    let out = ''
    for (let i = 0; i < offs.length; i += 1) {
      try { out += zstdDecompressSync(raw.subarray(offs[i], offs[i + 1] ?? raw.length)).toString('utf8') } catch { /* frame noise */ }
    }
    return out
  }
  return raw.toString('utf8')
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.startsWith('session.') && (e.name.endsWith('.jsonl') || e.name.endsWith('.zstd'))) out.push(p)
  }
  return out
}

const files = walk(ROOT)
console.log(`session logs found: ${files.length}`)

const rows = []
for (const file of files) {
  let text
  try { text = readLog(file) } catch { continue }
  const ev = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { ev.push(JSON.parse(line)) } catch { /* skip */ }
  }
  const callById = new Map()
  for (const e of ev) if (e.type === 'tool/call') callById.set(e.data.callId, e.data)
  for (const e of ev) {
    if (e.type !== 'tool/result') continue
    const c = callById.get(e.data?.message?.toolCallId)
    if (!c) continue
    const body = (e.data.message.content ?? []).map(x => (x.type === 'text' ? x.text : '')).join('')
    let parsed = null
    try { parsed = JSON.parse(body) } catch { /* not json */ }
    const usage = parsed?.usage
    if (!Array.isArray(usage) || usage.length === 0) continue
    const u = usage[0]
    rows.push({
      file: file.split(/[\\/]/).slice(-2)[0].slice(0, 22),
      tool: c.name,
      textTokens: u.text_tokens ?? 0,
      reasoningTokens: u.reasoning_tokens ?? 0,
      ms: u.ms ?? 0,
      // the shape that broke: reasoning present, text ~absent
      emptyText: (u.text_tokens ?? 0) < 50,
      heavyReasoning: (u.reasoning_tokens ?? 0) >= 8000,
    })
  }
}

console.log(`model-backed evidence calls with usage: ${rows.length}\n`)
if (rows.length === 0) process.exit(0)

console.log('=== 每次模型调用的 text vs reasoning token ===')
console.log('  tool                              text  reasoning      ms  flag')
for (const r of rows.sort((a, b) => b.ms - a.ms)) {
  const flag = r.emptyText && r.heavyReasoning ? '  <== 思考吃光预算，输出为空' : (r.emptyText ? '  <== 输出为空' : '')
  console.log(`  ${r.tool.padEnd(30)} ${String(r.textTokens).padStart(6)} ${String(r.reasoningTokens).padStart(10)} ${String(Math.round(r.ms / 1000) + 's').padStart(7)}${flag}`)
}

const broken = rows.filter(r => r.emptyText && r.heavyReasoning)
console.log(`\n=== 结论 ===`)
console.log(`  调用总数: ${rows.length}`)
console.log(`  「思考吃光预算 + 输出为空」: ${broken.length} 次 (${(100 * broken.length / rows.length).toFixed(0)}%)`)
const byTool = new Map()
for (const r of rows) {
  const cur = byTool.get(r.tool) ?? { n: 0, broken: 0 }
  cur.n += 1
  if (r.emptyText && r.heavyReasoning) cur.broken += 1
  byTool.set(r.tool, cur)
}
console.log('\n  按工具:')
for (const [k, v] of [...byTool].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`    ${k.padEnd(30)} ${v.broken}/${v.n} 失败`)
}
