/**
 * Unified retrieval: several conditions applied to the same candidate.
 *
 * The asset is built so each condition has a known answer: every second of audio has a
 * set level, every second of video is its own shot, and the analysis names two passages.
 * A filter is then a statement about which passages must come back — and `evidence_refs`
 * is checked to prove the answer says why it was chosen.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const RUNTIME = process.argv[2]
const run = promisify(execFile)

/**
 * Build a clip with one colour per second and a known loudness shape.
 *
 * Seconds 0-2 are silent, 2-4 are loud and 4-10 are quiet, so a loudness filter has an
 * unambiguous right answer.
 *
 * @param dir - directory to write the clip into.
 * @returns Path of the generated clip.
 */
async function buildClip(dir) {
  const colours = ['black', 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray', 'white', 'cyan']
  const args = ['-nostdin', '-v', 'error', '-y']
  for (const colour of colours) args.push('-f', 'lavfi', '-i', `color=c=${colour}:s=320x240:d=1,format=yuv420p`)
  args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2')
  args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2')
  args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=6,volume=0.03')
  const video = colours.map((_, index) => `[${index}:v]`).join('') + `concat=n=${colours.length}:v=1:a=0[v]`
  const audio = `[${colours.length}:a][${colours.length + 1}:a][${colours.length + 2}:a]concat=n=3:v=0:a=1[a]`
  const clip = join(dir, 'find-source.mp4')
  args.push('-filter_complex', `${video};${audio}`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip)
  await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })
  return clip
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/chat/completions')) return realFetch(url, init)
  if (init?.method === 'PUT') return new Response('', { status: 200 })
  return new Response(JSON.stringify({ version: 4, projects: [] }), { status: 200 })
}

const dir = await mkdtemp(join(tmpdir(), 'goclip-find-'))
const clip = await buildClip(dir)
const config = {
  dataDir: dir,
  modelBaseUrl: 'http://stub.invalid/v1', model: 'stub', apiKeyEnv: 'STUB_ID',
  ossEndpoint: 'e', ossBucket: 'b', ossAccessKeyIdEnv: 'STUB_ID', ossAccessKeySecretEnv: 'STUB_SECRET',
  ossPrefix: 't', ossOutputPrefix: 'o', ossProjectPrefix: 'p', signedUrlSeconds: 900,
  maxImportBytes: 1 << 30, requestTimeoutMs: 5000, modelTimeoutMs: 20000, searchLimit: 50,
  keepSourceFiles: true, keyframeToleranceMs: 500, modelAttempts: 1,
  acousticSampleRate: 8000, acousticWindowMs: 1000, acousticPeakLimit: 20,
  shotSceneThreshold: 0.3, shotMinSeconds: 0.4, shotPacingWindowSeconds: 5, shotBusyLimit: 8,
  silenceMinSeconds: 0.4, silenceMarginDb: 10, minKeepSeconds: 0.3,
  maxOutputSeconds: 300, maxOutputBytes: 150 * 1024 * 1024, driftWarnFramesPerSegment: 1,
}
process.env.STUB_ID = 'x'
process.env.STUB_SECRET = 'y'

const { VideoWorkspace } = await import(RUNTIME)
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅ 通过' : '❌ 问题'}  ${name}`)
  console.log(`        ${detail}`)
}

const vw = new VideoWorkspace(config)
await vw.createProject('pf', '检索测试')
const { DatabaseSync } = await import('node:sqlite')
const raw = new DatabaseSync(join(dir, 'video-tools.sqlite'))
raw.exec('PRAGMA foreign_keys=ON')
raw.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('af', 'pf', clip, JSON.stringify({ duration_us: 10_000_000 }))
// 两段分析文本，供关键词条件使用；区间刻意与响度区间不完全重合
raw.prepare('INSERT INTO analyses (asset_id,instruction,data,created_at) VALUES (?,?,?,?)').run('af', '按内容分段', JSON.stringify({
  summary: '测试素材',
  segments: [
    { start_us: 0, end_us: 2_000_000, visual: '开场安静画面', audio: '', tags: [], is_highlight: false, confidence: 0.5 },
    { start_us: 2_000_000, end_us: 4_000_000, visual: '鼓点炸裂的高潮段落', audio: '音乐扬起', tags: ['高潮'], is_highlight: true, highlight_reason: '响度峰值', confidence: 0.9 },
    { start_us: 4_000_000, end_us: 10_000_000, visual: '博主平静讲解公式', audio: '', tags: ['讲解'], is_highlight: false, confidence: 0.7 },
  ],
}), Date.now())
raw.close()

// 一条逐字转写，供多锚点检索使用。
// 形状与真实识别结果一致：句子级区间、逐字文本。
{
  const rawT = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  rawT.exec('PRAGMA foreign_keys=ON')
  rawT.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('at', 'pf', clip, JSON.stringify({ duration_us: 10_000_000 }))
  rawT.prepare('INSERT INTO evidence (asset_id,kind,duration_us,payload,provider,provider_version,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('at', 'transcript', 10_000_000, JSON.stringify({
      lines: [
        { start_us: 1_000_000, end_us: 2_500_000, text: '第一句原话讲的是开场介绍。' },
        { start_us: 3_000_000, end_us: 4_500_000, text: '第二句原话提到了飞虹塔的琉璃。' },
        { start_us: 6_000_000, end_us: 7_500_000, text: '第三句原话在讲赵城金藏的下落。' },
      ],
      line_count: 3, duration_us: 10_000_000, note: null,
    }), 'asr', 'omni-v2-windowed', Date.now())
  rawT.close()
}

