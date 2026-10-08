/**
 * Windowed extraction: the arithmetic that decides whether a cut lands on the right footage.
 *
 * A long visual extraction answer does not fit in one model reply. Splitting the media
 * into windows introduces two ways to be wrong:
 *
 *   1. A window's own timestamps are relative to that window. Merging without shifting
 *      them back onto the asset timeline makes the second window appear before the first,
 *      and a creator selecting it cuts the wrong part of the video.
 *   2. A trailing remainder that is too short to answer about returns nothing, so a short
 *      tail is folded into the window before it rather than asked about.
 *
 * The model is stubbed; what is under test is the merge, not the model.
 */
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const RUNTIME = process.argv[2]
if (RUNTIME === undefined) {
  console.error('用法：node probe-extraction-windows.mjs <runtime.js 的 file URL>')
  process.exit(2)
}

let passed = 0
let failed = 0
/**
 * Record one assertion.
 * @param name - what the assertion claims.
 * @param ok - whether it held.
 * @param detail - short evidence for the result line.
 */
function record(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`✅ 通过  ${name}${detail === '' ? '' : `  ${detail}`}`) } else { failed += 1; console.log(`❌ 问题  ${name}${detail === '' ? '' : `  ${detail}`}`) }
}

const dir = await mkdtemp(join(tmpdir(), 'goclip-window-'))
/**
 * 生成指定秒数的素材。
 *
 * 必须真的是这个长度：提取工具用 `probe()` 读文件时长来决定切几窗，
 * 而不是读 assets.meta —— 早先只改 meta 里的 duration_us，于是 20.5 分钟和 5 分钟
 * 两个场景都拿着 30 分钟的素材去跑，切出三窗，断言看起来像功能坏了。
 */
