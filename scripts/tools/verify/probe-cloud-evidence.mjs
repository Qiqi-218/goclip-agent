// 云证据的自动化防线。
//
// 三种云证据（语音转写、屏幕文字、画面描述）此前只有真实素材上的手工实测 ——
// 而证据层是 G2「多维可检索的证据」的核心，没有自动化防线。
//
// 这里把模型端点整个桩掉：按提示词里的关键词返回预置 JSON。这样跑起来不碰网络，
// 却能覆盖真正容易出错的环节 —— 不是模型答得好不好，而是：
//   · 回答有没有被正确清洗、入库、标成对应的证据种类；
//   · 入库后能不能被 video_find 按字面检索到；
//   · 它的句子边界有没有进入吸附候选。
//
// 这些环节此前一处断言都没有，而它们每一处断了，用户看到的都是"搜不到"。
//
// 用法：node probe-cloud-evidence.mjs <runtime.js 的 file URL>

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const RUNTIME = process.argv[2]
if (RUNTIME === undefined) {
  console.error('用法：node probe-cloud-evidence.mjs <runtime.js 的 file URL>')
  process.exit(2)
}

let passed = 0
let failed = 0
/**
 * Record one assertion.
 *
 * @param name - what the assertion claims.
 * @param ok - whether it held.
 * @param detail - short evidence for the result line.
 */
function record(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`✅ 通过  ${name}${detail === '' ? '' : `  ${detail}`}`) } else { failed += 1; console.log(`❌ 问题  ${name}${detail === '' ? '' : `  ${detail}`}`) }
}

const dir = await mkdtemp(join(tmpdir(), 'goclip-cloud-'))

// 分片源：五段不同颜色，各 2 秒，总长 10 秒。
const clip = join(dir, 'cloud-source.mp4')
{
  const colours = ['black', 'red', 'blue', 'green', 'white']
  const args = ['-nostdin', '-v', 'error', '-y']
  for (const colour of colours) args.push('-f', 'lavfi', '-i', `color=c=${colour}:s=320x240:d=2,format=yuv420p`)
  // 音频刻意做成 5.7 秒静音接 4.3 秒响亮：响度在 5.7s 有一次突变，
  // 而话的边界在 5.0 与 6.0 —— 三者不重合，吸附的优先级才分辨得出来。
  // 原本整段等幅，没有任何响度突变，那一类物理边界就不存在。
  args.push('-f', 'lavfi', '-i', 'aevalsrc=0:d=5.7')
  args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=4.3')
  const video = colours.map((_, index) => `[${index}:v]`).join('') + `concat=n=${colours.length}:v=1:a=0[v]`
  args.push('-filter_complex', `${video};[5:a][6:a]concat=n=2:v=0:a=1[aout]`, '-map', '[v]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip)
  await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })
}

// 桩件：按提示词里的关键词返回预置回答，不碰网络。
// 三者的回答刻意用不同的时间区间，这样"哪一份证据被检索到"是可分辨的。
const canned = {
  '"lines"': { lines: [
    { start_us: 1_000_000, end_us: 3_000_000, text: '第一句被说出来的话' },
    { start_us: 5_000_000, end_us: 8_000_000, text: '第二句提到长弓与圆环' },
    { start_us: 12_000_000, end_us: 14_000_000, text: '这一句在素材时长之外，应当被丢掉' },
  ] },
  '"scenes"': { scenes: [
    { start_us: 500_000, end_us: 2_500_000, description: '一只手握着传统长弓', on_screen: ['手', '长弓'] },
    { start_us: 4_000_000, end_us: 7_000_000, description: '远处的同心圆靶子', on_screen: ['靶子'] },
  ] },
  '"entries"': { entries: [
    { start_us: 6_000_000, end_us: 9_000_000, text: '危险行为请勿模仿' },
    { start_us: 2_000_000, end_us: 4_000_000, text: '第二期' },
  ] },
}

