/**
 * Multi-clip timelines, on a clip whose structure is known.
 *
 * The clip is ten one-second colour segments with eight detectable cuts, so a timeline
 * built from chosen ranges can be checked against what was put in: clip count, total
 * duration, order, and the duration of the file that finally comes out. Rendering runs
 * real ffmpeg; only OSS is stubbed.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const RUNTIME = process.argv[2]
const run = promisify(execFile)

/**
 * Build the clip used as source material.
 *
 * Ten one-second colours make the cut points predictable, so a clip cut from
 * `[2s, 4s)` is known to begin on a boundary rather than mid-shot.
 *
 * @param dir - directory to write the clip into.
 * @returns Path of the generated clip.
 */
async function buildClip(dir, size = '320x240') {
  const colours = ['black', 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray', 'white', 'cyan']
  const args = ['-nostdin', '-v', 'error', '-y']
  for (const colour of colours) args.push('-f', 'lavfi', '-i', `color=c=${colour}:s=${size}:d=1,format=yuv420p`)
  args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=10')
  const video = colours.map((_, index) => `[${index}:v]`).join('') + `concat=n=${colours.length}:v=1:a=0[v]`
  const clip = join(dir, `timeline-source-${size}.mp4`)
  args.push('-filter_complex', video, '-map', '[v]', '-map', `${colours.length}:a`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip)
  await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })
  return clip
}

// 目录要先定义：档件里把对象落盘时会用到它。
const dir = await mkdtemp(join(tmpdir(), 'goclip-multi-'))

const realFetch = globalThis.fetch
// 档件把 PUT 的字节留下来，这样最后能对成片的真实时长做校验，
// 而不只是相信插件自己报的数字。
const uploaded = new Map()
// 导出任务的 id 是校验时要用的参数。
const jobsSeen = new Set()
/**
 * Serve what was uploaded, so a signed URL behaves like a real object store.
 *
 * `validateRender` measures the finished film through ffprobe over the signed URL, and
 * ffprobe is a child process: it does not go through this stub. Writing the object to a
 * local file and pointing ffprobe at it is the only way the measurement can happen
 * without reaching a real bucket.
 */
const served = new Map()
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/chat/completions')) return realFetch(url, init)
  if (init?.method === 'PUT') {
    const key = decodeURIComponent(target.split('?')[0].split('/').slice(3).join('/'))
    const body = init.body
    const object = body === undefined || body === null ? Buffer.alloc(0)
      : typeof body === 'string' ? Buffer.from(body)
      : body instanceof ReadableStream ? Buffer.from(await new Response(body).arrayBuffer())
      : Buffer.from(body)
    uploaded.set(key, object)
    // 同时按部署的本地导出布局落盘：校验会先找本地副本，找不到才走签名 URL。
    const local = join(dir, 'oss-output', key)
    await mkdir(dirname(local), { recursive: true })
    await writeFile(local, object)
    served.set(key, local)
    return new Response('', { status: 200 })
  }
  if (target.includes('/index.json')) return new Response(JSON.stringify({ version: 4, projects: [] }), { status: 200 })
  // 签名 URL 指向已上传的对象：本地那份已经在 PUT 时落盘，这里只为直接读 URL 的调用者服务。
  const key = decodeURIComponent(target.split('?')[0].split('/').slice(3).join('/'))
  // served 里的条目是"已经在本地落盘的对象"：上传时写入的，以及用例预置的 fixture。
  // 预置 fixture 时只登记本地路径（不给 uploaded 塞字节），所以这里要补读文件。
  let object = uploaded.get(key)
  if (object === undefined && served.has(key)) object = await readFile(served.get(key))
  if (object !== undefined) {
    if (init?.method === 'HEAD') return new Response('', { status: 200, headers: { 'content-length': String(object.length) } })
    return new Response(new Blob([object]), { status: 200, headers: { 'content-length': String(object.length) } })
  }
  return new Response('not found', { status: 404 })
}

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
  silenceMinSeconds: 0.4, silenceMarginDb: 10,
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
const totalSeconds = timeline => timeline.duration_us / 1e6

