/**
 * 直接加载已编译的插件运行时，用网络桩件确定性地验证可疑行为。
 *
 * 全程不碰真实 OSS：fetch 被替换成桩件，只记录调用并返回成功。
 *
 * 验证项：
 *   1. replaceTimeline 是否校验 end_us > start_us
 *   2. search 的匹配范围（是否误命中字段名与 JSON 语法）
 *   3. jobs 是否按项目过滤
 *   4. import 在失败时是否保住用户源文件
 *   5. import 是否有文件体积上限
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { checkBundleFreshness } from './bundle-freshness.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNTIME = process.argv[2]

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅ 通过' : '❌ 问题'}  ${name}`)
  console.log(`        ${detail}`)
}


// ── 网络桩件：记录每次 OSS 调用，绝不发到真实网络 ────────────────────────────
const calls = []
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  calls.push({ url: u.slice(0, 120), method: init.method ?? 'GET', streamed: init.body instanceof ReadableStream })
  if (u.includes('/index.json') && (init.method ?? 'GET') === 'GET') {
    return new Response(JSON.stringify({ version: 1, projects: [] }), { status: 200 })
  }
  return new Response('', { status: 200 })
}

process.env.STUB_ID = 'stub-id'
process.env.STUB_SECRET = 'stub-secret'

const dataDir = await mkdtemp(join(tmpdir(), 'goclip-probe-'))
const config = {
  dataDir,
  modelBaseUrl: 'http://stub.invalid/v1',
  model: 'stub',
  apiKeyEnv: 'STUB_ID',
  ossEndpoint: 'oss-cn-beijing.aliyuncs.com',
  ossBucket: 'stub-bucket-does-not-exist',
  ossAccessKeyIdEnv: 'STUB_ID',
  ossAccessKeySecretEnv: 'STUB_SECRET',
  ossPrefix: 'goclip-temporary',
  ossOutputPrefix: 'goclip-exports',
  ossProjectPrefix: 'goclip-projects',
  signedUrlSeconds: 900, requestTimeoutMs: 5000, modelTimeoutMs: 20000, requestTimeoutMs: 5000, modelTimeoutMs: 20000,
}

const { VideoWorkspace } = await import(RUNTIME)
const vw = new VideoWorkspace(config)

// ── 长视频分片：10 分钟以内保持一次调用，超过后按 5 分钟 + 8 秒重叠 ─────
{
  const short = vw.modelWindows(599 * 1e6)
  record('短视频不分片（阈值 10 分钟）', short.length === 1 && short[0].startUs === 0 && short[0].endUs === 599 * 1e6,
    `窗口=${JSON.stringify(short)}`)
  const long = vw.modelWindows(720 * 1e6)
  const expected = [[0, 300], [292, 592], [584, 720]]
  record('长视频按 5 分钟、8 秒重叠分片', long.length === expected.length && long.every((w, i) => w.startUs === expected[i][0] * 1e6 && w.endUs === expected[i][1] * 1e6),
    `窗口=${JSON.stringify(long.map(w => [w.startUs / 1e6, w.endUs / 1e6]))}`)
  const merged = vw.dedupeRanges([
    { start_us: 290 * 1e6, end_us: 300 * 1e6, text: '边界字幕' },
    { start_us: 292 * 1e6, end_us: 300 * 1e6, text: '边界字幕' },
  ], 'text')
  record('重叠分片的相同文字只保留一条', merged.length === 1, `合并后 ${merged.length} 条`)
}

// ── 准备数据（绕过 OSS：直接写本地库）────────────────────────────────────────
await vw.createProject('p1', '项目一')
await vw.createProject('p2', '项目二')
const { DatabaseSync } = await import('node:sqlite')
{
  const db = new DatabaseSync(join(dataDir, 'video-tools.sqlite'))
  db.prepare('INSERT OR REPLACE INTO assets VALUES (?,?,?,?)')
    .run('a1', 'p1', 'oss://goclip-projects/p1/assets/a1/source.mp4', JSON.stringify({ duration_us: 10000000 }))
  db.prepare('INSERT OR REPLACE INTO assets VALUES (?,?,?,?)')
    .run('a2', 'p2', 'oss://goclip-projects/p2/assets/a2/source.mp4', JSON.stringify({ duration_us: 9000000 }))
  db.prepare('INSERT OR REPLACE INTO analyses VALUES (?,?,?,?)').run('a1', '完整理解内容', JSON.stringify({
    summary: '一段风景视频',
    segments: [
      { start_us: 0, end_us: 2000000, visual: '海边日落', audio: '海浪声', tags: ['风景'], confidence: 0.9 },
      { start_us: 3000000, end_us: 5000000, visual: '一只猫', audio: '安静', tags: ['动物'], confidence: 0.42 },
    ],
  }), Date.now())
  db.prepare('INSERT OR REPLACE INTO analyses VALUES (?,?,?,?)').run('a2', '完整理解内容', JSON.stringify({
    summary: '另一段', segments: [{ start_us: 0, end_us: 1000000, visual: '室内', audio: '说话', tags: ['口播'], confidence: 0.8 }],
  }), Date.now())
  db.prepare('INSERT INTO timelines (id,name,project_id,asset_id,start_us,end_us,revision) VALUES (?,?,?,?,?,?,?)').run('t1', null, 'p1', 'a1', 0, 2000000, 1)
  db.prepare('INSERT INTO timelines (id,name,project_id,asset_id,start_us,end_us,revision) VALUES (?,?,?,?,?,?,?)').run('t2', null, 'p2', 'a2', 0, 1000000, 1)
  db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('j1', 't1', 'completed', 'oss://x', '')
  db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('j2', 't2', 'completed', 'oss://y', '')
  db.close()
}

for (const f of [checkBundleFreshness(RUNTIME)]) record(f.name, f.ok, f.detail)

let n = 0
console.log('\n' + '─'.repeat(64))

// ── 1) replaceTimeline 的时间范围校验 ───────────────────────────────────────
{
  let accepted = false, detail = ''
  try {
    const r = await vw.replaceTimeline({ timeline_id: 't1', base_revision: 1, asset_id: 'a1', start_us: 8000000, end_us: 3000000 })
    accepted = true
    detail = `接受了非法范围（start 8s > end 3s），返回 revision=${r.revision}`
  } catch (e) { detail = `拒绝了：${e.message}` }
  record('replaceTimeline 拒绝 end_us <= start_us', !accepted, detail)
}
{
  let accepted = false, detail = ''
  try {
    await vw.createTimeline({ id: 't-bad', project_id: 'p1', asset_id: 'a1', start_us: 8000000, end_us: 3000000 })
    accepted = true; detail = '接受了非法范围'
  } catch (e) { detail = `拒绝了：${e.message}` }
  record('（对照）createTimeline 拒绝 end_us <= start_us', !accepted, detail)
}

// ── 2) search 的匹配范围与排序 ──────────────────────────────────────────────
// search 返回结构化结果：{ matches, match_count, truncated, limit }
// 空查询走的是早退分支，返回的是空数组，所以这里要能接受两种形状。
const found = result => (Array.isArray(result) ? result[0]?.matches ?? [] : [])
{
  const hit = await vw.search('p1', 'confidence')
  record('search 不因字段名 confidence 而命中', found(hit).length === 0,
    found(hit).length ? `命中 ${found(hit).length} 段：${JSON.stringify(found(hit).map(s => s.visual))}` : '未命中（正确）')
}
{
  const hit = await vw.search('p1', '海边')
  record('search 能命中 visual 里的内容', found(hit).length === 1, `命中 ${found(hit).length} 段`)
}
{
  const hit = await vw.search('p1', '海')
  record('search 能命中 tags/audio 等字段', found(hit).length >= 1, `命中 ${found(hit).length} 段`)
}
{
  const hit = await vw.search('p1', '0.9')
  record('search 不因置信度数字而命中', found(hit).length === 0,
    found(hit).length ? `命中 ${found(hit).length} 段（数字被当内容匹配）` : '未命中（正确）')
}
{
  const hit = await vw.search('p1', '   ')
  record('search 空查询返回空', found(hit).length === 0, `返回 ${hit.length} 项，matches=${found(hit).length}`)
}
{
  // 相关性排序：tag 精确命中要排在宽松子串命中之前
  const hit = await vw.search('p1', '风景')
  const matches = found(hit)
  record('search 按相关性排序（tag 精确命中在前）', matches.length >= 1 && matches[0].visual === '海边日落',
    `首条=${matches[0]?.visual}（tags=${JSON.stringify(matches[0]?.tags)}）`)
  record('search 回报真实命中总数', hit[0].match_count === matches.length,
    `match_count=${hit[0].match_count}，返回 ${matches.length} 条`)
  record('search 未截断时 truncated=false', hit[0].truncated === false, `truncated=${hit[0].truncated}`)
}
{
  // 结果上限要针对性的数据：临时加一个也含「海」的片段，让同一查询命中 2 段
  const dir = config.dataDir
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  raw.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('a-many', 'p1', 'oss://goclip-projects/p1/assets/a-many/source.mp4', JSON.stringify({ duration_us: 5000000 }))
  raw.prepare('INSERT INTO analyses VALUES (?,?,?,?)').run('a-many', '完整理解内容', JSON.stringify({ summary: '海边', segments: [{ start_us: 0, end_us: 1000000, visual: '海边', audio: '', tags: [], confidence: 0.1 }] }), Date.now())
  raw.close()

  // 用临时实例，避免代理缓存等状态互相影响
  const total = (await vw.search('p1', '海'))[0].match_count
  const tiny = new VideoWorkspace({ ...config, searchLimit: 1 })
  const hit = await tiny.search('p1', '海')
  record('search 遵守结果上限并标记截断', total > 1 && found(hit).length === 1 && hit[0].truncated === true && hit[0].match_count === total,
    `该查询共 ${total} 段命中；limit=1 时返回 ${found(hit).length} 条，match_count=${hit[0]?.match_count}，truncated=${hit[0]?.truncated}`)
  tiny.dispose()
}

// ── 3) jobs 的项目过滤 ──────────────────────────────────────────────────────
{
  const all = await vw.jobs()
  const onlyP1 = await vw.jobs('p1')
  const onlyP2 = await vw.jobs('p2')
  record('jobs 不传项目时返回全部（兼容旧行为）', all.length === 2, `返回 ${all.length} 条`)
  record('jobs 传 project_id 时只返回该项目', onlyP1.length === 1 && onlyP2.length === 1,
    `p1 → ${onlyP1.length} 条；p2 → ${onlyP2.length} 条`)
}

// ── 4) import 失败时是否保住用户源文件 ──────────────────────────────────────
{
  const src = join(dataDir, 'user-original.mp4')
  await writeFile(src, Buffer.alloc(4096, 7))
  // 让上传失败：桩件对 PUT 返回 500
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'PUT') return new Response('boom', { status: 500 })
    return realFetch(url, init)
  }
  let threw = ''
  try { await vw.import('p1', src) } catch (e) { threw = e.message.slice(0, 50) }
  globalThis.fetch = realFetch
  record('import 上传失败时不删用户源文件', existsSync(src),
    existsSync(src) ? `源文件仍在（抛错：${threw}）` : `❌ 源文件已被删除（抛错：${threw}）`)
}

// ── 5) import 的体积上限 ────────────────────────────────────────────────────
{
  // 直接用一个小上限的实例，验证超限会被拒绝而不是先读进内存
  const small = new VideoWorkspace({ ...config, dataDir: await mkdtemp(join(tmpdir(), 'goclip-small-')), maxImportBytes: 1024 })
  const src = join(dataDir, 'too-big.mp4')
  await writeFile(src, Buffer.alloc(4096, 3))
  let threw = ''
  try { await small.import('p1', src) } catch (e) { threw = e.message }
  const rejected = threw.includes('import limit')
  record('import 拒绝超过上限的文件', rejected, rejected ? `拒绝了：${threw}` : `未拒绝（抛错：${threw || '无'}）`)
  record('import 超限时不动源文件', existsSync(src), existsSync(src) ? '源文件仍在' : '❌ 源文件被删')
}

// ── 5b) keepSourceFiles 开关的两种取值 ──────────────────────────────────────
// 开关测的是「上传成功之后」的行为，所以必须用真视频 —— 假文件会在 probe() 就失败，
// 根本走不到删除那一步，那样测的其实是别的东西。
const realVideo = join(config.dataDir, 'real-clip.mp4')
{
  const { execFile: exec } = await import('node:child_process')
  const { promisify: prom } = await import('node:util')
  await prom(exec)('ffmpeg', ['-nostdin','-y','-f','lavfi','-i','testsrc=size=160x120:rate=10:duration=1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p', realVideo])
}
{
  const dir = await mkdtemp(join(tmpdir(), 'goclip-keep-'))
  const src = join(dir, 'keep-me.mp4')
  await (await import('node:fs/promises')).copyFile(realVideo, src)
  const keeping = new VideoWorkspace({ ...config, dataDir: dir, keepSourceFiles: true, maxImportBytes: 1 << 20 })
  // 素材必须挂在真实存在的项目下（外键会拦），临时目录里的库要先建项目。
  await keeping.createProject('p1', '导入测试')
  let result = null
  let threw = ''
  try { result = await keeping.import('p1', src) } catch (e) { threw = e.message }
  const survived = existsSync(src)
  record('keepSourceFiles=true 时保留源文件', result !== null && survived && result.source_kept === true,
    result ? `source_kept=${result.source_kept}，源文件仍在=${survived}` : `抛错：${threw}`)
  record('返回值说明源文件去向', typeof result?.source_note === 'string' && result.source_note.length > 0,
    `source_note=${JSON.stringify(result?.source_note?.slice(0, 50))}`)
  keeping.dispose()
}
{
  const dir = await mkdtemp(join(tmpdir(), 'goclip-drop-'))
  const src = join(dir, 'drop-me.mp4')
  await (await import('node:fs/promises')).copyFile(realVideo, src)
  const dropping = new VideoWorkspace({ ...config, dataDir: dir, keepSourceFiles: false, maxImportBytes: 1 << 20 })
  await dropping.createProject('p1', '导入测试')
  let result = null
  let threw = ''
  try { result = await dropping.import('p1', src) } catch (e) { threw = e.message }
  record('keepSourceFiles=false 时删除源文件并如实报告',
    result !== null && !existsSync(src) && result.source_kept === false,
    result ? `source_kept=${result.source_kept}，源文件仍在=${existsSync(src)}` : `抛错：${threw}`)
  dropping.dispose()
}

// ── 5c) 判断类词的标签同义词（让「高光」能找到带同义标签的片段）────────────
{
  const dir = await mkdtemp(join(tmpdir(), 'goclip-syn-'))
  const vw = new VideoWorkspace({ ...config, dataDir: dir })
  await vw.createProject('ps', '同义词测试')
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  raw.exec('PRAGMA foreign_keys=ON')
  raw.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('as', 'ps', 'oss://x', '{"duration_us":10000000}')
  // 片段描述里没有「高光」二字，但标签是同义组里的词
  raw.prepare('INSERT INTO analyses VALUES (?,?,?,?)').run('as', '完整理解内容', JSON.stringify({ segments: [
    { start_us: 0, end_us: 3000000, visual: '游戏团战特效满屏', audio: '', tags: ['高燃'], is_highlight: true, highlight_reason: '视觉冲击强', confidence: 0.9 },
    { start_us: 4000000, end_us: 6000000, visual: '博主平静讲解公式', audio: '', tags: ['讲解'], is_highlight: false, highlight_reason: null, confidence: 0.8 },
  ] }), Date.now())
  raw.close()
  const byWord = await vw.search('ps', '高光')
  const byOwnTag = await vw.search('ps', '高燃')
  record('「高光」按 is_highlight 标注命中', byWord[0].match_count === 1 && byWord[0].matches[0].is_highlight === true,
    `match_count=${byWord[0].match_count}，命中段的 is_highlight=${JSON.stringify(byWord[0].matches.map(m => m.is_highlight))}`)
  record('判断类词不误伤未标注的片段', byWord[0].matches.every(m => m.is_highlight === true),
    `命中 ${byWord[0].matches.length} 段，全部 is_highlight=true`)
  record('描述性词仍走字面匹配', byOwnTag[0].match_count === 1,
    `查「高燃」match_count=${byOwnTag[0].match_count}`)
  // 空 highlight_reason 归一为 null，而不是留空字符串（第二段给的正是空串）
  const blankSeg = (await vw.search('ps', '讲解'))[0].matches[0]
  record('空 highlight_reason 归一为 null', blankSeg.highlight_reason === null,
    `查「讲解」命中的段 highlight_reason=${JSON.stringify(blankSeg.highlight_reason)}`)
  vw.dispose()
}

// ── 5d) 阶段耗时记录 ────────────────────────────────────────────────────────
{
  // 直接调 render，它的阶段不依赖模型（关键帧检测与切段都是本地 ffmpeg）
  const dir = await mkdtemp(join(tmpdir(), 'goclip-stage-'))
  const vw = new VideoWorkspace({ ...config, dataDir: dir })
  await vw.createProject('pt', '阶段测试')
  const src = join(config.dataDir, 'real-clip.mp4')
  const { DatabaseSync: DSS } = await import('node:sqlite')
  const raw = new DSS(join(dir, 'video-tools.sqlite'))
  raw.exec('PRAGMA foreign_keys=ON')
  raw.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('at', 'pt', src, JSON.stringify({ duration_us: 1000000 }))
  raw.close()
  // 走公开 API 建时间线：它同时写下首段。直接插 timelines 会漏掉片段，
  // 而多段模型下"没有片段的时间线"本就是不成立的。
  await vw.createTimeline({ id: 'tt', project_id: 'pt', asset_id: 'at', start_us: 0, end_us: 900000 })
  let stages = null
  let r = null
  try {
    r = await vw.render('tt', undefined, new AbortController().signal)
    stages = r.stages
  } catch (error) {
    // 上传是桩件，应当成功；失败也要记录原因，避免假通过
    console.log(`      render 抛错：${String(error.message).slice(0, 70)}`)
  }
  const named = Array.isArray(stages) ? stages.map(s => s.stage) : []
  const positive = Array.isArray(stages) && stages.every(s => typeof s.ms === 'number' && s.ms >= 0)
  record('工具调用记录了各阶段耗时', named.length >= 3 && positive && named.includes('检查第 1 段关键帧') && named.includes('切第 1/1 段'),
    `阶段：${JSON.stringify(stages)}；segment_count=${r?.segment_count}；duration_seconds=${r?.duration_seconds}`)
  record('lastStages 能读回同一批阶段', (vw.lastStages() ?? []).length === named.length,
    `lastStages 条数=${(vw.lastStages() ?? []).length}`)
  vw.dispose()
}

// ── 6) 新增能力与边界 ──────────────────────────────────────────────────────
{
  const list = await vw.timelinesOf('p1')
  const other = await vw.timelinesOf('p2')
  record('timelinesOf 只返回该项目的时间线', list.length === 1 && other.length === 1,
    `p1 → ${list.length} 条（${list.map(t => t.id)}）；p2 → ${other.length} 条（${other.map(t => t.id)}）`)
  // 区间相同的时间线要标出 duplicate_of，而不是被删掉
  const { DatabaseSync: DSDup } = await import('node:sqlite')
  const dup = new DSDup(join(config.dataDir, 'video-tools.sqlite'))
  dup.prepare('INSERT INTO timelines (id,name,project_id,asset_id,start_us,end_us,revision) VALUES (?,?,?,?,?,?,?)').run('t1-dup', null, 'p1', 'a1', 0, 2000000, 1)
  dup.close()
  const withDup = await vw.timelinesOf('p1')
  const marked = withDup.filter(t => t.duplicate_of !== null)
  record('区间相同的时间线被标注而非删除', withDup.length === 2 && marked.length === 1 && marked[0].duplicate_of === 't1',
    `共 ${withDup.length} 条，标注 ${marked.length} 条：${JSON.stringify(withDup.map(t => [t.id, t.duplicate_of]))}`)
}
{
  // 输出文件名带路径分隔符时不能写到缓存目录之外
  const nasty = [
    ['../../evil.mp4', '相对路径逃逸'],
    ['..\\..\\evil.mp4', '反斜杠逃逸'],
    ['/abs/evil.mp4', '绝对路径'],
    ['', '空名字'],
    ['....//....//x.mp4', '多重点号'],
  ]
  const escapes = []
  for (const [name, label] of nasty) {
    const safe = vw.safeFilename(name)
    if (safe.includes('/') || safe.includes('\\') || safe.startsWith('..') || safe === '') escapes.push(`${label} → "${safe}"`)
  }
  record('输出文件名不能逃出缓存目录', escapes.length === 0,
    escapes.length === 0 ? '五种恶意名字都被消毒' : escapes.join('；'))
}
{
  // 模型给的区间要过滤掉越界与反向
  const duration = 10_000_000
  const raw = [
    { start_us: 0, end_us: 1_000_000 },
    { start_us: 8_000_000, end_us: 30_000_000 },
    { start_us: 5_000_000, end_us: 3_000_000 },
    { start_us: -1, end_us: 1_000_000 },
    { start_us: 20_000_000, end_us: 21_000_000 },
    { start_us: 'x', end_us: 1 },
    null,
    { start_us: 1_000_000, end_us: 2_000_000 },
  ]
  const kept = vw.sanitizeRanges(raw, duration)
  const ok = kept.length === 3
    && kept[1].end_us === duration
    && kept.every(r => r.start_us >= 0 && r.start_us < r.end_us && r.end_us <= duration)
  record('模型区间被过滤并夹到素材时长', ok,
    `输入 8 条 → 保留 ${kept.length} 条：${JSON.stringify(kept.map(r => [r.start_us, r.end_us]))}`)
}

console.log('\n' + '='.repeat(64))
const bad = results.filter(r => !r.ok)
console.log(`共 ${results.length} 项，发现 ${bad.length} 个问题`)
for (const b of bad) console.log(`  · ${b.name}：${b.detail}`)
console.log(`\n（网络桩件共拦截 ${calls.length} 次调用，未触达真实 OSS）`)
