/**
 * 把「引号里的原话」当作检索锚点，复测那 21 条查询。
 *
 * 前一次度量得到 0/21，但那是度量方法的问题：那 21 条查询的形状是
 *   「讲解者说「X」以及「Y」，请给出这几句话的起止时间」
 * 是**定位请求**，不是搜索词。把整条查询当成子串去匹配，永远不可能命中 ——
 * 而早先测出的 13/21 是因为我逐级缩短前缀，恰好凑到了部分匹配，
 * 那个数字既不高也不低，只是没有意义。
 *
 * 真实相关的问题是：**引号里那句原话，能不能在转写里字面找到。**
 * 如果能，那么「先提取锚点再检索」就能回答这些问题，
 * 而模型当初正是因为没有这条路才去重看整片视频。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

const DB = 'E:\\huabei\\goclip-agentv2\\runtime\\video-tools\\video-tools.sqlite'
const ASSET = 'asset-f6a2d8aa38932048010b'
const SESSION = process.argv[2]
if (SESSION === undefined) { console.error('用法：node measure-anchors.mjs <session.jsonl>'); process.exit(2) }

const db = new DatabaseSync(DB)
const row = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(ASSET, 'transcript')
const analyses = db.prepare('SELECT data FROM analyses WHERE asset_id=?').all(ASSET)
db.close()
const lines = row === undefined ? [] : (JSON.parse(row.payload).lines ?? [])
/** 分析分段的 audio 字段：多模态模型对说话的转述，与逐字转写互补。 */
const segs = analyses.flatMap(a => (JSON.parse(a.data).segments ?? []))
console.log(`转写：${lines.length} 条句子级区间，中位宽度 ${(() => {
  const w = lines.map(l => (l.end_us - l.start_us) / 1e6).sort((a, b) => a - b)
  return w[Math.floor(w.length / 2)].toFixed(1)
})()}s`)
console.log(`分析：${segs.length} 段，中位宽度 ${(() => {
  const w = segs.map(s => (s.end_us - s.start_us) / 1e6).sort((a, b) => a - b)
  return w.length === 0 ? '—' : w[Math.floor(w.length / 2)].toFixed(0) + 's'
})()}\n`)