// 先把三条证据算出来，检索才有条件可用
await vw.acousticEvidence('pf', 'af', new AbortController().signal)
await vw.shotEvidence('pf', 'af', new AbortController().signal)
await vw.timingEvidence('pf', 'af', new AbortController().signal)

// ── 无条件：返回全部候选 ────────────────────────────────────────────────────
{
  const all = await vw.findSpans('pf', 'af', {})
  record('不带条件时返回全部候选', all.match_count === 3 && all.returned === 3,
    `match_count=${all.match_count}，区间=${JSON.stringify(all.matches.map(m => [m.start_us / 1e6, m.end_us / 1e6]))}`)
  record('报告哪些证据可用', all.evidence_available['acoustic-loudness'] === true && all.evidence_available['shot-boundaries'] === true && all.evidence_available['silence-timing'] === true,
    JSON.stringify(all.evidence_available))
  record('每条都带 evidence_refs', all.matches.every(m => Array.isArray(m.evidence_refs) && m.evidence_refs.length > 0),
    `第一条的引用来源=${JSON.stringify(all.matches[0].evidence_refs.map(r => r.source))}`)
}

// ── 按响度筛：只有第 2–4 秒是大声 ───────────────────────────────────────────
{
  const loud = await vw.findSpans('pf', 'af', { min_dbfs: -25 })
  const spans = loud.matches.map(m => [m.start_us / 1e6, m.end_us / 1e6])
  record('按响度筛选只留下大声那段', loud.match_count === 1 && loud.matches[0].start_us === 2_000_000,
    `命中 ${JSON.stringify(spans)}，峰值=${loud.matches[0]?.peak_dbfs} dBFS`)
  record('响度条件带出可核验的引用', loud.matches[0].evidence_refs.some(r => r.source === 'acoustic-loudness' && typeof r.peak_dbfs === 'number'),
    JSON.stringify(loud.matches[0].evidence_refs.find(r => r.source === 'acoustic-loudness')))
}

// ── 按时长筛 ────────────────────────────────────────────────────────────────
{
  const short = await vw.findSpans('pf', 'af', { max_seconds: 3 })
  record('按时长上限筛掉长段', short.match_count === 2 && short.matches.every(m => m.seconds <= 3),
    `命中 ${short.match_count} 段，时长=${JSON.stringify(short.matches.map(m => m.seconds))}`)
  const long = await vw.findSpans('pf', 'af', { min_seconds: 5 })
  record('按时长下限只留长段', long.match_count === 1 && long.matches[0].seconds === 6,
    `命中 ${long.match_count} 段，时长=${JSON.stringify(long.matches.map(m => m.seconds))}`)
}

// ── 按镜头切点筛：画面每秒换色，6 秒那段应有 5 个切点 ────────────────────────
{
  const busy = await vw.findSpans('pf', 'af', { min_cuts: 4 })
  record('按切点密度筛选', busy.match_count === 1 && busy.matches[0].start_us === 4_000_000,
    `命中 ${JSON.stringify(busy.matches.map(m => [m.start_us / 1e6, m.cuts]))}`)
  record('切点条件带出镜头证据引用', busy.matches[0].evidence_refs.some(r => r.source === 'shot-boundaries' && r.cuts >= 4),
    JSON.stringify(busy.matches[0].evidence_refs.find(r => r.source === 'shot-boundaries')))
}

// ── 关键词与组合条件 ────────────────────────────────────────────────────────
{
  const byWord = await vw.findSpans('pf', 'af', { text: '高潮' })
  record('关键词筛选命中对应段', byWord.match_count === 1 && byWord.matches[0].is_highlight === true,
    `命中 ${byWord.match_count} 段，from_instruction=${byWord.matches[0]?.from_instruction}`)
  const none = await vw.findSpans('pf', 'af', { text: '不存在的词' })
  record('关键词无命中时不返回结果', none.match_count === 0 && none.matches.length === 0,
    `match_count=${none.match_count}，note=${none.note?.slice(0, 30)}`)
  // 组合：既要响、又要文字命中 —— 两个条件必须作用在同一个候选上
  const both = await vw.findSpans('pf', 'af', { text: '高潮', min_dbfs: -25 })
  record('多个条件作用在同一候选上', both.match_count === 1 && both.matches[0].start_us === 2_000_000,
    `命中 ${both.match_count} 段，区间=${JSON.stringify(both.matches.map(m => [m.start_us / 1e6, m.end_us / 1e6]))}`)
  const contradiction = await vw.findSpans('pf', 'af', { text: '讲解', min_dbfs: -25 })
  record('条件互相矛盾时返回空并说明', contradiction.match_count === 0,
    `「讲解」段是轻声，加上响度下限后命中 ${contradiction.match_count} 段`)
}