const vw = new VideoWorkspace(config)
await vw.createProject('pm', '多段测试')
const { DatabaseSync } = await import('node:sqlite')
const raw = new DatabaseSync(join(dir, 'video-tools.sqlite'))
raw.exec('PRAGMA foreign_keys=ON')
raw.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('am', 'pm', clip, JSON.stringify({ duration_us: 10_000_000, width: 320, height: 240 }))
raw.close()

// ── 建线 + 追加两段 ─────────────────────────────────────────────────────────
let tl = null
{
  tl = await vw.createTimeline({ id: 'tm', project_id: 'pm', asset_id: 'am', start_us: 0, end_us: 1_000_000 })
  record('新建时间线自带一段', tl.segment_count === 1 && tl.revision === 1, `段数=${tl.segment_count}，revision=${tl.revision}`)
  tl = await vw.addSegment({ timeline_id: 'tm', base_revision: tl.revision, asset_id: 'am', start_us: 2_000_000, end_us: 4_000_000 })
  tl = await vw.addSegment({ timeline_id: 'tm', base_revision: tl.revision, asset_id: 'am', start_us: 6_000_000, end_us: 6_500_000 })
  record('可以追加到多段', tl.segment_count === 3, `段数=${tl.segment_count}，revision=${tl.revision}`)
  record('总时长按段求和而不是按跨度', Math.abs(totalSeconds(tl) - (1 + 2 + 0.5)) < 0.01,
    `总时长=${totalSeconds(tl)}s（三段分别 1+2+0.5；跨度写法会得到 6.5s）`)
  record('每段都带自己的序号与素材引用',
    tl.segments.map(s => s.ordinal).join(',') === '0,1,2' && tl.segments.every(s => s.asset_id === 'am'),
    JSON.stringify(tl.segments.map(s => [s.ordinal, s.start_us / 1e6, s.end_us / 1e6])))
}

// ── 版本冲突必须挡住并发覆盖 ────────────────────────────────────────────────
{
  let blocked = false
  try { await vw.trimSegment({ timeline_id: 'tm', base_revision: 1, ordinal: 0, edge: 'end', delta_us: 100_000 }) }
  catch (error) { blocked = String(error.message).includes('revision conflict') }
  record('用旧版本号改会被拒绝', blocked, blocked ? '抛出了 revision conflict' : '没有拦住')
}

// ── 裁剪 / 改顺序 / 删除 ───────────────────────────────────────────────────
{
  tl = await vw.trimSegment({ timeline_id: 'tm', base_revision: tl.revision, ordinal: 0, edge: 'end', delta_us: 200_000 })
  record('裁短结尾', Math.abs(tl.segments[0].end_us - 800_000) < 1, `第 0 段 end_us=${tl.segments[0].end_us}`)
  tl = await vw.trimSegment({ timeline_id: 'tm', base_revision: tl.revision, ordinal: 0, edge: 'start', delta_us: 300_000 })
  record('裁短开头', Math.abs(tl.segments[0].start_us - 300_000) < 1, `第 0 段 start_us=${tl.segments[0].start_us}`)

  // from=0,to=2 在三段里是空操作（第 0 个移到第 2 位结果不变），
  // 所以用 to=0 把末位提到最前，这才真的改了顺序。
  const before = tl.segments.map(s => s.start_us)
  tl = await vw.reorderSegment({ timeline_id: 'tm', base_revision: tl.revision, from: 2, to: 0 })
  record('换顺序后原末位段到了最前',
    tl.segments.map(s => s.start_us).join(',') === [before[2], before[0], before[1]].join(','),
    `${JSON.stringify(before.map(v => v / 1e6))} → ${JSON.stringify(tl.segments.map(s => s.start_us / 1e6))}`)
  record('序号仍然连续', tl.segments.map(s => s.ordinal).join(',') === '0,1,2', JSON.stringify(tl.segments.map(s => s.ordinal)))

  tl = await vw.removeSegment({ timeline_id: 'tm', base_revision: tl.revision, ordinal: 1 })
  record('删除中间一段后序号自动前移',
    tl.segment_count === 2 && tl.segments.map(s => s.ordinal).join(',') === '0,1',
    `段数=${tl.segment_count}，序号=${JSON.stringify(tl.segments.map(s => s.ordinal))}`)

  let refused = false
  tl = await vw.setSegments({ timeline_id: 'tm', base_revision: tl.revision, clips: [{ asset_id: 'am', start_us: 0, end_us: 500_000 }] })
  const one = tl
  try { await vw.removeSegment({ timeline_id: 'tm', base_revision: one.revision, ordinal: 0 }) }
  catch (error) { refused = String(error.message).includes('唯一的一段') }
  record('拒绝删掉最后一段（否则会导出空文件）', refused, refused ? '明确拒绝并说明原因' : '没有拦住')
}

