/**
 * How often does local narrowing actually help?
 *
 * The proof of concept showed narrowing *can* turn a 100-second segment into a
 * sentence-sized span. That is not the same as showing it usually does, and the
 * difference decides whether the change is worth having. The failure mode to measure is
 * a query whose words are not in the stored narration: those cannot be narrowed at all,
 * so the caller still receives a coarse segment and may still escalate to re-watching the
 * video.
 *
 * The queries are the 21 the real session sent to `video_find_in_video`, so the hit rate
 * is measured against what a user actually asked, not against invented examples.
 *
 * Measured on that session (43-minute documentary, 28 segments, median width 100 s):
 *
 *   narrowed to a sentence : 13/21   average width 26.2 s
 *   matched but too coarse :  2/21   70-80 s
 *   not matched at all     :  6/21
 *
 * An earlier proof of concept reported 16/21, but it hand-picked quoted phrases out of
 * each query. This script matches the way the runtime actually does — the whole query
 * text, then progressively shorter leading fragments — and 13/21 is the figure that
 * describes the shipped behaviour.
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2]
const raw = readFileSync(path, 'utf8')
const ev = raw.split('\n').filter(Boolean).map(l => JSON.parse(l))
const callById = new Map()
for (const e of ev) if (e.type === 'tool/call') callById.set(e.data.callId, e.data)

const resultText = (name) => {
  for (const e of ev) {
    if (e.type !== 'tool/result') continue
    const c = callById.get(e.data?.message?.toolCallId)
    if (c?.name !== name) continue
    return (e.data.message.content ?? []).map(x => (x.type === 'text' ? x.text : '')).join('')
  }
  return null
}

const analysis = JSON.parse(resultText('video_understand'))
const segments = analysis.segments ?? []

/** The same normalisation the runtime uses, so the measurement matches the behaviour. */
const strip = (v) => v.replace(/[\s，。、；：！？""''（）《》「」…—\-.,;:!?"'()<>]/g, '').toLowerCase()

/** Mirror of the runtime's narrowing: interpolate the containing sentence by character count. */
function narrow(segment, needle) {
  const text = String(segment.audio ?? segment.visual ?? '')
  if (text === '') return null
  const wanted = strip(needle)
  if (wanted === '') return null
  const sentences = text.split(/(?<=[。！？；])/).map(s => s.trim()).filter(s => s !== '')
  if (sentences.length < 2) return null
  const total = sentences.reduce((a, s) => a + s.length, 0)
  if (total === 0) return null
  const start = Number(segment.start_us); const end = Number(segment.end_us)
  const span = end - start
  let consumed = 0
  for (const s of sentences) {
    const from = start + Math.round(span * (consumed / total))
    consumed += s.length
    const to = start + Math.round(span * (consumed / total))
    if (strip(s).includes(wanted)) return { start_us: from, end_us: to }
  }
  return null
}

// The 21 subjects the session actually sent to the expensive full-video tool.
const subjects = []
for (const e of ev) {
  if (e.type !== 'tool/call' || e.data.name !== 'video_find_in_video') continue
  const arg = typeof e.data.arguments === 'string' ? e.data.arguments : JSON.stringify(e.data.arguments)
  const m = arg.match(/"subject"\s*:\s*"([^"]*)"/)
  if (m) subjects.push(m[1])
}

console.log(`分析分段: ${segments.length}，宽度中位数 ${(() => {
  const w = segments.map(s => (s.end_us - s.start_us) / 1e6).sort((a, b) => a - b)
  return w[Math.floor(w.length / 2)].toFixed(0)
})()}s`)
console.log(`复盘 ${subjects.length} 次整片重看所用的查询词\n`)

/** Which segment does the query match, and can it be narrowed there? */
function bestMatch(query) {
  const wanted = strip(query)
  if (wanted === '') return null
  // The real search also matches on individual words; approximate that by trying the
  // whole query first, then progressively shorter leading fragments.
  const candidates = [wanted]
  for (let cut = wanted.length - 1; cut >= 4; cut -= 1) candidates.push(wanted.slice(0, cut))
  for (const cand of candidates) {
    for (const seg of segments) {
      const text = strip(String(seg.audio ?? '') + ' ' + String(seg.visual ?? '') + ' ' + (Array.isArray(seg.tags) ? seg.tags.join(' ') : ''))
      if (!text.includes(cand)) continue
      const narrowed = narrow(seg, cand)
      return { segment: seg, narrowed, anchor: cand }
    }
  }
  return null
}

let narrowedCount = 0
let wholeCount = 0
let noMatch = 0
const rows = []
for (const q of subjects) {
  const hit = bestMatch(q)
  if (hit === null) { noMatch += 1; rows.push({ q, kind: '未命中', width: null }); continue }
  if (hit.narrowed === null) {
    wholeCount += 1
    rows.push({ q, kind: '命中但无法收窄', width: (hit.segment.end_us - hit.segment.start_us) / 1e6 })
  } else {
    narrowedCount += 1
    rows.push({ q, kind: '收窄到句子', width: (hit.narrowed.end_us - hit.narrowed.start_us) / 1e6 })
  }
}

for (const r of rows) {
  const w = r.width === null ? '—' : `${r.width.toFixed(1)}s`
  console.log(`  ${r.kind === '收窄到句子' ? '✅' : r.kind === '命中但无法收窄' ? '⚠️ ' : '❌'}  ${r.kind.padEnd(8)} ${w.padStart(8)}  ${r.q.slice(0, 58)}`)
}

console.log(`\n=== 结论 ===`)
console.log(`  收窄到句子      : ${narrowedCount}/${subjects.length}`)
console.log(`  命中但只能给整段: ${wholeCount}/${subjects.length}`)
console.log(`  完全未命中      : ${noMatch}/${subjects.length}`)

const narrowedWidths = rows.filter(r => r.kind === '收窄到句子').map(r => r.width)
if (narrowedWidths.length > 0) {
  const avg = narrowedWidths.reduce((a, b) => a + b, 0) / narrowedWidths.length
  console.log(`\n  收窄后平均宽度: ${avg.toFixed(1)}s`)
  console.log(`  这些分段原本的宽度中位数: ${(() => {
    const w = segments.map(s => (s.end_us - s.start_us) / 1e6).sort((a, b) => a - b)
    return w[Math.floor(w.length / 2)].toFixed(0)
  })()}s`)
}

console.log('\n=== 这个改动的边界 ===')
console.log('  只在「查询词字面出现在已存转述里」时收窄。')
console.log('  描述式提问（没有可匹配的字面词）仍会拿到整段 —— 这是设计的取舍：')
console.log('  宁可给粗区间，也不给一个猜出来的精确区间。')
