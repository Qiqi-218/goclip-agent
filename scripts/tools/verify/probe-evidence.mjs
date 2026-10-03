/**
 * Evidence layer, measured against a clip whose structure is known.
 *
 * A synthetic asset is built with fixed per-second loudness and one colour change per
 * second, so every number the evidence returns can be checked against what was put in
 * rather than against what the code happens to produce. OSS is stubbed: this measures
 * the local analysis, not persistence.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const RUNTIME = process.argv[2]
const run = promisify(execFile)

/**
 * Build the clip this probe measures, so the expectations are the inputs.
 *
 * Ten one-second colour segments give nine shots and eight cuts at whole seconds, and
 * the audio track is two seconds of silence, one second loud, then seven seconds quiet.
 * Every assertion below is a statement about those known values.
 *
 * @param dir - directory to write the clip into.
 * @returns Path of the generated clip.
 */
async function buildClip(dir) {
  const colours = ['black', 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray', 'white', 'cyan']
  const args = ['-nostdin', '-v', 'error', '-y']
  for (const colour of colours) args.push('-f', 'lavfi', '-i', `color=c=${colour}:s=320x240:d=1,format=yuv420p`)
  args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2')
  args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1')
  args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=7,volume=0.05')
  const video = colours.map((_, index) => `[${index}:v]`).join('') + `concat=n=${colours.length}:v=1:a=0[v]`
  const audio = `[${colours.length}:a][${colours.length + 1}:a][${colours.length + 2}:a]concat=n=3:v=0:a=1[a]`
  const clip = join(dir, 'known-structure.mp4')
  args.push('-filter_complex', `${video};${audio}`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip)
  await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })
  return clip
}

const CLIP = await buildClip(await mkdtemp(join(tmpdir(), 'goclip-evclip-')))

// 桩件只拦 OSS：证据计算是纯本地的，不该碰网络。
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/chat/completions')) return realFetch(url, init)
  if (init?.method === 'PUT') return new Response('', { status: 200 })
  if (String(url).includes('/index.json')) return new Response(JSON.stringify({ version: 3, projects: [] }), { status: 200 })
  return new Response('not found', { status: 404 })
}