// ── 一次性设置：去停顿场景的实际用法 ───────────────────────────────────────
{
  const clips = [{ asset_id: 'am', start_us: 0, end_us: 1_500_000 }, { asset_id: 'am', start_us: 5_000_000, end_us: 6_000_000 }, { asset_id: 'am', start_us: 8_000_000, end_us: 9_000_000 }]
  const beforeSet = tl.revision
  tl = await vw.setSegments({ timeline_id: 'tm', base_revision: tl.revision, clips })
  record('一次性设置整套片段', tl.segment_count === 3 && Math.abs(totalSeconds(tl) - 3.5) < 0.01,
    `段数=${tl.segment_count}，总时长=${totalSeconds(tl)}s`)
  record('一次调用只推进一个版本', tl.revision === beforeSet + 1, `revision ${beforeSet} → ${tl.revision}`)
}

// ── 真实渲染多段 ───────────────────────────────────────────────────────────
{
  const out = await vw.render('tm', 'multi.mp4', new AbortController().signal)
  jobsSeen.add(out.id)
  record('多段导出成功并报告段数与总时长',
    out.status === 'completed' && out.segment_count === 3 && Math.abs(out.duration_seconds - 3.5) < 0.2,
    `段数=${out.segment_count}，报告时长=${out.duration_seconds}s，reencoded=${out.reencoded}`)
  record('多段导出记录了拼接阶段',
    out.stages.some(s => s.stage.startsWith('拼接')), JSON.stringify(out.stages.map(s => s.stage)))
}

// ── 渲染产物的真实时长必须与时间线一致 ────────────────────
{
  const entry = [...uploaded.entries()].find(([key]) => key.endsWith('.mp4') && key.includes('-multi.mp4'))
  let measured = null
  if (entry !== undefined) {
    const file = join(dir, 'downloaded.mp4')
    await writeFile(file, entry[1])
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file], { maxBuffer: 1 << 20 })
    measured = Number(String(probe.stdout).trim())
  }
  record('成片实际时长等于各段之和（3.5 秒）', measured !== null && Math.abs(measured - 3.5) < 0.25,
    measured === null ? `没收到成片（已收 ${uploaded.size} 个对象）` : `实测 ${measured.toFixed(2)}s`)
}

// ── 成片校验：上限与时长差 ──────────────────────────────────────────────────
{
  const jobId = [...jobsSeen].pop()
  const check = await vw.validateRender(jobId, new AbortController().signal)
  record('校验报告实际时长与体积',
    check.actual_seconds !== null && check.megabytes !== null,
    `实际 ${check.actual_seconds}s / ${check.megabytes}MB，期望 ${check.expected_seconds}s`)
  record('时长差当作信息报出而不是隐藏', check.drift_seconds !== null,
    `drift=${check.drift_seconds}s，实际 ${check.actual_seconds}s vs 计划 ${check.expected_seconds}s`)
  record('在上限内时 within_limits 为真', check.within_limits === true && check.problems.length === 0,
    `within_limits=${check.within_limits}，problems=${JSON.stringify(check.problems)}`)
}
// 超限必须被报出来：拿一个偏小的上限去校验同一份成片，判定要真的翻转
{
  const tiny = new VideoWorkspace({ ...config, maxOutputSeconds: 1, maxOutputBytes: 1024 })
  const check = await tiny.validateRender(undefined, new AbortController().signal)
  record('超过上限时明确报出问题',
    check.within_limits === false && check.problems.length >= 2,
    `problems=${JSON.stringify(check.problems)}`)
  tiny.dispose()
}

