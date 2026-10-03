/**
 * Temporal precision: pulling an approximate range onto the recording's own edges.
 *
 * The clip has known shot boundaries at whole seconds and a known loudness step, so a
 * range that lands slightly off a boundary can be checked to snap to the right place,
 * and a range that lands far from any boundary can be checked to stay put. Both outcomes
 * matter: snapping more is not better if it moves a range away from what was asked for.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const RUNTIME = process.argv[2]
const run = promisify(execFile)

/**
 * Ten one-second colours with silence, then a loud tone, then a quiet tone.
 *
 * Shots therefore change exactly at whole seconds and the level step sits at 2 s.
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
  const clip = join(dir, 'precision-source.mp4')
  args.push('-filter_complex', `${video};${audio}`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip)
  await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })
  return clip
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/chat/completions')) return realFetch(url, init)
  if (init?.method === 'PUT') return new Response('', { status: 200 })
  return new Response(JSON.stringify({ version: 5, projects: [] }), { status: 200 })
}

const dir = await mkdtemp(join(tmpdir(), 'goclip-precision-'))
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
  loudnessMatch: false, loudnessTargetDbfs: -16, refineToleranceSeconds: 1.5,
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
await vw.createProject('pz', '精度测试')
const { DatabaseSync } = await import('node:sqlite')
const raw = new DatabaseSync(join(dir, 'video-tools.sqlite'))
raw.exec('PRAGMA foreign_keys=ON')
raw.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('az', 'pz', clip, JSON.stringify({ duration_us: 10_000_000 }))
raw.close()
await vw.shotEvidence('pz', 'az', new AbortController().signal)
await vw.acousticEvidence('pz', 'az', new AbortController().signal)

// refineRange 是 private；通过公开的 find 走不到模型，所以这里直接量它的行为。
const refine = (startUs, endUs, toleranceUs = 1_500_000) => vw.refineRange('az', startUs, endUs, toleranceUs)

// ── 靠近镜头边界就吸附 ──────────────────────────────────────────────────────
{
  const near = await refine(3_200_000, 6_800_000)
  record('起点靠近镜头边界时吸附过去', near.start_us === 3_000_000 && near.adjustments.some(a => a.edge === 'start'),
    `起 3.2s → ${near.start_us / 1e6}s，来源=${near.adjustments.find(a => a.edge === 'start')?.source}`)
  record('终点靠近镜头边界时吸附过去', near.end_us === 7_000_000,
    `终 6.8s → ${near.end_us / 1e6}s`)
  record('吸附后报告移动了多少', near.snapped === true && Math.abs(near.snapped_us - 400_000) < 1,
    `共移动 ${near.snapped_us / 1e6}s`)
}

// ── 远离任何边界就不动（吸附更多不等于更好）─────────────────────────────────
{
  // 容差 0.1 秒时，0.2 秒的偏差已经超出容差，两端都该保持原样。
  const far = await refine(3_200_000, 6_800_000, 100_000)
  record('超出容差时区间保持原样', far.snapped === false && far.start_us === 3_200_000 && far.end_us === 6_800_000,
    `未移动：${far.start_us / 1e6}s–${far.end_us / 1e6}s`)
  // 断言要点：文案必须说清是"容差内没有边界"，而不是把"没边界"说成"已在边界上"。
  record('未移动时说明真实原因（容差内没边界）',
    typeof far.note === 'string' && far.note.includes('都没有物理边界') && !far.note.includes('本来就在'),
    far.note)
}

// ── 响度突变点也是边界：第 2 秒静音转大声 ───────────────────────────────────
{
  const level = await refine(2_400_000, 8_000_000)
  const sources = (level.adjustments ?? []).map(a => a.source)
  // 本素材每秒都有镜头边界，且比响度突变点更近，所以实际选中的是镜头边界。
  // 这里如实断言"吸附到了 2s"，并说明选中了哪一类边界，不假装是响度起的作用。
  record('2.4s 吸附到 2s（本素材最近的是镜头边界）',
    level.start_us === 2_000_000 && Array.isArray(sources) && sources.length > 0,
    `起 2.4s → ${level.start_us / 1e6}s，选中来源=${JSON.stringify(sources)}（该素材每秒一切，镜头边界比响度突变点更近）`)
}

// ── 两端撞到同一处时必须退回原区间（宁可不准也不能为空）────────────────────
{
  const collapse = await refine(4_900_000, 5_100_000, 1_500_000)
  record('吸附会把区间弄空时退回原值', collapse.snapped === false && collapse.start_us === 4_900_000 && collapse.end_us === 5_100_000,
    `两端都指向 5s，已保留原区间：${collapse.start_us / 1e6}s–${collapse.end_us / 1e6}s，note=${collapse.note}`)
}

// ── 没有证据时如实说没有，而不是假装吸附过 ──────────────────────────────────
{
  const bareDir = await mkdtemp(join(tmpdir(), 'goclip-bare-'))
  const bare = new VideoWorkspace({ ...config, dataDir: bareDir })
  await bare.createProject('pb', '无证据')
  const { DatabaseSync: DS } = await import('node:sqlite')
  const raw2 = new DS(join(bareDir, 'video-tools.sqlite'))
  raw2.exec('PRAGMA foreign_keys=ON')
  raw2.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('ab', 'pb', clip, JSON.stringify({ duration_us: 10_000_000 }))
  raw2.close()
  const none = await bare.refineRange('ab', 3_200_000, 6_800_000, 1_500_000)
  record('没有证据时保持原样并说明该先算什么', none.snapped === false && none.note.includes('video_evidence_shots'),
    none.note)
  bare.dispose()
}

vw.dispose()
console.log('\n' + '='.repeat(64))
const bad = results.filter(r => !r.ok)
console.log(`共 ${results.length} 项，问题 ${bad.length} 项`)
for (const b of bad) console.log(`  · ${b.name}：${b.detail}`)