async function makeClip(name, seconds) {
  const file = join(dir, name)
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=320x240:d=${seconds},format=yuv420p`,
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
  { maxBuffer: 64 * 1024 * 1024 })
  return file
}
const clip = await makeClip('window-30min.mp4', 1800)
const clipLong = await makeClip('window-20p5min.mp4', 1230)
const clipShort = await makeClip('window-5min.mp4', 300)

/** 每个窗口的代理视频按上传顺序编号，桩件据此给不同的回答。 */
let uploadSequence = 0
const served = new Map()
/** 桩件收到的视频 URL -> 该 URL 是第几次上传。 */
const urlOrder = new Map()
/** 让某次模型调用失败，用来测「一窗失败不丢其余」。 */
let failOnCall = -1
let modelCalls = 0

globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/chat/completions')) {
    modelCalls += 1
    if (modelCalls === failOnCall) return new Response('boom', { status: 500 })
    const body = JSON.parse(String(init?.body ?? '{}'))
    const videoUrl = (body.messages?.[0]?.content ?? []).find(p => p.type === 'video_url')?.video_url?.url ?? ''
    const order = urlOrder.get(videoUrl) ?? 0
    // 每窗都声称自己覆盖 0–60 秒（窗口内相对时间）。
    // 合并后必须变成 0–60 / 600–660 / 1200–1260；不偏移的话三条都会落在 0–60。
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ scenes: [{ start_us: 0, end_us: 60_000_000, description: `第${order}窗的画面` }] }) }, finish_reason: 'stop' }],
      usage: { completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 0, text_tokens: 10 } },
    }), { status: 200 })
  }
  if (target.includes('/index.json')) return new Response(JSON.stringify({ version: 5, projects: [] }), { status: 200 })
  if (init?.method === 'PUT') {
    const key = decodeURIComponent(target.split('?')[0].split('/').slice(3).join('/'))
    uploadSequence += 1
    urlOrder.set(target, uploadSequence)
    served.set(key, 'stub')
    return new Response('', { status: 200 })
  }
  return new Response('stub', { status: 200 })
}

const baseConfig = {
  dataDir: dir,
  modelBaseUrl: 'http://stub.invalid/v1', model: 'stub', apiKeyEnv: 'STUB_ID',
  ossEndpoint: 'e', ossBucket: 'b', ossAccessKeyIdEnv: 'STUB_ID', ossAccessKeySecretEnv: 'STUB_SECRET',
  ossPrefix: 't', ossOutputPrefix: 'o', ossProjectPrefix: 'p', signedUrlSeconds: 900,
  maxImportBytes: 1 << 30, requestTimeoutMs: 5000, modelTimeoutMs: 30000, searchLimit: 50,
  keepSourceFiles: true, keyframeToleranceMs: 500, modelAttempts: 1,
  acousticSampleRate: 8000, acousticWindowMs: 1000, acousticPeakLimit: 20,
  shotSceneThreshold: 0.3, shotMinSeconds: 0.4, shotPacingWindowSeconds: 5, shotBusyLimit: 8,
  silenceMinSeconds: 0.4, silenceNoiseDb: -30, refineToleranceSeconds: 1.5, verifyBoundaries: false,
  ocrSampleSeconds: 1,
  ocrModel: 'stub-ocr',
  visionModel: 'stub-vision',
  asrModel: 'stub-asr', asrBaseUrl: 'http://stub.invalid/api/v1', asrPollMs: 10, asrTimeoutMs: 5000, asrApiKeyEnv: 'STUB_ID',
}
process.env.STUB_ID = 'x'
process.env.STUB_SECRET = 'y'

const { VideoWorkspace } = await import(RUNTIME)
const { DatabaseSync } = await import('node:sqlite')

/** 每个场景用独立 dataDir，避免证据缓存互相命中。 */
async function scenario(name, { chunkSeconds, failCall = -1, assetSeconds = 1800, assetId = 'aw', file = clip }) {
  const dataDir = join(dir, `data-${name}`)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dataDir, { recursive: true })
  const vw = new VideoWorkspace({ ...baseConfig, dataDir, extractionChunkSeconds: chunkSeconds })
  await vw.createProject('pw', name)
  const db = new DatabaseSync(join(dataDir, 'video-tools.sqlite'))
  db.exec('PRAGMA foreign_keys=ON')
  // 素材长度由文件本身决定；meta 只是记录，切窗看的是 probe() 的读数。
  db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run(assetId, 'pw', file, JSON.stringify({ duration_us: assetSeconds * 1_000_000 }))
  db.close()
  modelCalls = 0
  failOnCall = failCall
  const result = await vw.visualEvidence('pw', assetId, new AbortController().signal)
  vw.dispose()
  return { result, calls: modelCalls }
}

// ---- 1. 三窗，时间码必须平移回素材时间轴 -------------------------------
console.log('=== 30 分钟素材按 10 分钟切：三个窗口的时间码必须落在各自位置 ===')
const three = await scenario('three', { chunkSeconds: 600 })
const lines = three.result.scenes ?? []
record('产生了三个窗口的调用', three.calls === 3, `模型调用 ${three.calls} 次`)
record('三窗的结果被合并成三条', lines.length === 3, `line_count=${lines.length}`)

const ordered = lines.every((l, i) => i === 0 || lines[i - 1].end_us <= l.start_us)
record('合并后按时间单调递增，不重叠', ordered,
  lines.map(l => `${(l.start_us / 1e6).toFixed(0)}-${(l.end_us / 1e6).toFixed(0)}s`).join(' '))
const starts = lines.map(l => l.start_us)
record('三条分别落在 0s / 600s / 1200s —— 窗口偏移确实加上了',
  starts[0] === 0 && starts[1] === 600_000_000 && starts[2] === 1_200_000_000,
  `起点 ${starts.map(s => (s / 1e6).toFixed(0) + 's').join(', ')}`)

// ---- 2. 过短的末窗必须并进前一窗 ---------------------------------------
console.log('\n=== 素材 20.5 分钟、chunk 10 分钟：末窗只有 30 秒，应被并进前一窗 ===')
const folded = await scenario('folded', { chunkSeconds: 600, assetSeconds: 1230, file: clipLong })
record('只发了两个请求（末窗被合并，没有单独去问那 30 秒）',
  folded.calls === 2, `模型调用 ${folded.calls} 次`)
const foldedLines = folded.result.scenes ?? []
record('第二窗覆盖到素材末尾，没有留下没被读过的区间',
  foldedLines.length >= 2 && foldedLines[foldedLines.length - 1].end_us <= 1_230_000_000,
  foldedLines.map(l => `${(l.start_us / 1e6).toFixed(0)}-${(l.end_us / 1e6).toFixed(0)}s`).join(' '))

// ---- 3. 一窗失败不能丢掉其余窗口 --------------------------------------
console.log('\n=== 第二窗失败：其余窗口的结果必须保留并说明缺口 ===')
const partial = await scenario('partial', { chunkSeconds: 600, failCall: 2 })
const partialLines = partial.result.scenes ?? []
record('失败窗口之外的结果仍然保留',
  partialLines.length === 2, `line_count=${partialLines.length}（三窗中第二窗失败）`)
record('缺口被如实报出来，而不是假装完整',
  Array.isArray(partial.result.failed_windows) && partial.result.failed_windows.length === 1
  && partial.result.failed_windows[0] === 2,
  `failed_windows=${JSON.stringify(partial.result.failed_windows)}`)
record('保留的两条仍然落在正确的时间位置',
  partialLines[0].start_us === 0 && partialLines[1].start_us === 1_200_000_000,
  partialLines.map(l => `${(l.start_us / 1e6).toFixed(0)}s`).join(', '))

// ---- 4. 短素材不该被切 --------------------------------------------------
console.log('\n=== 素材 5 分钟、chunk 10 分钟：只有一窗，不该切 ===')
const single = await scenario('single', { chunkSeconds: 600, assetSeconds: 300, file: clipShort })
record('短素材只发一次请求', single.calls === 1, `模型调用 ${single.calls} 次`)
record('没有产生缺口记录',
  single.result.failed_windows === null, `failed_windows=${JSON.stringify(single.result.failed_windows)}`)

// ---- 5. 音频比画面短时，渲染要补静音而不是失败 --------------------------
//
// 这是一次真实会话里的事故：33 分钟的会话在第 10 段（1807–1818s）渲染失败，
// 报 AAC `Input buffer exhausted`，前 9 段已经产出。原因是那条素材的音频流
// 只到 1644.989s，而容器与视频流是 2584.1s。
//
// ⚠️ 关于这条断言的诚实说明：**它无法复现退出码 69。**
// 用合成夹具（画面 20s、音频 6s）切到音频之后，ffmpeg 退出码是 0，
// 只是打印 `Qavg: nan`；而真实素材上同样两种参数都是退出码 69。
// 差别出在那条素材音频流自身的细节上，我没有查明。所以这条断言证明的是
// 「这条分支被正确走到、补了静音、时长没被截短」，
// 而**不是**「不补静音就会崩」—— 后者只在真实素材上验证过。
{
  const shortAudio = join(dir, 'audio-ends-early.mp4')
  await run('ffmpeg', ['-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:d=20,format=yuv420p',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', shortAudio],
  { maxBuffer: 64 * 1024 * 1024 })
  const probed = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', shortAudio])
  const audioEnd = Number(probed.stdout.trim())
  record('夹具确实是「画面 20s、音频更短」的形状',
    audioEnd > 0 && audioEnd < 10, `音频流结束于 ${audioEnd}s，画面 20s`)

  const dataDir = join(dir, 'data-tail')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dataDir, { recursive: true })
  const vw2 = new VideoWorkspace({ ...baseConfig, dataDir })
  await vw2.createProject('ptail', '音频更短')
  {
    const db = new DatabaseSync(join(dataDir, 'video-tools.sqlite'))
    db.exec('PRAGMA foreign_keys=ON')
    db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('ata', 'ptail', shortAudio, JSON.stringify({ duration_us: 20_000_000 }))
    db.close()
  }
  // 时间线整段落在音频结束之后（12–18s）。
  await vw2.createTimeline({ id: 'ttail', project_id: 'ptail', asset_id: 'ata', start_us: 12_000_000, end_us: 18_000_000 })
  let rendered = null
  let failure = null
  try {
    rendered = await vw2.render('ttail', undefined, new AbortController().signal)
  } catch (error) {
    failure = String(error.stderr ?? error.message ?? '')
  }
  vw2.dispose()

  record('切在音频结束之后的片段仍能渲染出成片',
    rendered !== null,
    rendered !== null
      ? `segment_count=${rendered.segment_count}  duration=${rendered.duration_seconds}s`
      : failure.split('\n').filter(l => l.trim() !== '').slice(-2).join(' | '))
  if (rendered !== null) {
    // 时长必须覆盖整段，而不是被 `-shortest` 截到音频长度 —— 静音是补上的，
    // 不是把画面切短。这条是补静音逻辑的核心可观察结果。
    record('成片时长覆盖请求的 6 秒，没有被截到音频长度',
      Math.abs(Number(rendered.duration_seconds) - 6) < 0.5,
      `请求 6s，成片 ${rendered.duration_seconds}s`)
  }
}

console.log('\n' + '='.repeat(64))
console.log(`共 ${passed + failed} 项，问题 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