// ── 静音必须真的生效（volume 是音频滤镜，放进 -vf 会被 ffmpeg 忽略）────────
// 差分验证：同一段内容，一次静音一次不静音，音量必须下降。
// 只测一次会得到"看起来偏低"的数值，但那可能只是源本身就不响。
{
  const measure = async (filename) => {
    const entry = [...uploaded.entries()].find(([key]) => key.includes(filename))
    if (entry === undefined) return null
    const file = join(dir, `${filename}.mp4`)
    await writeFile(file, entry[1])
    const probe = await run('ffmpeg', ['-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 1 << 22 })
    const match = /mean_volume:\s*(-?[0-9.]+) dB/.exec(String(probe.stderr))
    return match === null ? null : Number(match[1])
  }
  const clips = [{ asset_id: 'am', start_us: 0, end_us: 2_000_000 }, { asset_id: 'am', start_us: 4_000_000, end_us: 6_000_000 }]
  await vw.setSegments({ timeline_id: 'tm', base_revision: (await vw.timeline('tm')).revision, clips })
  await vw.render('tm', 'sound-on.mp4', new AbortController().signal)
  const audible = await measure('sound-on.mp4')
  const muted = clips.map(clip => ({ ...clip, muted: true }))
  await vw.setSegments({ timeline_id: 'tm', base_revision: (await vw.timeline('tm')).revision, clips: muted })
  await vw.render('tm', 'sound-off.mp4', new AbortController().signal)
  const silent = await measure('sound-off.mp4')
  record('静音段真的被静音（同一内容差分对比）',
    audible !== null && silent !== null && silent < audible - 20,
    `有声 mean=${audible} dB → 静音 mean=${silent} dB（差 ${audible !== null && silent !== null ? (audible - silent).toFixed(1) : '?'} dB）`)
}

// ── 封面抽帧 ────────────────────────────────────────────────────────────────
{
  const cover = await vw.coverPick({ timeline_id: 'tm', ordinal: 0, offset_seconds: 0.5, filename: 'cover.jpg' }, new AbortController().signal)
  // 不按字节数断言：测试素材是纯色块，JPEG 压缩后只有几百字节是正常的。
  record('封面从片段内部取帧并上传',
    cover.ordinal === 0 && cover.offset_in_clip_seconds === 0.5 && cover.bytes > 100 && cover.oss_key.endsWith('.jpg')
      // 第 0 段是 0–2 秒，所以 0.5 秒处的进度是 0.25。
      && cover.source_position_us === 500_000 && cover.clip_progress === 0.25,
    `${cover.kilobytes} KB，落在源位置 ${(cover.source_position_us / 1e6).toFixed(2)}s，该段进度 ${cover.clip_progress}`)
  // 取到的必须真的是 JPEG：只看扩展名会被骗。
  const entry = [...uploaded.entries()].find(([key]) => key.endsWith('.jpg'))
  const isJpeg = entry !== undefined && entry[1][0] === 0xFF && entry[1][1] === 0xD8
  record('产物真的是 JPEG（按魔数判断）', isJpeg,
    entry === undefined ? '没收到图片' : `首两字节=${entry[1][0].toString(16)} ${entry[1][1].toString(16)}`)
  let beyond = false
  try { await vw.coverPick({ timeline_id: 'tm', ordinal: 0, offset_seconds: 999 }, new AbortController().signal) }
  catch (error) { beyond = String(error.message).includes('取不到') }
  record('超出片段长度时拒绝取帧', beyond, beyond ? '明确拒绝并说明' : '没有拦住')
}

// ── 画幅：竖版要重构图而不是裁切 ────────────────────────────────────────────
{
  const measure = async (filename) => {
    const e = [...uploaded.entries()].find(([key]) => key.includes(filename))
    if (e === undefined) return null
    const file = join(dir, `${filename}.probe.mp4`)
    await writeFile(file, e[1])
    const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { maxBuffer: 1 << 20 })
    return String(probe.stdout).trim()
  }
  await vw.render('tm', 'wide.mp4', new AbortController().signal, { aspect: '16:9' })
  const wide = await measure('wide.mp4')
  await vw.render('tm', 'tall.mp4', new AbortController().signal, { aspect: '9:16' })
  const tall = await measure('tall.mp4')
  await vw.render('tm', 'square.mp4', new AbortController().signal, { aspect: '1:1' })
  const square = await measure('square.mp4')
  const ratio = (pair) => { const [w, h] = String(pair).split(',').map(Number); return w / h }
  record('横版导出为 16:9', wide !== null && Math.abs(ratio(wide) - 16 / 9) < 0.02, `实际 ${wide}`)
  record('竖版导出为 9:16（重构图，不是裁掉两边）', tall !== null && Math.abs(ratio(tall) - 9 / 16) < 0.02, `实际 ${tall}`)
  record('方形导出为 1:1', square !== null && Math.abs(ratio(square) - 1) < 0.02, `实际 ${square}`)
  record('三种画幅互不相同（说明确实按比例重建了）', new Set([wide, tall, square]).size === 3, `${wide} / ${tall} / ${square}`)
}

// ── 切分与合并 ──────────────────────────────────────────────────────────────
{
  let tl = await vw.setSegments({ timeline_id: 'tm', base_revision: (await vw.timeline('tm')).revision, clips: [
    { asset_id: 'am', start_us: 0, end_us: 4_000_000 },
    { asset_id: 'am', start_us: 6_000_000, end_us: 8_000_000 },
  ] })
  const split = await vw.splitSegment({ timeline_id: 'tm', base_revision: tl.revision, ordinal: 0, asset_time_us: 2_500_000 })
  tl = split.timeline
  record('切分把一段变成两段且时长不变',
    tl.segment_count === 3 && tl.segments[0].end_us === 2_500_000 && tl.segments[1].start_us === 2_500_000,
    `段数=${tl.segment_count}，区间=${JSON.stringify(tl.segments.map(s => [s.start_us / 1e6, s.end_us / 1e6]))}`)

  let outside = false
  try { await vw.splitSegment({ timeline_id: 'tm', base_revision: tl.revision, ordinal: 0, asset_time_us: 9_000_000 }) }
  catch (error) { outside = String(error.message).includes('不在第') }
  record('切点落在段外时拒绝（不做无声的空操作）', outside, outside ? '明确拒绝并说明' : '没有拦住')

  const merged = await vw.mergeSegments({ timeline_id: 'tm', base_revision: tl.revision, ordinal: 0 })
  tl = merged.timeline
  record('合并相邻两段回到一段',
    tl.segment_count === 2 && tl.segments[0].start_us === 0 && tl.segments[0].end_us === 4_000_000,
    `段数=${tl.segment_count}，首段=${tl.segments[0].start_us / 1e6}s–${tl.segments[0].end_us / 1e6}s`)

  // 不连续的两段不能合并：那会把缺口也算进成片。
  let gap = false
  try { await vw.mergeSegments({ timeline_id: 'tm', base_revision: tl.revision, ordinal: 0 }) }
  catch (error) { gap = String(error.message).includes('不连续') }
  record('素材上不连续的两段拒绝合并', gap, gap ? '明确拒绝并说明会算进缺口' : '没有拦住')

  const last = await vw.timeline('tm')
  let tail = false
  try { await vw.mergeSegments({ timeline_id: 'tm', base_revision: last.revision, ordinal: last.segment_count - 1 }) }
  catch (error) { tail = String(error.message).includes('最后一段') }
  record('最后一段没有可合并对象时拒绝', tail, tail ? '明确拒绝' : '没有拦住')
}

// ── 成片校验必须能识破"没有画面"的文件 ──────────────────────────────────────
{
  // 这一条守的是一类具体的坑：某些源文件能让 ffmpeg 无声地丢掉视频流，
  // 产出时长正确、体积正常、却放不出画面的成片。只校验时长和体积抓不到它。
  const v = await vw.validateRender([...jobsSeen].pop(), AbortSignal.timeout(300000))
  record('成片校验会报告是否含视频流',
    typeof v.has_video_stream === 'boolean' && typeof v.width === 'number',
    `has_video_stream=${v.has_video_stream}  ${v.width}x${v.height}`)
  record('没有任何画面的成片被判为不合规',
    v.has_video_stream === true || v.problems.some(p => String(p).includes('没有视频流')),
    v.has_video_stream === true ? '该成片有画面（正常）' : v.problems[0])
}

// ── 规格不同的多素材拼接：时长必须与声明一致 ──────────────────────────────
{
  // concat demuxer 配 -c copy 要求所有段完全一致。不一致时 ffmpeg 不报错，
  // 而是产出一个时长与声明不符的文件 —— 实测 540x360@25fps 与 360x640@30fps
  // 四段各 4 秒混剪，报 16 秒、实际 19.14 秒，播放器行为也说不清。
  //
  // 这里必须用**真的不同**的两段素材，否则这条断言在旧代码上也会通过。
  const portraitClip = await buildClip(dir, '360x640')
  const mixed = await vw.import('pm', portraitClip)
  const line = await vw.timeline('tm')
  await vw.setSegments({ timeline_id: 'tm', base_revision: line.revision, clips: [
    { asset_id: 'am', start_us: 0, end_us: 2_000_000 },
    { asset_id: mixed.id, start_us: 0, end_us: 2_000_000 },
    { asset_id: 'am', start_us: 4_000_000, end_us: 6_000_000 },
  ] })
  const out = await vw.render('tm', 'mixed-sizes.mp4', new AbortController().signal)
  const checked = await vw.validateRender(out.id, AbortSignal.timeout(300000))
  record('规格不同的多素材拼接：实际时长与声明一致',
    checked.actual_seconds !== null && Math.abs(checked.actual_seconds - out.duration_seconds) < 0.3,
    `声明 ${out.duration_seconds}s，实测 ${checked.actual_seconds}s`)
  record('混剪后的成片有画面且合规',
    checked.has_video_stream === true && checked.within_limits === true,
    `视频流=${checked.has_video_stream} ${checked.width}x${checked.height} 合规=${checked.within_limits}`)
}

// ── 竖屏素材必须也能生成代理 ────────────────────────────────────────────────
{
  // 这一条守的是一个真实发生过的、且**只在竖屏上出现**的故障：
  // `scale=-2:720:force_original_aspect_ratio=decrease` 里两个选项互相打架，
  // ffmpeg 把非法帧尺寸交给 libx264，编码以 `return code -22` 死掉且一个字节都不写。
  // 它在横屏素材上恰好能用，所以此前所有用例（全是横屏）都放行了 ——
  // 而手机竖着拍的素材是创作者最可能带来的东西。
  //
  // 必须调 prepare 本身而不是单独调滤镜：出问题的是整条转码链路，不是那一个表达式。
  // 尺寸必须用 360x640：崩溃只在特定尺寸上出现 —— 240x320 和 400x400 都能过，
  // 而 360x640（手机竖拍的常见规格）必崩。用"看起来是竖屏"的尺寸是不够的，
  // 我第一版就是用了 240x320，断言在坏代码上照样通过。
  const portrait = await buildClip(dir, '360x640')
  let proxy = null
  let failure = null
  try { proxy = await vw.prepare(portrait, new AbortController().signal) } catch (error) { failure = error }
  record('竖屏素材能生成代理视频', proxy !== null,
    proxy === null ? `失败：${String(failure?.message ?? '').split('\n').slice(-1)[0]?.slice(0, 90)}` : proxy.split(/[\\/]/).pop())
  if (proxy !== null) {
    const probed = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', proxy], { maxBuffer: 1 << 20 })
    const [w, h] = String(probed.stdout).trim().split(',').map(Number)
    record('竖屏代理保持竖屏且宽度为偶数', w > 0 && h > 0 && h > w && w % 2 === 0, `${w}x${h}`)
    // 从素材自身探测高度：写死期望值会在换 fixture 尺寸时变成假失败。
    const srcProbe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', portrait], { maxBuffer: 1 << 20 })
    const srcHeight = Number(String(srcProbe.stdout).trim())
    record('矮素材不被放大（放大只增像素不增信息）', h <= srcHeight, `代理高 ${h}，源高 ${srcHeight}`)
  }
}

// ── 没有画面的产物必须被认出来（不是只在正常产物上"也通过"）──────────────────
{
  // 上面那条断言只证明"好产物不被误判"。它证明不了"坏产物会被发现" ——
  // 因为合成的成片都带画面，那条分支从未被执行到。植入 bug（把判定改成 if (false)）
  // 时它照样通过，这一条就是为了补上另一个方向。
  //
  // 造一个有音轨、无视频流的文件，喂给校验，看它会不会说"没有视频流"。
  const audioOnly = join(dir, 'audio-only.mp4')
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:a', 'aac', '-vn', audioOnly], { maxBuffer: 1 << 22 })
  const key = 'o/probe-broken/nothing-to-see.mp4'
  const local = join(dir, 'oss-output', key)
  await mkdir(dirname(local), { recursive: true })
  await writeFile(local, await readFile(audioOnly))
  served.set(key, local)

  const timeline = await vw.timeline('tm')
  const target = [...jobsSeen].pop()
  await vw.declareBrokenOutput(target, key)
  const checked = await vw.validateRender(target, AbortSignal.timeout(300000))
  record('没有画面的产物被判为不合规',
    checked.has_video_stream === false && checked.within_limits === false,
    `has_video_stream=${checked.has_video_stream}  within_limits=${checked.within_limits}`)
  record('问题描述说清是"没有视频流"而不只是"不合规"',
    checked.problems.some(p => String(p).includes('没有视频流')),
    checked.problems.find(p => String(p).includes('没有视频流')) ?? `问题列表：${JSON.stringify(checked.problems)}`)
}

// ── 删除：级联清干净，且如实说明 OSS 对象仍在 ───────────────────────────────
{
  const before = (await vw.assets('pm')).length
  const result = await vw.deleteAsset('pm', 'am')
  record('删素材会一并清掉派生的分析与证据', result.removed_analyses >= 0 && result.removed_timelines >= 1,
    `时间线 ${result.removed_timelines} 条、分析 ${result.removed_analyses} 份、证据 ${result.removed_evidence} 条`)
  record('删除后说明 OSS 对象未被删', String(result.note).includes('OSS'),
    result.note)
  const left = await vw.assets('pm')
  // 按"比删除前少一个"判定，不写死 0：项目里可能还有别的素材
  //（这条断言原本写死 0，混剪用例给同一项目加了第二个素材后就变成了假失败）。
  record('素材确实从索引里消失', left.length === before - 1 && !left.some(x => x.id === 'am'),
    `删除前 ${before} 个，删除后 ${left.length} 个`)
}

vw.dispose()
console.log('\n' + '='.repeat(64))
const bad = results.filter(r => !r.ok)
console.log(`共 ${results.length} 项，问题 ${bad.length} 项`)
for (const b of bad) console.log(`  · ${b.name}：${b.detail}`)