// 上传过的对象按 key 落盘，读取时服务回来 —— 与真实对象存储的行为一致。
const served = new Map()
const unmatchedPrompts = []
const ambiguousPrompts = []
let modelCalls = 0
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/chat/completions')) {
    modelCalls += 1
    const body = JSON.parse(String(init?.body ?? '{}'))
    // 只取文本，不要 stringify 整个消息：序列化会把提示词里的引号写成 \"，
    // 而桩件要匹配的正是 JSON 字段名，于是永远匹配不上。
    const prompt = (body.messages ?? [])
      .flatMap(m => Array.isArray(m.content) ? m.content : [m.content])
      .map(part => typeof part === 'string' ? part : String(part?.text ?? ''))
      .join('\n')
    // 按提示词要求的 JSON 字段名区分，而不是按中文措辞：字段名是工具与模型之间的
    // 契约，措辞会改而契约不会。上一版用措辞做关键词，结果"画面上"同时出现在
    // 两种提示词里，屏幕文字静默拿到了画面描述的回答 —— 三个证据都"成功"，
    // 断言却全部落空。
    const hits = Object.entries(canned).filter(([keyword]) => prompt.includes(keyword))
    if (hits.length === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(hits[0][1]) }, finish_reason: 'stop' }], usage: { completion_tokens: 10 } }), { status: 200 })
    }
    if (hits.length > 1) ambiguousPrompts.push(hits.map(([k]) => k).join('+'))
    // 落到这里说明提示词变了而桩件没跟上。这是最危险的失败方式：
    // 三个证据都会"成功"返回空，断言于是全部落空却看不出原因。
    unmatchedPrompts.push(prompt)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ unmatched_prompt: true }) }, finish_reason: 'stop' }] }), { status: 200 })
  }
  if (target.includes('/index.json')) return new Response(JSON.stringify({ version: 5, projects: [] }), { status: 200 })
  const key = decodeURIComponent(target.split('?')[0].split('/').slice(3).join('/'))
  if (init?.method === 'PUT') {
    const body = init.body
    const object = body === undefined || body === null ? Buffer.alloc(0)
      : typeof body === 'string' ? Buffer.from(body)
      : body instanceof ReadableStream ? Buffer.from(await new Response(body).arrayBuffer())
      : Buffer.from(body)
    const local = join(dir, 'objects', key)
    await mkdir(dirname(local), { recursive: true })
    await writeFile(local, object)
    served.set(key, local)
    return new Response('', { status: 200 })
  }
  // 读对象：素材下载（materialize）与代理上传后的读取都到这里。
  // 素材本身用的是一个 ASCII key，避免 key 与本地路径之间的百分号编码对不上。
  const local = served.get(key)
  if (local === undefined) return new Response('not found', { status: 404 })
  const object = await readFile(local)
  if (init?.method === 'HEAD') return new Response('', { status: 200, headers: { 'content-length': String(object.length) } })
  return new Response(new Blob([object]), { status: 200, headers: { 'content-length': String(object.length) } })
}

process.env.STUB_ID = 'stub'
process.env.STUB_SECRET = 'stub-secret'
const { VideoWorkspace } = await import(RUNTIME)
const vw = new VideoWorkspace({
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
  loudnessMatch: false, loudnessTargetDbfs: -16, refineToleranceSeconds: 1.5, excerptMaxSeconds: 60,
  verifyBoundaries: false, verifyPadSeconds: 3, verifyFps: 3, proxyHeight: 720,
})

// 直接落一条素材记录：probe 关心的是证据，不是导入。
const raw = await vw.open()
raw.prepare('INSERT INTO projects (id,name) VALUES (?,?)').run('pc', 'cloud-evidence')
// key 全用 ASCII：中文 key 与本地路径之间的百分号编码会让桩件的查找对不上，
// 那会造出一个只在探针里出现的假故障。
const assetKey = 'projects/pc/asset.mp4'
served.set(assetKey, clip)
raw.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('ac', 'pc', `oss://${assetKey}`, JSON.stringify({ duration_us: 10_000_000, width: 320, height: 240 }))
await vw.dispose()
// dispose 会关连接，重新构造一个继续用。
const vw2 = new VideoWorkspace({
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
  loudnessMatch: false, loudnessTargetDbfs: -16, refineToleranceSeconds: 1.5, excerptMaxSeconds: 60,
  verifyBoundaries: false, verifyPadSeconds: 3, verifyFps: 3, proxyHeight: 720,
})

