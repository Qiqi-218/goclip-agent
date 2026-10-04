/**
 * 用那场会话真实发过的 21 条查询，复测本地检索现在的命中情况。
 *
 * 背景：那 21 条查询原本被发给了 video_find_in_video —— 每次让多模态模型重看整条
 * 43 分钟视频，平均 39.9 秒，合计 838.8 秒（占工具耗时 63%）。
 *
 * 当时本地检索只有「分析分段」这一种来源，实测 13/21 能收窄到句子、平均宽度 26.2s，
 * 其余要么给整段、要么完全命中不了。
 *
 * 现在转写改成了专用识别模型：246 条真实句子级区间（毫秒精度），而不是靠字符比例
 * 插值猜出来的边界。这个脚本量的是**这笔账还剩多少**。
 *
 * 它直接读实时数据库，所以量的是真实证据，不是构造的。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

const DB = 'E:\\huabei\\goclip-agentv2\\runtime\\video-tools\\video-tools.sqlite'
const ASSET = 'asset-f6a2d8aa38932048010b'
const SESSION = process.argv[2]
if (SESSION === undefined) { console.error('用法：node measure-narrowing2.mjs <session.jsonl>'); process.exit(2) }

// ---- 取出真实证据 --------------------------------------------------------
const db = new DatabaseSync(DB)
const read = (kind) => {
  const row = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(ASSET, kind)
  return row === undefined ? null : JSON.parse(row.payload)
}
const transcript = read('transcript')
const visual = read('scene-description')
db.close()

const segs = visual?.scenes ?? []
const lines = transcript?.lines ?? []
console.log(`真实证据：转写 ${lines.length} 条句子级区间，画面描述 ${segs.length} 段`)
if (lines.length > 0) {
  const widths = lines.map(l => (l.end_us - l.start_us) / 1e6).sort((a, b) => a - b)
  const first = lines[0].start_us / 1e6
  const last = lines[lines.length - 1].end_us / 1e6
  console.log(`  转写区间宽度: min ${widths[0].toFixed(1)}s  中位 ${widths[Math.floor(widths.length / 2)].toFixed(1)}s  max ${widths[widths.length - 1].toFixed(1)}s`)
  console.log(`  转写覆盖: ${(first / 60).toFixed(1)} – ${(last / 60).toFixed(1)} 分钟`)
}
if (segs.length > 0) {
  const w = segs.map(s => (s.end_us - s.start_us) / 1e6).sort((a, b) => a - b)
  console.log(`  画面分段宽度中位: ${w[Math.floor(w.length / 2)].toFixed(0)}s`)
}

// ---- 那 21 条查询 --------------------------------------------------------
const ev = readFileSync(SESSION, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const subjects = []
for (const e of ev) {
  if (e.type !== 'tool/call' || e.data.name !== 'video_find_in_video') continue
  const arg = typeof e.data.arguments === 'string' ? e.data.arguments : JSON.stringify(e.data.arguments)
  const m = arg.match(/"subject"\s*:\s*"([^"]*)"/)
  if (m) subjects.push(m[1])
}
console.log(`\n复测 ${subjects.length} 条真实查询（原本各触发一次整片重看）\n`)

/** 与运行时一致的归一化。 */
const strip = (v) => v.replace(/[\s，。、；：！？""''（）《》「」…—\-.,;:!?"'()<>]/g, '').toLowerCase()

/**
 * 复刻运行时的匹配：整条查询、再逐级缩短前缀，落到哪条证据上。
 * 转写与画面描述都在同一流水线里，但转写是字面精确命中、画面是近似命中。
 */
function locate(query) {
  const wanted = strip(query)
  if (wanted === '') return null
  const candidates = [wanted]
  for (let cut = wanted.length - 1; cut >= 5; cut -= 1) candidates.push(wanted.slice(0, cut))
  for (const cand of candidates) {
    for (const line of lines) {
      if (strip(String(line.text ?? '')).includes(cand)) {
        return { origin: 'transcript', start_us: line.start_us, end_us: line.end_us, text: line.text, anchor: cand }
      }
    }
    for (const seg of segs) {
      const hay = strip(String(seg.description ?? '') + ' ' + (Array.isArray(seg.on_screen) ? seg.on_screen.join(' ') : ''))
      if (hay.includes(cand)) {
        return { origin: 'scene-description', start_us: seg.start_us, end_us: seg.end_us, text: seg.description, anchor: cand }
      }
    }
  }
  return null
}

const FIND_IN_VIDEO_MS = 39_900 // 那场会话里 video_find_in_video 的单次实测均值
let answered = 0
let missed = 0
const rows = []
for (const q of subjects) {
  const hit = locate(q)
  if (hit === null) { missed += 1; rows.push({ q, hit: null }) } else { answered += 1; rows.push({ q, hit }) }
}

for (const r of rows) {
  if (r.hit === null) { console.log(`  ❌ 未命中            ${r.q.slice(0, 62)}`); continue }
  const w = (r.hit.end_us - r.hit.start_us) / 1e6
  const at = (r.hit.start_us / 1e6 / 60).toFixed(1)
  console.log(`  ✅ ${r.hit.origin === 'transcript' ? '转写' : '画面'}  ${w.toFixed(1).padStart(6)}s  @${at}分  ${r.q.slice(0, 50)}`)
}

console.log(`\n=== 结论 ===`)
console.log(`  本地检索可直接回答 : ${answered}/${subjects.length}`)
console.log(`  仍需整片重看       : ${missed}/${subjects.length}`)
const widths = rows.filter(r => r.hit !== null).map(r => (r.hit.end_us - r.hit.start_us) / 1e6)
if (widths.length > 0) {
  console.log(`  命中区间宽度中位   : ${(widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)]).toFixed(1)}s`)
  console.log(`  命中区间宽度均值   : ${(widths.reduce((a, b) => a + b, 0) / widths.length).toFixed(1)}s`)
}
const fromTranscript = rows.filter(r => r.hit?.origin === 'transcript').length
console.log(`  其中来自语音转写   : ${fromTranscript}/${answered}`)

console.log(`\n=== 对那场会话的投影 ===`)
const savedMs = answered * FIND_IN_VIDEO_MS
console.log(`  原本 21 次整片重看合计 838.8s（占工具耗时 63%）`)
console.log(`  若这 ${answered} 次不再发生 → 省 ${(savedMs / 60000).toFixed(1)} 分钟`)
console.log(`  剩余 ${missed} 次仍需整片重看 → ${(missed * FIND_IN_VIDEO_MS / 60000).toFixed(1)} 分钟`)
console.log(`  工具耗时 1339s → ${((1339_000 - savedMs) / 1000).toFixed(0)}s（降 ${(100 * savedMs / 1339_000).toFixed(0)}%）`)
console.log(`\n  这一步仍未验证的：模型拿到句子级区间后是否真的不再升级到整片重看。`)