const strip = (v) => v.replace(/[\s，。、；：！？""''（）《》「」…—\-.,;:!?"'()<>]/g, '').toLowerCase()

const ev = readFileSync(SESSION, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const subjects = []
for (const e of ev) {
  if (e.type !== 'tool/call' || e.data.name !== 'video_find_in_video') continue
  const arg = typeof e.data.arguments === 'string' ? e.data.arguments : JSON.stringify(e.data.arguments)
  const m = arg.match(/"subject"\s*:\s*"([^"]*)"/)
  if (m) subjects.push(m[1])
}

/** 取出查询里引号包起来的原话 —— 那些才是可检索的锚点。 */
function anchorsOf(query) {
  const out = []
  for (const m of query.matchAll(/[「『"]([^」』"]{4,})[」』"]/g)) out.push(m[1])
  return out
}

console.log(`复测 ${subjects.length} 条真实查询，判据是「引号里的原话能否字面命中」\n`)

let allFound = 0
let partial = 0
let none = 0
let noAnchor = 0
const details = []

for (const q of subjects) {
  const anchors = anchorsOf(q)
  if (anchors.length === 0) { noAnchor += 1; details.push({ q, anchors: [], found: [] }); continue }
  const found = anchors.map(a => {
    const na = strip(a)
    // 逐字转写优先：它给的是真实句界。命中不了再查分析转述 ——
    // 那一份是模型对说话内容的复述，用词不同但覆盖更广
    // （实测「与其强请画毁不如售画修庙」只在后者里）。
    const asrLine = lines.find(l => strip(String(l.text ?? '')).includes(na))
    if (asrLine !== undefined) {
      return { anchor: a, hit: { start_us: asrLine.start_us, end_us: asrLine.end_us, text: asrLine.text, origin: 'transcript' } }
    }
    const seg = segs.find(s => strip(String(s.audio ?? '')).includes(na))
    if (seg !== undefined) {
      // 分析分段很宽，收窄到含锚点的那一句（按字数比例插值）——
      // 这是旧的收窄逻辑，仍然服务于分析数据。
      const text = String(seg.audio ?? '')
      const parts = text.split(/(?<=[。！？；])/).map(x => x.trim()).filter(x => x !== '')
      const anchorText = parts.find(x => strip(x).includes(na))
      if (anchorText !== undefined && parts.length > 1) {
        const total = parts.reduce((n, x) => n + x.length, 0)
        let consumed = 0
        for (const part of parts) {
          const from = Number(seg.start_us) + Math.round((Number(seg.end_us) - Number(seg.start_us)) * (consumed / total))
          consumed += part.length
          const to = Number(seg.start_us) + Math.round((Number(seg.end_us) - Number(seg.start_us)) * (consumed / total))
          if (strip(part).includes(na)) return { anchor: a, hit: { start_us: from, end_us: to, text: part, origin: 'analysis' } }
        }
      }
      return { anchor: a, hit: { start_us: Number(seg.start_us), end_us: Number(seg.end_us), text: text.slice(0, 60), origin: 'analysis-whole' } }
    }
    return { anchor: a, hit: null }
  })
  const n = found.filter(f => f.hit !== null).length
  if (n === anchors.length) allFound += 1
  else if (n > 0) partial += 1
  else none += 1
  details.push({ q, anchors, found })
}

for (const d of details) {
  if (d.anchors.length === 0) { console.log(`  ⚠️  无引号锚点                    ${d.q.slice(0, 56)}`); continue }
  const n = d.found.filter(f => f.hit !== null).length
  const mark = n === d.anchors.length ? '✅' : n > 0 ? '🔶' : '❌'
  const spans = d.found.filter(f => f.hit !== null)
    .map(f => `${(f.hit.start_us / 1e6).toFixed(1)}-${(f.hit.end_us / 1e6).toFixed(1)}s(${f.hit.origin === 'transcript' ? '逐字' : '转述'})`).join(' ')
  console.log(`  ${mark} 锚点 ${n}/${d.anchors.length}  ${spans.padEnd(24)} ${d.q.slice(0, 40)}`)
  for (const f of d.found) {
    if (f.hit === null) console.log(`        未找到: 「${f.anchor.slice(0, 40)}」`)
  }
}

const totalAnchors = details.reduce((n, d) => n + d.anchors.length, 0)
const foundAnchors = details.reduce((n, d) => n + d.found.filter(f => f.hit !== null).length, 0)

console.log(`\n=== 结论 ===`)
console.log(`  查询总数              : ${subjects.length}`)
console.log(`  全部锚点都能找到      : ${allFound}`)
console.log(`  部分锚点找到          : ${partial}`)
console.log(`  一个都找不到          : ${none}`)
console.log(`  查询里没有引号锚点    : ${noAnchor}`)
console.log(`\n  锚点级命中率          : ${foundAnchors}/${totalAnchors}（${(100 * foundAnchors / Math.max(1, totalAnchors)).toFixed(0)}%）`)

const answered = details.filter(d => d.anchors.length > 0 && d.found.every(f => f.hit !== null)).length
const FIND_MS = 39_900
console.log(`\n=== 对那场会话的投影 ===`)
console.log(`  可被「锚点检索」直接回答 : ${answered}/${subjects.length}`)
console.log(`  省下 ${(answered * FIND_MS / 60000).toFixed(1)} 分钟（原 838.8s / 14.0 分钟）`)
console.log(`  工具耗时 1339s → ${((1339_000 - answered * FIND_MS) / 1000).toFixed(0)}s（降 ${(100 * answered * FIND_MS / 1339_000).toFixed(0)}%）`)
console.log(`\n  未验证的部分：模型是否会改用「先给原话、再取时间」这条路径。`)
console.log(`  现在 video_find 只接受一个 text 参数，而一次定位请求里常有 2–3 句原话。`)