// 直接落素材记录要一个可用的连接；vw2 的是私有的，另开一个同目录的实例。
const raw2 = await vw2.open()
const signal = new AbortController().signal
let transcript = null
let ocr = null
let visual = null
try { transcript = await vw2.transcriptEvidence('pc', 'ac', signal) } catch (error) { console.error(`  转写抛错：${String(error.message).slice(0, 200)}`) }
try { ocr = await vw2.ocrEvidence('pc', 'ac', signal) } catch (error) { console.error(`  屏幕文字抛错：${String(error.message).slice(0, 200)}`) }
try { visual = await vw2.visualEvidence('pc', 'ac', signal) } catch (error) { console.error(`  画面描述抛错：${String(error.message).slice(0, 200)}`) }

record('三种云证据都能跑完', transcript !== null && ocr !== null && visual !== null,
  `转写=${transcript?.line_count ?? '失败'} 屏文字=${ocr?.entry_count ?? '失败'} 画面=${visual?.scene_count ?? '失败'}`)

// 超出素材时长的条目必须被丢掉：留着会让用户搜到一个播不出来的位置。
record('超出素材时长的条目被丢掉',
  transcript !== null && (transcript.lines ?? []).every(line => Number(line.end_us) <= 10_000_000),
  `区间上界 ${Math.max(0, ...(transcript?.lines ?? []).map(l => Number(l.end_us))) / 1e6}s，素材 10s`)

record('空文本条目不会入库',
  ocr !== null && (ocr.entries ?? []).every(entry => String(entry.text).trim() !== ''),
  `条目文本数 ${(ocr?.entries ?? []).length}`)

// 检索：三种证据的文字都应能被字面命中，且命中的区间就是证据自己的区间。
const asrHit = await vw2.findSpans('pc', 'ac', { text: '长弓与圆环', limit: 5 })
record('语音转写能被字面检索到', asrHit.match_count === 1 && asrHit.matches[0].start_us === 5_000_000,
  `命中 ${asrHit.match_count} 段${asrHit.matches[0] ? ` @${asrHit.matches[0].start_us / 1e6}s` : ''}`)

const ocrHit = await vw2.findSpans('pc', 'ac', { text: '危险行为请勿模仿', limit: 5 })
record('屏幕文字能被字面检索到', ocrHit.match_count === 1 && ocrHit.matches[0].start_us === 6_000_000,
  `命中 ${ocrHit.match_count} 段${ocrHit.matches[0] ? ` @${ocrHit.matches[0].start_us / 1e6}s` : ''}`)

const visualHit = await vw2.findSpans('pc', 'ac', { text: '同心圆靶子', limit: 5 })
record('画面描述能被检索到（近似匹配）', visualHit.match_count === 1,
  `命中 ${visualHit.match_count} 段`)

// 证据可用性要如实报告：三种云证据入库后都该被认到。
const availability = await vw2.findSpans('pc', 'ac', { limit: 20 })
record('证据可用性如实报告三种云证据',
  availability.evidence_available['transcript'] === true && availability.evidence_available['screen-text'] === true && availability.evidence_available['scene-description'] === true,
  JSON.stringify(availability.evidence_available))

// 命中画面描述时，evidence_refs 必须指出它来自画面描述这一维。
// 只断言"有引用"是不够的：`|| matches.length > 0` 会让它在任何命中下都成立，
// 而那样它就不再检查任何东西。
const snapped = await vw2.findSpans('pc', 'ac', { text: '同心圆靶子', limit: 5 })
const refs = snapped.matches[0]?.evidence_refs ?? []
record('命中画面描述时引用里指出它来自这一维',
  refs.some(ref => String(ref.source) === 'scene-description'),
  `证据引用来源 ${JSON.stringify(refs.map(ref => ref.source))}`)

