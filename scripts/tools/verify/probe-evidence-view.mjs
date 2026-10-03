/**
 * The evidence overview, measured against a clip whose structure is known.
 *
 * The panel is drawn entirely from this one payload, so an assertion about it is
 * an assertion about what a user can see: a dimension that arrives with null
 * timestamps is a track that silently renders empty while its own count still
 * claims otherwise.
 *
 * The fixture is the same known-structure clip `probe-evidence` measures: ten
 * one-second colours (nine cuts) and audio that is silent, then loud, then quiet.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const RUNTIME = process.argv[2]
const run = promisify(execFile)

/**
 * Build the measured clip.
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
  const clip = join(dir, 'view-structure.mp4')
  args.push('-filter_complex', `${video};${audio}`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip)
  await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })
  return clip
}

const CLIP = await buildClip(await mkdtemp(join(tmpdir(), 'goclip-viewclip-')))

// OSS is stubbed: this measures assembly, not persistence.
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/chat/completions')) return realFetch(url, init)
  if (init?.method === 'PUT') return new Response('', { status: 200 })
  if (String(url).includes('/index.json')) return new Response(JSON.stringify({ version: 3, projects: [] }), { status: 200 })
  return new Response('not found', { status: 404 })
}

// The database lives at `<dataDir>/video-tools.sqlite`; the fixture is seeded through
// the same handle the workspace opens, so `dataDir` has to be a named value.
const DATA_DIR = await mkdtemp(join(tmpdir(), 'goclip-view-'))
const config = {
  dataDir: DATA_DIR,
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
await vw.createProject('pv', '证据总览')
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(join(DATA_DIR, 'video-tools.sqlite'))
db.exec('PRAGMA foreign_keys=ON')
db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('av', 'pv', CLIP, JSON.stringify({ duration_us: 10_000_000 }))
db.close()

const signal = new AbortController().signal
await vw.acousticEvidence('pv', 'av', signal)
await vw.shotEvidence('pv', 'av', signal)
const timing = await vw.timingEvidence('pv', 'av', signal)

// A timeline whose first segment is this asset and remaining effort is spent on a
// second, absent asset: the view must flag the off-axis segment rather than place
// it as if it belonged to this recording.
await vw.createTimeline({ id: 'tv', project_id: 'pv', asset_id: 'av', start_us: 0, end_us: 3_000_000, name: '总览用' })
{
  const db2 = new DatabaseSync(join(DATA_DIR, 'video-tools.sqlite'))
  db2.exec('PRAGMA foreign_keys=ON')
  db2.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('other', 'pv', CLIP, JSON.stringify({ duration_us: 5_000_000 }))
  db2.close()
}
await vw.addSegment({ timeline_id: 'tv', base_revision: 1, asset_id: 'other', start_us: 0, end_us: 2_000_000 })

const view = await vw.evidenceView('pv', 'av', 'tv')
const d = view.dimensions

// 本素材只算过声学/镜头/时序。总览必须把这三维装进来，并把没算过的三维
// **如实列进 missing** —— 声称六维齐全而实际只画得出一半，正是面板最不该犯的错。
record('总览装进已算过的维度，并把没算过的如实列出',
  view.missing.length === 3
  && ['transcript', 'screen-text', 'scene-description'].every(k => view.missing.includes(k))
  && d.loudness !== null && d.shots.length > 0 && d.silences.length > 0,
  `缺失=${JSON.stringify(view.missing)}，计数=${JSON.stringify(view.counts)}`)

record('时长与素材一致', view.duration_us === 10_000_000,
  `${view.duration_us / 1e6}s`)

// ── 停顿：整条链路上最容易静默失效的一维 ────────────────────────────────────
//
// 时序证据的 payload 用 camelCase（startUs），而面板读的是 start_us。读错字段名时
// 每个停顿都变成 {start_us: null, ...}：面板画不出停顿，counts 却仍报 1，看上去
// 像是有数据。所以这里不看条数，只看值。
{
  const spans = d.silences
  const allNumeric = spans.every(s =>
    Number.isFinite(s.start_us) && Number.isFinite(s.end_us)
    && Number.isFinite(s.start) && Number.isFinite(s.end))
  record('停顿带有可用的时间戳（不是 null）', spans.length > 0 && allNumeric,
    JSON.stringify(spans))
  record('停顿条数与时序证据一致', spans.length === timing.silences.length,
    `总览 ${spans.length} 条 vs 证据 ${timing.silences.length} 条`)
  const inside = spans.every(s => s.start_us >= 0 && s.end_us <= view.duration_us && s.end_us > s.start_us)
  record('停顿区间落在素材长度内且非空', inside,
    spans.map(s => `${(s.start_us / 1e6).toFixed(2)}–${(s.end_us / 1e6).toFixed(2)}s`).join(', '))
  record('停顿的归一化位置与绝对时间对得上',
    spans.every(s => Math.abs(s.start - s.start_us / view.duration_us) < 0.0002),
    spans.map(s => `${s.start_us}→${s.start}`).join(', '))
}

// ── 镜头 ────────────────────────────────────────────────────────────────────
{
  const shots = d.shots
  record('镜头全部带数值区间', shots.every(s => Number.isFinite(s.start_us) && Number.isFinite(s.end_us)),
    `${shots.length} 个镜头`)
  record('镜头首段从 0 开始、末段到素材结尾',
    shots[0].start_us === 0 && shots[shots.length - 1].end_us === view.duration_us,
    `${shots[0].start_us} … ${shots[shots.length - 1].end_us}`)
  const monotonic = shots.every((s, i) => i === 0 || s.start_us >= shots[i - 1].start_us)
  record('镜头按时间顺序排列', monotonic, '时间递增')
}

// ── 响度 ────────────────────────────────────────────────────────────────────
{
  const loud = d.loudness
  const samples = loud.samples
  record('响度样本数与窗口数一致', samples.length === view.counts.loudness_samples,
    `${samples.length} 个样本`)
  record('响度样本都在合理分贝范围内',
    samples.every(s => s.db <= 0 && s.db >= -100),
    `最低 ${Math.min(...samples.map(s => s.db))} / 最高 ${Math.max(...samples.map(s => s.db))} dBFS`)
  // 字段名是这条链路上真正的契约：面板读的是 **snake_case**（floor_dbfs）。
  // 早先按 camelCase 断言过一次，结果断言永远"通过"而面板拿不到量程 ——
  // 所以这里断的是键名本身，不是键名错时也恰好成立的东西。
  const hasSnakeCaseLevels = ['floor_dbfs', 'peak_dbfs', 'loud_dbfs'].every(k => k in loud)
  const noCamelCaseLevels = ['floorDbfs', 'peakDbfs', 'loudDbfs'].every(k => !(k in loud))
  record('响度量程以面板读取的字段名给出（snake_case）',
    hasSnakeCaseLevels && noCamelCaseLevels,
    `键=${JSON.stringify(Object.keys(loud))}`)
  record('响度曲线自带量程，且量程自洽',
    Number.isFinite(loud.floor_dbfs) && Number.isFinite(loud.peak_dbfs) && Number.isFinite(loud.loud_dbfs)
    && loud.peak_dbfs >= loud.floor_dbfs
    && samples.every(s => s.db >= loud.floor_dbfs - 0.001 && s.db <= loud.peak_dbfs + 0.001),
    `${loud.floor_dbfs} … ${loud.peak_dbfs} dBFS（响阈值 ${loud.loud_dbfs}）`)
  record('响度位置是 0–1 的归一化值',
    samples.every(s => s.at >= 0 && s.at <= 1) && samples[0].at === 0,
    `首个 ${samples[0].at}，末个 ${samples[samples.length - 1].at}`)
  // 曲线只有配上它自己的量程才能读：固定阈值会把动态小的素材标出一片假峰值。
  record('响度位置与窗口时长对得上',
    Math.abs(samples[1].at - loud.window_us / view.duration_us) < 0.0002,
    `第二个样本在 ${samples[1].at}，窗口 ${loud.window_us}µs`)
}

// ── 文本轨 ──────────────────────────────────────────────────────────────────
//
// 本素材只算过声学/镜头/时序，三条文本轨必须**空**：编造出内容比不画更糟，
// 因为它看上去像证据。
{
  record('没有转写证据时如实报空，而不是编造',
    d.transcript.length === 0 && view.counts.transcript_lines === 0,
    `转写 ${d.transcript.length} 条（本素材没有跑过语音转写）`)
  record('没有屏幕文字证据时如实报空',
    d.screen_text.length === 0 && view.counts.screen_text_entries === 0,
    `屏文字 ${d.screen_text.length} 条`)
  record('没有画面描述证据时如实报空',
    d.scenes.length === 0 && view.counts.scenes === 0 && d.chapters.length === 0,
    `画面 ${d.scenes.length} 条 / 章节 ${d.chapters.length} 条`)
}

// ── 时间线同轴 ──────────────────────────────────────────────────────────────
{
  const segments = view.timeline.segments
  const onAxis = segments.filter(s => s.on_this_axis)
  const offAxis = segments.filter(s => !s.on_this_axis)
  record('时间线片段全部带序号与数值区间',
    segments.every(s => Number.isInteger(s.ordinal) && Number.isFinite(s.start_us) && Number.isFinite(s.end_us)),
    `${segments.length} 段`)
  record('属于别的素材的片段被标为不在本轴上', offAxis.length === 1 && onAxis.length === 1,
    `同轴 ${onAxis.length} 段 / 异轴 ${offAxis.length} 段`)
  record('每个时间线片段都带 on_this_axis 判定',
    segments.every(s => typeof s.on_this_axis === 'boolean'),
    JSON.stringify(segments.map(s => s.on_this_axis)))
}

// ── 计数与缺项自洽 ──────────────────────────────────────────────────────────
{
  const c = view.counts
  record('计数与各维度实际条数一致',
    c.shots === d.shots.length && c.silences === d.silences.length
    && c.transcript_lines === d.transcript.length && c.screen_text_entries === d.screen_text.length
    && c.scenes === d.scenes.length && c.chapters === d.chapters.length,
    JSON.stringify(c))
  record('缺项列表只列真的没有的维度',
    view.missing.length === 3 && !view.missing.includes('acoustic-loudness')
    && !view.missing.includes('shot-boundaries') && !view.missing.includes('silence-timing'),
    `缺失=${JSON.stringify(view.missing)}（本素材声学/镜头/时序都已算过）`)
  record('总览说明这是给面板用的数据', typeof view.note === 'string' && view.note.length > 0,
    view.note.slice(0, 40))
}

// ── 缺维度时如实说明 ────────────────────────────────────────────────────────
{
  const BARE_DIR = await mkdtemp(join(tmpdir(), 'goclip-bare-'))
  const bare = new VideoWorkspace({ ...config, dataDir: BARE_DIR })
  await bare.createProject('pb', '空素材')
  const db3 = new DatabaseSync(join(BARE_DIR, 'video-tools.sqlite'))
  db3.exec('PRAGMA foreign_keys=ON')
  db3.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('ab', 'pb', CLIP, JSON.stringify({ duration_us: 10_000_000 }))
  db3.close()
  const empty = await bare.evidenceView('pb', 'ab')
  record('一点证据都没有时，六个维度全部列进缺失',
    empty.missing.length === 6 && empty.dimensions.loudness === null
    && empty.dimensions.shots.length === 0 && empty.dimensions.silences.length === 0,
    `缺失=${JSON.stringify(empty.missing)}`)
  record('没有证据时仍然给出时长，面板能画出空轴',
    empty.duration_us === 10_000_000 && empty.timeline === null,
    `${empty.duration_us / 1e6}s，timeline=${empty.timeline}`)
  bare.dispose()
}

vw.dispose()

console.log('\n' + '='.repeat(64))
const bad = results.filter(r => !r.ok)
console.log(`共 ${results.length} 项，问题 ${bad.length} 项`)
for (const b of bad) console.log(`  · ${b.name}：${b.detail}`)