// ── 高光标记与结果上限 ──────────────────────────────────────────────────────
{
  const hl = await vw.findSpans('pf', 'af', { highlight_only: true })
  record('只要高光段', hl.match_count === 1 && hl.matches[0].is_highlight === true,
    `命中 ${hl.match_count} 段`)
  const capped = await vw.findSpans('pf', 'af', { limit: 1 })
  record('结果上限生效并标记截断', capped.returned === 1 && capped.truncated === true && capped.match_count === 3,
    `returned=${capped.returned}，match_count=${capped.match_count}，truncated=${capped.truncated}`)
}

// ── 缺证据时要如实说缺什么 ─────────────────────────────────────────────────
{
  const bare = await vw.findSpans('pf', 'af', { min_dbfs: -25 })
  record('有条件可用时 evidence_missing 为空', bare.evidence_missing.length === 0, JSON.stringify(bare.evidence_missing))
}

// ── 重叠要标注出来，否则同一内容会被当成多个候选 ────────────────────────────
{
  const all = await vw.findSpans('pf', 'af', {})
  const first = all.matches[0]
  record('第一条没有重叠标注（它就是最强的）', first.overlaps_stronger_matches === 0 && first.overlap_note === null,
    `overlaps=${first.overlaps_stronger_matches}`)
  // 第二段分析刻意与第一段区间重合，用来验证标注而非丢弃
  const { DatabaseSync: DS } = await import('node:sqlite')
  const raw2 = new DS(join(dir, 'video-tools.sqlite'))
  raw2.exec('PRAGMA foreign_keys=ON')
  raw2.prepare('INSERT INTO analyses (asset_id,instruction,data,created_at) VALUES (?,?,?,?)').run('af', '第二份分析', JSON.stringify({
    segments: [{ start_us: 2_000_000, end_us: 4_000_000, visual: '同一段高潮的另一种切法', audio: '', tags: [], is_highlight: true, confidence: 0.95 }],
  }), Date.now())
  raw2.close()
  const again = await vw.findSpans('pf', 'af', {})
  const overlapping = again.matches.filter(m => m.overlaps_stronger_matches > 0)
  record('重叠的候选被标注而不是被丢掉',
    overlapping.length >= 1 && overlapping.every(m => typeof m.overlap_note === 'string' && m.overlap_seconds > 0),
    `重叠条目 ${overlapping.length} 条，示例=${JSON.stringify(overlapping[0]?.overlap_note ?? null)}`)
  record('两份分析的不同切法都还在（不替用户选）',
    again.matches.some(m => m.from_instruction === '第二份分析') && again.matches.some(m => m.from_instruction === '按内容分段'),
    `来源=${JSON.stringify([...new Set(again.matches.map(m => m.from_instruction))])}`)
}

// ---- 多锚点：一次问多句原话 ----------------------------------------------
//
// 这是那场真实事故的直接对策。当时模型一次要定位两三句原话，而本地检索只收
// 一个查询词，于是它转去让多模态模型重看整条 43 分钟视频（21 次，838 秒）。
{
  const one = await vw.findSpans('pf', 'at', { text: '飞虹塔的琉璃' })
  record('单句原话能直接命中并给出区间',
    one.match_count === 1 && one.matches[0].start_us === 3_000_000 && one.matches[0].end_us === 4_500_000,
    `命中 ${one.match_count} 段 @${(one.matches[0]?.start_us ?? 0) / 1e6}s`)

  const many = await vw.findSpans('pf', 'at', { texts: ['开场介绍', '赵城金藏的下落'] })
  const starts = many.matches.map(m => m.start_us / 1e6).sort((a, b) => a - b)
  record('一次问两句原话能同时返回两段',
    starts.length === 2 && starts[0] === 1 && starts[1] === 6,
    `返回 ${starts.length} 段 @${starts.join('s, ')}s`)

  record('每条结果标明命中的是哪一句，而不是让调用方猜',
    many.matches.every(m => typeof m.matched_text === 'string' && m.matched_text !== '')
    && new Set(many.matches.map(m => m.matched_text)).size === 2,
    `matched_text=${JSON.stringify(many.matches.map(m => m.matched_text))}`)

  // 多锚点里只要有一句不存在，存在的那句仍要返回 —— 整批失败会让调用方
  // 以为「什么都没找到」，那正是升级到重看整片视频的触发条件。
  const partial = await vw.findSpans('pf', 'at', { texts: ['飞虹塔的琉璃', '这句话素材里没有'] })
  record('其中一个锚点找不到时，其余锚点的结果仍然返回',
    partial.match_count === 1 && partial.matches[0].start_us === 3_000_000,
    `命中 ${partial.match_count} 段`)
}

vw.dispose()
console.log('\n' + '='.repeat(64))
const bad = results.filter(r => !r.ok)
console.log(`共 ${results.length} 项，问题 ${bad.length} 项`)
for (const b of bad) console.log(`  · ${b.name}：${b.detail}`)