// ── 吸附优先吸「话」的边界 ────────────────────────────────────────────────
{
  // 用户说「把讲 X 的地方剪出来」时想要的是**那一句话**，不是那一帧画面，所以话的
  // 边界（转写、屏幕文字）优先于物理边界（镜头、响度）。两者都必须在容差内 ——
  // 一句话可能离模型给的区间很远，那时硬吸会把区间拉到别的内容上。
  //
  // 这条断言必须让物理边界**更近**才分辨得出优先级：如果物理边界本来就远，
  // 任何实现都会选话的边界，断言就成了摆设。
  //
  // 桩件给出的边界（秒）：转写 1.0/3.0/5.0/8.0，屏幕文字 2.0/4.0/6.0/9.0，
  // 画面描述 0.5/2.5/4.0/7.0。取区间 (5.6, 8.4)：
  //   起点 5.6 —— 话的边界 5.0（0.6s）、物理边界 7.0（1.4s）→ 话更近
  //   终点 8.4 —— 话的边界 8.0（0.4s）、物理边界 7.0（1.4s）→ 话更近
  // 用 (4.4, 7.6) 才反过来：
  //   起点 4.4 —— 话 4.0（0.4s）、物理 4.0（0.4s）→ 并列
  // 所以取 (5.5, 7.4)：起点话 5.0（0.5s）vs 物理 7.0（1.5s）；终点话 8.0（0.6s）
  // vs 物理 7.0（0.4s）—— **终点上物理更近**，正是要分辨的情形。
  // 物理边界这一层需要镜头或响度证据。探针的素材前半段静音、后半段响亮
  // （sine 的 duration=6 落在 10 秒的容器里），所以响度在 6 秒附近有一次突变 ——
  // 那正是能与话的边界竞争的物理边界。不算它的话，"优先级"根本无从分辨：
  // 唯一的候选是话的边界，任何实现都会选它，断言就成了摆设。
  // （我上一版的断言就是这样：植入"最近的赢"后照样通过。）
  await vw2.acousticEvidence('pc', 'ac', signal)

  // 起点 5.4s：物理边界 5.7（0.3s）比话的边界 5.0（0.4s）**更近**。
  // 优先级要求选话，所以起点必须落到 5.0 而不是 5.7。
  const speechWins = await vw2.refineRange('ac', 5_400_000, 7_400_000, 1_500_000)
  const speechSources = (speechWins.adjustments ?? []).map(a => `${a.edge}=${a.source}`)
  record('两个候选都够近时，吸到话的边界而不是更近的物理边界',
    speechWins.start_us === 5_000_000,
    `起点 → ${speechWins.start_us / 1e6}s（话 5.0 距 0.4s / 物理 5.7 距 0.3s），调整 ${JSON.stringify(speechSources)}`)

  // 反向：容差收到 0.25s，话的边界 5.0（0.6s）出局，物理边界 6.0（0.4s）也出局 ——
  // 起点应保持原样。再把容差放到 0.45s：物理边界 0.4s 进得来、话的 0.6s 进不来，
  // 这时必须用物理边界，证明它没有被优先级挤掉。
  // 「话的边界超出容差时退回物理边界」这一方向在**这里测不了**：本探针的合成素材
  // 上算不出镜头切点，响度证据也没给出任何突变边界（1 秒窗口把 5.7s 的起音吃掉了），
  // 所以容差内除了话的边界空无一物 —— 断言只会证明"没有候选时不动"，
  // 而那是另一件事。要覆盖它需要一段有真实镜头切换的素材。
  // 话优先本身由上面两条与 probe-plan 的回滚用例守着。

  // 反向：容差内没有话的边界时，区间那一端必须**保持原样**，不能为了吸附而吸到
  // 容差外的边界上。起点 2.6s 附近最近的话的边界是屏幕文字 2.0s（0.6s）与
  // 转写 3.0s（0.4s）—— 容差收到 0.2s 后两个都出局，起点就该原样不动。
  const untouchable = await vw2.refineRange('ac', 2_600_000, 4_100_000, 200_000)
  record('容差内没有可选边界时，那一端保持原样（不硬吸）',
    untouchable.start_us === 2_600_000 && untouchable.end_us === 4_000_000,
    `区间 → ${untouchable.start_us / 1e6}-${untouchable.end_us / 1e6}s，调整 ${JSON.stringify((untouchable.adjustments ?? []).map(a => `${a.edge}=${a.source}`))}`)

  // 屏幕文字的边界必须报成它自己，不能报成转写 —— 吸附说明是给用户看的依据，
  // 报错来源等于给了一个假的理由。（这两行此前共用一个硬编码的来源标签。）
  const labelled = await vw2.refineRange('ac', 3_900_000, 6_100_000, 200_000)
  const srcs = (labelled.adjustments ?? []).map(a => String(a.source))
  record('屏幕文字的边界报成 screen-text 而不是 transcript',
    srcs.length > 0 && srcs.every(s => s === 'screen-text'),
    `调整来源 ${JSON.stringify(srcs)}`)
}

