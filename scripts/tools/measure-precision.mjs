/**
 * Measure how close a query's returned range is to where it should be.
 *
 * Precision is the one property of this product that cannot be argued from a demo: a cut
 * two seconds off looks fine in a clip and is wrong. This turns it into a number by
 * running labelled queries through the real path and reporting the error distribution.
 *
 * The labels must be written by a person watching the video. Nothing here invents them:
 * a run without a label file says so and stops, because measuring a system against its own
 * output would report a perfect score and mean nothing.
 *
 * Usage:
 *   node measure-precision.mjs <runtime-url> <labels.json>
 *
 * Label file:
 *   { "asset_id": "...", "project_id": "...",
 *     "queries": [ { "text": "where the meme appears", "start_us": 182000000, "end_us": 200000000 } ] }
 *
 * Each error is the distance from a returned edge to the labelled edge, in milliseconds.
 * A query counts as hit when a returned range overlaps the labelled one at all; the error
 * is then the mean of its two edge distances, which is what a cut feels like: starting two
 * seconds late is as wrong as ending two seconds early.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [, , RUNTIME, LABELS] = process.argv
if (RUNTIME === undefined || LABELS === undefined) {
  console.error('用法: node measure-precision.mjs <runtime-url> <labels.json>')
  process.exit(2)
}

let spec
try {
  spec = JSON.parse(await readFile(LABELS, 'utf8'))
} catch (error) {
  console.error(`读不到标注文件 ${LABELS}：${error instanceof Error ? error.message : String(error)}`)
  console.error('标注必须由人看片后写。没有标注就不做度量 —— 拿系统自己的输出当答案会得到满分，那没有意义。')
  process.exit(2)
}
// 按层级筛：event（有视觉/声音边界的事件）与 topic（连续口播的主题段）测的是不同的东西，
// 混在一起报一个数会把「粒度不匹配」记成「找错了」。
const all = Array.isArray(spec.queries) ? spec.queries : []
const tier = process.env.MEASURE_TIER
const queries = tier === undefined || tier === '' ? all : all.filter(q => (q.tier ?? 'event') === tier)
if (queries.length === 0) {
  console.error('标注文件里没有 queries。至少需要几条「查询 + 正确区间」才能度量。')
  process.exit(2)
}

// 这里刻意不装 fetch 桩件。度量打的是真实素材：桩件会把 OSS 下载也拦成假响应，
// 得到的是一个 27 字节的 JSON，于是 ffmpeg 报「moov atom not found」——
// 报错离真正的原因很远。

const { VideoWorkspace } = await import(RUNTIME)
const workspace = new VideoWorkspace({
  // 用独立的临时目录，不碰运行中服务的 dataDir：SQLite 与 tmp 文件会被两个进程争用，
  // 表现是 ffmpeg 读到一个刚被对方删掉或写了一半的文件。素材与证据都在 OSS，
  // 换目录只是重新生成代理，不影响度量结果。
  // 必须用运行目录：资产记录在 SQLite 里，换目录就找不到素材。
  // 因此度量时不能有另一个进程同时用这个目录 —— 见文件头的用法说明。
  dataDir: spec.data_dir ?? 'E:\\huabei\\goclip-agentv2\\runtime\\video-tools',
  modelBaseUrl: process.env.AUTOCLIP_TEXT_BASE_URL,
  model: process.env.AUTOCLIP_TEXT_MODEL,
  apiKeyEnv: 'AUTOCLIP_TEXT_API_KEY',
  ossEndpoint: process.env.GOCLIP_OSS_ENDPOINT,
  ossBucket: process.env.GOCLIP_OSS_BUCKET,
  ossAccessKeyIdEnv: 'GOCLIP_OSS_ACCESS_KEY_ID',
  ossAccessKeySecretEnv: 'GOCLIP_OSS_ACCESS_KEY_SECRET',
  ossPrefix: 'goclip-projects', ossOutputPrefix: 'goclip-exports', ossProjectPrefix: 'goclip-projects',
  signedUrlSeconds: 900, maxImportBytes: 1 << 30, requestTimeoutMs: 120_000, modelTimeoutMs: 1_800_000,
  searchLimit: 50, keepSourceFiles: true, keyframeToleranceMs: 500, modelAttempts: 3,
  acousticSampleRate: 8000, acousticWindowMs: 1000, acousticPeakLimit: 20,
  shotSceneThreshold: 0.3, shotMinSeconds: 0.4, shotPacingWindowSeconds: 30, shotBusyLimit: 8,
  silenceMinSeconds: 0.4, silenceMarginDb: 10, minKeepSeconds: 0.3,
  maxOutputSeconds: 300, maxOutputBytes: 150 * 1024 * 1024, driftWarnFramesPerSegment: 1,
  loudnessMatch: true, loudnessTargetDbfs: -16, refineToleranceSeconds: 1.5,
  excerptMaxSeconds: 60, verifyBoundaries: spec.verify_boundaries === true, verifyPadSeconds: 3, verifyFps: 3,
})

const rows = []
for (const query of queries) {
  const labelled = { start: Number(query.start_us), end: Number(query.end_us) }
  let outcome
  try {
    const result = await workspace.find(spec.project_id, spec.asset_id, query.text, AbortSignal.timeout(1_800_000))
    const matches = Array.isArray(result.matches) ? result.matches : []
    // 与标注区间有交集的最优一条算命中：一条查询可能返回多段，取最接近的那段来量误差。
    const overlapping = matches
      .map(match => ({ start: Number(match.start_us), end: Number(match.end_us), snapped: match.snap?.snapped === true, // match.start_us 是最终值（可能经过二次核对）；核对前的值在 boundary_check 里。
          snappedStart: Number(match.boundary_check?.before_check_start_us ?? match.start_us), snappedEnd: Number(match.boundary_check?.before_check_end_us ?? match.end_us), rawStart: Number(match.original_range?.start_us ?? match.start_us), rawEnd: Number(match.original_range?.end_us ?? match.end_us) }))
      .filter(range => Math.min(range.end, labelled.end) - Math.max(range.start, labelled.start) > 0)
      .map(range => {
        const mid = (a, b) => (a + b) / 2
        return { ...range,
          error: mid(Math.abs(range.start - labelled.start), Math.abs(range.end - labelled.end)),
          rawError: mid(Math.abs(range.rawStart - labelled.start), Math.abs(range.rawEnd - labelled.end)),
          // 吸附之后、二次核对之前的误差：用来分辨每一步各贡献了多少
          snappedError: mid(Math.abs(Number(range.snappedStart) - labelled.start), Math.abs(Number(range.snappedEnd) - labelled.end)),
        }
      })
      .sort((a, b) => a.error - b.error)
    // 未命中时也要报出模型实际返回了什么：否则"没找到"和"找到但找错了地方"分不清，
    // 而这两种情况要改的东西完全不同。
    const firstAny = matches[0]
    const anyRange = firstAny === undefined ? null : { start: Number(firstAny.start_us), end: Number(firstAny.end_us) }
    outcome = overlapping.length === 0
      ? { hit: false, error: null, rawError: null, returned: matches.length, snapped: false, range: anyRange }
      : { hit: true, error: overlapping[0].error, rawError: overlapping[0].rawError, snappedError: overlapping[0].snappedError, returned: matches.length, snapped: overlapping[0].snapped, range: { start: overlapping[0].start, end: overlapping[0].end } }
  } catch (error) {
    outcome = { hit: false, error: null, returned: 0, snapped: false, failure: error instanceof Error ? error.message : String(error) }
  }
  rows.push({ text: query.text, labelled, precise: query.precise_boundaries === true, range: outcome.range ?? null, ...outcome })
  const got = outcome.range === null || outcome.range === undefined
    ? '（无返回区间）'
    : `返回 ${(outcome.range.start / 1e6).toFixed(1)}-${(outcome.range.end / 1e6).toFixed(1)}s`
  const shown = outcome.error === null ? (outcome.failure === undefined ? `未命中 ${got}` : '失败（全文见下）') : `原始 ${(outcome.rawError / 1000).toFixed(0)} → 吸附 ${(outcome.snappedError / 1000).toFixed(0)} → 最终 ${(outcome.error / 1000).toFixed(0)} ms   ${got}`
  if (outcome.failure !== undefined) console.error(`      ---- 失败全文 ----\n${outcome.failure}\n      ------------------`)
  console.log(`  ${outcome.hit ? '✅' : '❌'} ${query.text}`)
  console.log(`      标注 ${(labelled.start / 1e6).toFixed(2)}s–${(labelled.end / 1e6).toFixed(2)}s  返回 ${outcome.returned} 段  误差 ${shown}${outcome.snapped ? '（已吸附）' : ''}`)
}

// 两个问题要分开量：
//   1) 找没找到 —— 返回区间是否与标注有实质重叠（重叠不足 20% 视为没找到，避免擦边算命中）
//   2) 边界准不准 —— 只对"标注本身就是精确边界"的查询算误差。
// 混在一起会把"标注写宽了"记成工具的错：标注 162-200 是整段主题，而画面里的梗图
// 只在 182-198.5，工具返回后者反而更准。
const substantial = rows.map(row => {
  if (row.range === undefined || row.range === null) return false
  const overlap = Math.min(row.range.end, row.labelled.end) - Math.max(row.range.start, row.labelled.start)
  const labelledSpan = row.labelled.end - row.labelled.start
  return overlap > 0 && overlap / labelledSpan >= 0.2
})
const precise = rows.filter(row => row.precise === true && row.error !== null)
const errors = precise.map(row => row.error).sort((a, b) => a - b)
const median = errors.length === 0 ? null : errors[Math.floor(errors.length / 2)]
const hits = substantial.filter(Boolean).length
console.log('\n' + '='.repeat(64))
console.log(`  层级 ${tier === undefined || tier === '' ? '全部' : tier} · 查询 ${rows.length} 条 · 找到正确内容 ${hits} 条（${Math.round(hits / rows.length * 100)}%）`)
console.log(`  边界误差中位数 ${median === null ? '—（没有标成精确边界的查询）' : `${(median / 1000).toFixed(0)} ms`}（只统计标注为精确边界的 ${precise.length} 条）`)
if (errors.length > 0) {
  console.log(`  误差范围   ${(errors[0] / 1000).toFixed(0)} – ${(errors[errors.length - 1] / 1000).toFixed(0)} ms`)
}
const snapErrors = precise.map(row => row.snappedError).filter(v => typeof v === 'number').sort((a, b) => a - b)
const snapMedian = snapErrors.length === 0 ? null : snapErrors[Math.floor(snapErrors.length / 2)]
const rawErrors = precise.map(row => row.rawError).filter(v => typeof v === 'number').sort((a, b) => a - b)
const rawMedian = rawErrors.length === 0 ? null : rawErrors[Math.floor(rawErrors.length / 2)]
console.log(`  三阶段中位数：模型原始 ${rawMedian === null ? '—' : `${(rawMedian / 1000).toFixed(0)} ms`} → 吸附后 ${snapMedian === null ? '—' : `${(snapMedian / 1000).toFixed(0)} ms`} → 二次核对后 ${median === null ? '—' : `${(median / 1000).toFixed(0)} ms`}`)
console.log(`  文档目标   中位数 ≤ 1000 ms → ${median !== null && median <= 1_000_000 ? '达标' : '未达标'}`)
console.log(`  吸附生效   ${rows.filter(row => row.snapped).length} / ${rows.length} 条`)
workspace.dispose()