const config = {
  dataDir: await mkdtemp(join(tmpdir(), 'goclip-ev-')),
  modelBaseUrl: 'http://stub.invalid/v1', model: 'stub', apiKeyEnv: 'STUB_ID',
  ossEndpoint: 'e', ossBucket: 'b', ossAccessKeyIdEnv: 'STUB_ID', ossAccessKeySecretEnv: 'STUB_SECRET',
  ossPrefix: 't', ossOutputPrefix: 'o', ossProjectPrefix: 'p', signedUrlSeconds: 900,
  maxImportBytes: 1 << 30, requestTimeoutMs: 5000, modelTimeoutMs: 20000, searchLimit: 50,
  keepSourceFiles: true, keyframeToleranceMs: 500, modelAttempts: 1,
  acousticSampleRate: 8000, acousticWindowMs: 1000, acousticPeakLimit: 20,
  shotSceneThreshold: 0.3, shotMinSeconds: 0.4, shotPacingWindowSeconds: 5, shotBusyLimit: 8,
  silenceMinSeconds: 0.4, silenceNoiseDb: -30,
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
await vw.createProject('pe', '证据测试')
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(join(config.dataDir, 'video-tools.sqlite'))
db.exec('PRAGMA foreign_keys=ON')
db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('ae', 'pe', CLIP, JSON.stringify({ duration_us: 10_000_000 }))
db.close()

// ── 声学：结构是 0-2s 静音 / 2-3s 大声 / 3-10s 轻声 ─────────────────────────
{
  const ev = await vw.acousticEvidence('pe', 'ae', new AbortController().signal)
  const levels = ev.levelsDbfs
  console.log(`      ${levels.length} 个窗口: ${JSON.stringify(levels)}`)
  record('声学：窗口数等于秒数', levels.length === 10, `${levels.length} 个窗口`)
  const loudest = levels.indexOf(Math.max(...levels))
  record('声学：最响的一秒正是放进大声正弦的那一秒（第 2 秒）', loudest === 2, `最响窗口 index=${loudest}`);
  record('声学：响度落在大声正弦的预期值附近（-21 dBFS）', Math.abs(levels[2] - (-21)) < 3, `第 2 秒 = ${levels[2]} dBFS`)
  record('声学：轻声段落在预期值附近（-44.8 dBFS）', levels.slice(3).every(v => Math.abs(v - (-44.8)) < 3), `3-10 秒 = ${JSON.stringify(levels.slice(3))}`)
  record('声学：静音段被报为极低而不是 -Infinity', levels[0] <= -90 && Number.isFinite(levels[0]), `第 0 秒 = ${levels[0]}`)
  record('声学：响亮阈值把大声与轻声分开', ev.loudDbfs > levels[3] && ev.loudDbfs <= levels[2], `loudDbfs=${ev.loudDbfs}，轻声=${levels[3]}，大声=${levels[2]}`)
  record('声学：peaks 指向最响窗口且给出相对基底的抬升', ev.peaks[0]?.index === 2 && ev.peaks[0]?.riseDb > 0, `首条 peak=${JSON.stringify(ev.peaks[0])}`)
  record('声学：缓存命中时不重复计算', (await vw.acousticEvidence('pe', 'ae', new AbortController().signal)).cached === true, '第二次调用 cached=true')
}

// ── 镜头：每 1 秒换一次纯色，预期 9-10 个镜头、切点落在整秒上 ──────────────
{
  const ev = await vw.shotEvidence('pe', 'ae', new AbortController().signal)
  console.log(`      ${ev.shots.length} 个镜头: ${JSON.stringify(ev.shots.map(s => [s.startUs / 1e6, s.endUs / 1e6]))}`)
  record('镜头：切点数量接近预期的 8 个', ev.cut_count >= 6 && ev.cut_count <= 10, `cut_count=${ev.cut_count}`)
  const onSecond = ev.shots.slice(1).every(s => Math.abs((s.startUs / 1e6) - Math.round(s.startUs / 1e6)) < 0.15)
  record('镜头：切点落在整秒附近（画面每秒换色）', onSecond, `切点=${JSON.stringify(ev.shots.slice(1).map(s => Math.round(s.startUs / 1e6 * 100) / 100))}`)
  record('镜头：中位镜头长度接近 1 秒', Math.abs(ev.medianSeconds - 1) < 0.4, `medianSeconds=${ev.medianSeconds}`)
  record('镜头：节奏曲线给出有切点的窗口', ev.busiest.length > 0 && ev.busiest[0].cuts >= 1, `最密窗口=${JSON.stringify(ev.busiest[0])}`)
  record('镜头：切点数与镜头数自洽', ev.cut_count === ev.shots.length - 1, `cut_count=${ev.cut_count}，shots=${ev.shots.length}`)
}

// ── 时序：开头有 2 秒静音，去掉后应剩 8 秒 ─────────────────────────────────
{
  const ev = await vw.timingEvidence('pe', 'ae', new AbortController().signal)
  console.log(`      静音段: ${JSON.stringify(ev.silences)}`)
  console.log(`      保留区间: ${JSON.stringify(ev.kept_intervals)}`)
  record('时序：检测到开头的静音段', ev.silence_count >= 1 && ev.silences.some(s => s.startUs === 0 && s.endUs > 1_000_000),
    `${ev.silence_count} 段，首段=${JSON.stringify(ev.silences[0])}`)
  const keptSeconds = ev.kept_intervals.reduce((sum, i) => sum + (i.endUs - i.startUs), 0) / 1e6
  const removedSeconds = ev.silenced_us / 1e6
  record('时序：保留 + 去掉 = 全片时长', Math.abs(keptSeconds + removedSeconds - 10) < 0.3,
    `保留 ${keptSeconds.toFixed(2)}s + 去掉 ${removedSeconds.toFixed(2)}s = ${(keptSeconds + removedSeconds).toFixed(2)}s`)
  // 关键：只有开头 2 秒是真的静音。轻声段是内容（-44.8 dBFS），不是停顿 ——
  // 用固定分贝阈值时它会被整段删掉，留下 1 秒；这条断言就是防那个回归的。
  record('时序：只删真正的静音，不误删轻声内容（保留 ≈8 秒）', keptSeconds > 7.5 && keptSeconds < 8.5,
    `保留 ${keptSeconds.toFixed(2)}s（预期 ≈8s；若为 ≈1s 说明阈值把轻声内容当成了停顿）`)
  record('时序：静音段只有开头那一段', ev.silence_count === 1 && ev.silences[0].startUs === 0,
    `${ev.silence_count} 段：${JSON.stringify(ev.silences)}`)
}

// ── 可核验：证据要能换回一段能看能听的片段 ──────────────────────────────────
{
  const clip = await vw.evidenceClip({ project_id: 'pe', asset_id: 'ae', start_us: 2_000_000, end_us: 3_000_000, filename: 'check.mp4' }, new AbortController().signal)
  record('证据区间能换回可核对的片段',
    clip.seconds === 1 && clip.oss_key.endsWith('.mp4') && clip.bytes > 0,
    `${clip.seconds}s / ${clip.kilobytes} KB → ${clip.oss_key.split('/').pop()}`)
  record('片段区间与请求一致', clip.start_us === 2_000_000 && clip.end_us === 3_000_000,
    `${clip.start_us / 1e6}s–${clip.end_us / 1e6}s`)
  // 上限必须真的生效：否则"取一段核对"会变成往桶里放第二份素材。
  const long = await vw.evidenceClip({ project_id: 'pe', asset_id: 'ae', start_us: 0, end_us: 10_000_000, filename: 'long.mp4' }, new AbortController().signal)
  record('片段长度受上限约束并说明被截断', long.seconds === 10 && long.clamped_to_max_seconds === null,
    `${long.seconds}s，clamped=${long.clamped_to_max_seconds}（默认上限 60 秒，本素材只有 10 秒）`)
  const tiny = new VideoWorkspace({ ...config, excerptMaxSeconds: 2 })
  const cut = await tiny.evidenceClip({ project_id: 'pe', asset_id: 'ae', start_us: 0, end_us: 10_000_000, filename: 'cut.mp4' }, new AbortController().signal)
  record('上限较小时确实截断并说明原因', cut.seconds === 2 && cut.clamped_to_max_seconds === 2,
    `${cut.seconds}s，note=${cut.note.slice(0, 40)}`)
  tiny.dispose()
  let bad = false
  try { await vw.evidenceClip({ project_id: 'pe', asset_id: 'ae', start_us: 5000, end_us: 1000 }, new AbortController().signal) }
  catch { bad = true }
  record('区间倒置时拒绝', bad, bad ? '明确拒绝' : '没有拦住')
}

vw.dispose()

console.log('\n' + '='.repeat(64))
const bad = results.filter(r => !r.ok)
console.log(`共 ${results.length} 项，问题 ${bad.length} 项`)
for (const b of bad) console.log(`  · ${b.name}：${b.detail}`)