// ── 字幕导出：时间必须换算到成片坐标 ──────────────────────────────────────
{
  // 证据里的时间是**素材坐标**，而字幕是照着**成片**读的。片段一旦被重排、裁剪或
  // 变速，按素材坐标摆的字幕就会错位 —— 而错位要到有人看片时才会被发现。
  await vw2.createTimeline({ id: 'tl-sub', name: 'subtitle', project_id: 'pc', asset_id: 'ac', start_us: 1_000_000, end_us: 3_000_000 })
  const line = await vw2.timeline('tl-sub')
  await vw2.setSegments({ timeline_id: 'tl-sub', base_revision: line.revision, clips: [
    { asset_id: 'ac', start_us: 1_000_000, end_us: 3_000_000 },
    { asset_id: 'ac', start_us: 5_000_000, end_us: 8_000_000 },
  ] })
  const srt = await vw2.exportSubtitles('tl-sub', 'transcript', 'srt', new AbortController().signal)
  // 成片 5 秒：第一句在素材 1-3s 里，落在成片 0-2s；第二句整句在第二段里，
  // 落在成片 2-5s。若按素材坐标直接输出，第一条会是 1-3s，一眼能看出错。
  record('字幕时间换算到成片坐标（不是素材坐标）',
    srt.cue_count === 2 && srt.cues[0].start_us === 0 && srt.cues[0].end_us === 2_000_000 && srt.cues[1].end_us === 5_000_000,
    `成片 ${srt.output_seconds}s，条目 ${JSON.stringify(srt.cues.map(c => [c.start_us / 1e6, c.end_us / 1e6]))}`)

  record('SRT 用逗号分隔毫秒且块间空行',
    srt.content.startsWith('1\n00:00:00,000 --> 00:00:02,000\n') && srt.content.includes('\n\n2\n'),
    JSON.stringify(srt.content.slice(0, 46)))

  const vtt = await vw2.exportSubtitles('tl-sub', 'screen-text', 'vtt', new AbortController().signal)
  record('VTT 以 WEBVTT 开头且用点分隔毫秒',
    vtt.content.startsWith('WEBVTT\n') && vtt.content.includes(' --> ') && vtt.content.includes('.000 -->'),
    JSON.stringify(vtt.content.slice(0, 44)))
}

// ── 变速：字幕必须跟着一起压缩 ────────────────────────────────────────────
{
  // 渲染用 setpts=(1/speed)*PTS 把一段压短，成片里这段时间真的只有那么长，
  // 字幕若仍按素材时长摆，就会越播越偏 —— 前半句还对得上，后半句已经在说别的事。
  // 这一条此前从未验证过：上面的验算全是 speed=1 的线。
  const line = await vw2.timeline('tl-sub')
  await vw2.setSegments({ timeline_id: 'tl-sub', base_revision: line.revision, clips: [
    { asset_id: 'ac', start_us: 1_000_000, end_us: 3_000_000, speed: 2 },
    { asset_id: 'ac', start_us: 5_000_000, end_us: 8_000_000 },
  ] })
  const fast = await vw2.exportSubtitles('tl-sub', 'transcript', 'srt', new AbortController().signal)
  // 第一段 2 秒素材按 2 倍速播出 = 1 秒；第二段不变 3 秒。成片 4 秒。
  // 第二句整句落在第二段里，起点应在 1 秒处（第一段压缩后的长度）。
  record('变速片段的字幕跟着一起压缩',
    fast.output_seconds === 4 && fast.cues[0].end_us === 1_000_000 && fast.cues[1].start_us === 1_000_000 && fast.cues[1].end_us === 4_000_000,
    `成片 ${fast.output_seconds}s，条目 ${JSON.stringify(fast.cues.map(c => [c.start_us / 1e6, c.end_us / 1e6]))}`)
  // 上限写死成 4 秒，不引用 fast.output_seconds —— 否则成片时长算错时，
  // 条目和上限一起错，这条断言会"自洽地"通过而什么都没检查。
  // （上一版就是这样：植入"不除 speed"的 bug 后它照样通过。）
  record('变速后字幕不越过成片长度',
    fast.cues.every(cue => cue.end_us <= 4_000_000),
    `最末 ${Math.max(...fast.cues.map(c => c.end_us)) / 1e6}s，上限 4s`)
}

// ── 字幕烧录：字幕必须真的进了画面 ────────────────────────────────────────
{
  // 只断言"渲染成功"是不够的：烧录是一个可选的后期步骤，它失败时最自然的写法
  // 就是跳过而不报错 —— 那样用户会拿到一个没有字幕的成片，而返回值里写着成功。
  // 这里直接数像素：把成片底部那一条与未烧录版本比对。
  const burned = await vw2.render('tl-sub', 'burned.mp4', new AbortController().signal, { burnSubtitles: 'transcript' })
  const plain = await vw2.render('tl-sub', 'plain.mp4', new AbortController().signal)
  // 取本地路径走探针自己的 served 映射：上传时已把每个对象落在盘上，
  // 直接列目录是猜布局，猜错了只会得到一个与产品无关的失败。
  const find = suffix => [...served.entries()].filter(([key]) => key.endsWith(suffix)).map(([, local]) => local).pop()
  const burnedFile = find('-burned.mp4')
  const plainFile = find('.mp4') !== undefined && find('-burned.mp4') === undefined ? undefined : [...served.entries()].filter(([key]) => key.endsWith('.mp4') && !key.includes('burned')).map(([, local]) => local).pop()
  if (burnedFile === undefined || plainFile === undefined) {
    record('烧录产物与未烧录产物都能找到', false, `burned=${burnedFile} plain=${plainFile}`)
  } else {
    // 底部 20% 区域的平均亮度差：字幕是亮字带描边，烧上去会明显改变这一带。
    const crop = 'crop=iw:ih*0.2:0:ih*0.8,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG'
    const measure = async file => {
      const { stderr } = await run('ffmpeg', ['-nostdin', '-v', 'info', '-i', file, '-vf', crop, '-f', 'null', '-'], { maxBuffer: 1 << 22 })
      const values = [...String(stderr).matchAll(/YAVG=([\d.]+)/g)].map(m => Number(m[1]))
      return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
    }
    const burnedAvg = await measure(burnedFile)
    const plainAvg = await measure(plainFile)
    record('烧录后的画面底部与未烧录不同（字幕真的进了画面）',
      burnedAvg !== null && plainAvg !== null && Math.abs(burnedAvg - plainAvg) > 0.5,
      `底部平均亮度 烧录 ${burnedAvg?.toFixed(2)} vs 未烧录 ${plainAvg?.toFixed(2)}`)
    record('烧录没有改变成片时长',
      Math.abs(burned.duration_seconds - plain.duration_seconds) < 0.2,
      `烧录 ${burned.duration_seconds}s vs 未烧录 ${plain.duration_seconds}s`)
  }

  // 没有字幕证据时不能假装烧了。上一版这条断言写成"notes 里有『烧录』二字就算过"，
  // 而那条线**确实烧了字幕** —— 它于是永远为真，等于没测。
  // 要测这条路径就得用一条**真的没有对应证据**的素材。
  served.set('projects/pc/bare.mp4', clip)
  raw2.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('ab', 'pc', 'oss://projects/pc/bare.mp4', JSON.stringify({ duration_us: 10_000_000, width: 320, height: 240 }))
  await vw2.createTimeline({ id: 'tl-bare', name: 'bare', project_id: 'pc', asset_id: 'ab', start_us: 1_000_000, end_us: 3_000_000 })
  const bareLine = await vw2.timeline('tl-bare')
  await vw2.setSegments({ timeline_id: 'tl-bare', base_revision: bareLine.revision, clips: [{ asset_id: 'ab', start_us: 1_000_000, end_us: 3_000_000 }] })
  const empty = await vw2.render('tl-bare', 'nosub.mp4', new AbortController().signal, { burnSubtitles: 'transcript' })
  const emptyNotes = (empty.notes ?? []).map(String).join(' | ')
  record('素材没有字幕证据时如实说明，不假装烧录成功',
    emptyNotes.includes('没有') && emptyNotes.includes('video_evidence_transcript'),
    emptyNotes.slice(0, 130) || '(notes 为空 —— 那就等于静默跳过了)')
}

// ── 找相似片段：参照物是证据，且不能把参照区间自己报回来 ──────────────────
{
  // 桩件里对应"找相似"的回答。按 JSON 字段名区分（与另外三个一致）。
  canned['"matches"'] = { matches: [
    // 与参照区间 5.0-8.0s 重叠的部分必须被剔除 —— 它与自己必然相似。
    { start_us: 6_000_000, end_us: 7_000_000, reason: '与参照区间重叠，不应出现在结果里' },
    { start_us: 1_000_000, end_us: 3_000_000, reason: '同一个人在同一间屋子里说话' },
    { start_us: 8_000_000, end_us: 9_000_000, reason: '紧接在参照区间之后的同一场景' },
  ] }

  const similar = await vw2.findSimilar({ project_id: 'pc', asset_id: 'ac', start_us: 5_000_000, end_us: 8_000_000 }, new AbortController().signal)
  record('相似结果里不含参照区间自己',
    (similar.matches ?? []).every(m => Number(m.end_us) <= 5_000_000 || Number(m.start_us) >= 8_000_000),
    `返回区间 ${JSON.stringify((similar.matches ?? []).map(m => [m.start_us / 1e6, m.end_us / 1e6]))}`)

  record('每条相似结果都带"像在哪里"的理由',
    (similar.matches ?? []).length > 0 && (similar.matches ?? []).every(m => String(m.reason ?? '').trim() !== ''),
    `理由 ${JSON.stringify((similar.matches ?? []).map(m => String(m.reason).slice(0, 16)))}`)

  // 参照物必须是那一段自己的证据：不给它，模型只能凭印象说"像"，而无法核验。
  record('参照区间的证据随结果一起返回（结果可核验）',
    similar.reference_evidence !== undefined && Array.isArray(similar.reference_evidence.spoken) && Array.isArray(similar.reference_evidence.scenes),
    `参照证据 说=${similar.reference_evidence?.spoken?.length} 屏=${similar.reference_evidence?.on_screen?.length} 画面=${similar.reference_evidence?.scenes?.length}`)

  // 区间上没有任何证据时应当明确拒绝，而不是让模型凭空找相似。
  let refused = false
  try { await vw2.findSimilar({ project_id: 'pc', asset_id: 'ab', start_us: 0, end_us: 1_000_000 }, new AbortController().signal) } catch (error) { refused = String(error.message).includes('没有任何证据') }
  record('参照区间没有证据时明确拒绝（不凭印象找相似）', refused, refused ? '明确拒绝并说明要先算证据' : '没有拦住')
}

// 桩件没匹配到提示词时不能静默通过：那种情况下所有断言都会"通过"而其实什么都没测。
record('桩件关键词既不落空也不互相重叠',
  unmatchedPrompts.length === 0 && ambiguousPrompts.length === 0 && modelCalls >= 3,
  unmatchedPrompts.length > 0 ? `落空 ${unmatchedPrompts.length} 次：${unmatchedPrompts[0].slice(0, 60)}`
    : ambiguousPrompts.length > 0 ? `重叠命中：${ambiguousPrompts.join(' / ')}`
    : `模型被调用 ${modelCalls} 次，每个提示词恰好命中一个桩件`)

await vw2.dispose()

console.log('\n' + '='.repeat(64))
console.log(`  共 ${passed + failed} 项，问题 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
