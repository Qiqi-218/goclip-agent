import { checkBundleFreshness } from './bundle-freshness.mjs'
/**
 * 验证数据库约束真的拦住了那两类脏数据，并验证旧库能被迁移。
 *
 * 全程用临时目录与网络桩件，不触达真实 OSS。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNTIME = process.argv[2]

globalThis.fetch = async (url) => {
  if (String(url).includes('/index.json')) return new Response(JSON.stringify({ version: 1, projects: [] }), { status: 200 })
  return new Response('', { status: 200 })
}

const config = {
  dataDir: await mkdtemp(join(tmpdir(), 'goclip-schema-')),
  modelBaseUrl: 'http://stub.invalid/v1', model: 'stub', apiKeyEnv: 'STUB_ID',
  ossEndpoint: 'oss-cn-beijing.aliyuncs.com', ossBucket: 'stub', ossAccessKeyIdEnv: 'STUB_ID',
  ossAccessKeySecretEnv: 'STUB_SECRET', ossPrefix: 't', ossOutputPrefix: 'e', ossProjectPrefix: 'goclip-projects',
  signedUrlSeconds: 900, requestTimeoutMs: 5000, modelTimeoutMs: 20000, requestTimeoutMs: 5000, modelTimeoutMs: 20000, maxImportBytes: 1024,
}
process.env.STUB_ID = 'x'
process.env.STUB_SECRET = 'y'

const { VideoWorkspace } = await import(RUNTIME)
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅ 通过' : '❌ 问题'}  ${name}`)
  console.log(`        ${detail}`)
}

const vw = new VideoWorkspace(config)
await vw.createProject('p1', '项目一')
await vw.createProject('p2', '项目二')

// 直连数据库塞数据，绕过运行时校验，看约束本身是否生效
const { DatabaseSync } = await import('node:sqlite')
const raw = new DatabaseSync(join(config.dataDir, 'video-tools.sqlite'))
raw.exec('PRAGMA foreign_keys=ON')

// 跨项目引用：外键拦不住（project_id 与 asset_id 是两个独立外键，各自有效并不代表同属一个项目），
// 所以这一条必须由运行时校验承担 —— 验证真正生效的那一环。
{
  raw.prepare('INSERT OR REPLACE INTO assets VALUES (?,?,?,?)').run('a1', 'p1', 'oss://goclip-projects/p1/assets/a1/source.mp4', JSON.stringify({ duration_us: 10000000 }))
  let threw = ''
  try {
    await vw.createTimeline({ id: 't-cross', project_id: 'p2', asset_id: 'a1', start_us: 0, end_us: 1000000 })
  } catch (e) { threw = e.message }
  record('运行时拦住跨项目的时间线', threw.includes('does not belong'), threw || '未拦住（插入成功）')
}
// 约束 2：时间线区间不能为空或反向
{
  let threw = ''
  try {
    raw.prepare('INSERT INTO timelines (id,name,project_id,asset_id,start_us,end_us,revision) VALUES (?,?,?,?,?,?,?)').run('t-bad', null, 'p1', 'a1', 8000000, 3000000, 1)
  } catch (e) { threw = e.message }
  record('CHECK 拦住反向区间', threw.includes('CHECK'), threw || '未拦住（插入成功）')
}
// 约束 2b：片段表是多段模型的另一半，同样不能存空区间
{
  // 片段表带 `timeline_id` 外键，所以要先有那条时间线 —— 否则失败的是外键，探针就测错了约束。
  // `clip_id` 是 NOT NULL，也必须给：缺了它先撞的就不是这条 CHECK，探针会看起来「约束没生效」。
  raw.prepare('INSERT INTO timelines (id,name,project_id,asset_id,start_us,end_us,revision) VALUES (?,?,?,?,?,?,?)').run('t1', null, 'p1', 'a1', 0, 2000000, 1)
  let threw = ''
  try {
    raw.prepare('INSERT INTO timeline_segments (timeline_id,ordinal,asset_id,start_us,end_us,speed,muted,clip_id) VALUES (?,?,?,?,?,?,?,?)').run('t1', 0, 'a1', 5000000, 5000000, 1.0, 0, 'c-zero')
  } catch (e) { threw = e.message }
  record('CHECK 拦住零长度片段', threw.includes('CHECK'), threw || '未拦住（插入成功）')
}
// 约束 2c：速度为 0 会让时长计算除零
{
  let threw = ''
  try {
    raw.prepare('INSERT INTO timeline_segments (timeline_id,ordinal,asset_id,start_us,end_us,speed,muted,clip_id) VALUES (?,?,?,?,?,?,?,?)').run('t1', 1, 'a1', 0, 1000000, 0, 0, 'c-slow')
  } catch (e) { threw = e.message }
  record('CHECK 拦住非正速度', threw.includes('CHECK'), threw || '未拦住（插入成功）')
}
// 约束 3：素材不能挂到不存在的项目
{
  let threw = ''
  try {
    raw.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('a-orphan', 'no-such-project', 'oss://x', '{}')
  } catch (e) { threw = e.message }
  record('外键拦住孤立的素材', threw.includes('FOREIGN KEY'), threw || '未拦住（插入成功）')
}
// 约束 4：删项目要级联删掉它的素材与时间线
{
  /*
   * 任务表列名显式写出：`jobs` 现在有 12 列（导出快照那批新增了 input_snapshot、timeline_revision、
   * filename、render_options 与三个时间戳），位置式 5 值 INSERT 会直接被「列数不符」拒掉，
   * 于是这一条测的是列数而不是级联。
   */
  raw.prepare('INSERT INTO jobs (id,timeline_id,status,output,detail) VALUES (?,?,?,?,?)').run('j1', 't1', 'completed', 'oss://out', '')
  raw.prepare('DELETE FROM projects WHERE id=?').run('p1')
  const leftAssets = raw.prepare('SELECT count(*) c FROM assets WHERE project_id=?').get('p1').c
  const leftTimelines = raw.prepare('SELECT count(*) c FROM timelines WHERE project_id=?').get('p1').c
  const leftJobs = raw.prepare('SELECT count(*) c FROM jobs WHERE id=?').get('j1').c
  record('删项目级联清掉素材/时间线/任务', leftAssets === 0 && leftTimelines === 0 && leftJobs === 0,
    `剩余 素材=${leftAssets} 时间线=${leftTimelines} 任务=${leftJobs}`)
}
raw.close()

// ── 旧库迁移：造一个没有约束的旧库，看能否被接管并丢掉坏行 ──────────────────
{
  const legacyDir = await mkdtemp(join(tmpdir(), 'goclip-legacy-'))
  const old = new DatabaseSync(join(legacyDir, 'video-tools.sqlite'))
  old.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE assets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,path TEXT NOT NULL,meta TEXT NOT NULL);
    CREATE TABLE analyses(asset_id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE timelines(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,asset_id TEXT NOT NULL,start_us INTEGER NOT NULL,end_us INTEGER NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,timeline_id TEXT NOT NULL,status TEXT NOT NULL,output TEXT,detail TEXT);`)
  old.prepare('INSERT INTO projects VALUES (?,?)').run('lp', '旧项目')
  old.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('la', 'lp', 'oss://goclip-projects/lp/assets/la/source.mp4', JSON.stringify({ duration_us: 5000000 }))
  // 好行：正常区间
  old.prepare('INSERT INTO timelines VALUES (?,?,?,?,?,?)').run('lt-ok', 'lp', 'la', 0, 3000000, 1)
  // 坏行 1：区间越界
  old.prepare('INSERT INTO timelines VALUES (?,?,?,?,?,?)').run('lt-over', 'lp', 'la', 0, 9000000, 1)
  // 坏行 2：反向区间
  old.prepare('INSERT INTO timelines VALUES (?,?,?,?,?,?)').run('lt-rev', 'lp', 'la', 4000000, 1000000, 1)
  // 坏行 3：跨项目（引用不存在的项目 lp2 的素材）
  old.prepare('INSERT INTO timelines VALUES (?,?,?,?,?,?)').run('lt-cross', 'lp2', 'la', 0, 1000000, 1)
  old.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('lj-ok', 'lt-ok', 'completed', 'oss://o', '')
  old.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('lj-orphan', 'no-such-timeline', 'completed', 'oss://o', '')
  old.close()

  const legacy = new VideoWorkspace({ ...config, dataDir: legacyDir })
  const projects = await legacy.projects()
  const timelines = await legacy.timelinesOf?.('lp') ?? null
  const { DatabaseSync: DS } = await import('node:sqlite')
  const check = new DS(join(legacyDir, 'video-tools.sqlite'))
  const t = check.prepare('SELECT id,start_us,end_us FROM timelines ORDER BY id').all()
  const j = check.prepare('SELECT id FROM jobs ORDER BY id').all()
  const ddl = check.prepare("SELECT sql FROM sqlite_master WHERE name='assets'").get().sql
  check.close()
  record('旧库被迁移到带约束的 schema', ddl.includes('REFERENCES'), ddl.includes('REFERENCES') ? 'assets 表现在有外键' : '仍是旧表')
  record('迁移保留了项目', projects.length === 1, `项目数 ${projects.length}`)
  record('迁移丢掉越界行（夹到素材时长）', t.some(r => r.id === 'lt-over' && r.end_us === 5000000),
    `timelines=${JSON.stringify(t)}`)
  record('迁移丢掉反向区间行', !t.some(r => r.id === 'lt-rev'), `timelines=${JSON.stringify(t)}`)
  record('迁移丢掉跨项目行', !t.some(r => r.id === 'lt-cross'), `timelines=${JSON.stringify(t)}`)
  record('迁移丢掉孤立任务行', j.length === 1 && j[0].id === 'lj-ok', `jobs=${JSON.stringify(j)}`)
  void timelines
}

// ── 多份分析：同一素材、不同指令要能共存 ────────────────────────────────────
{
  const multiDir = await mkdtemp(join(tmpdir(), 'goclip-multi-'))
  const vw = new VideoWorkspace({ ...config, dataDir: multiDir })
  await vw.createProject('pm', '多分析')
  const { DatabaseSync: DS2 } = await import('node:sqlite')
  const raw = new DS2(join(multiDir, 'video-tools.sqlite'))
  raw.exec('PRAGMA foreign_keys=ON')
  raw.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('am', 'pm', 'oss://goclip-projects/pm/assets/am/source.mp4', JSON.stringify({ duration_us: 10000000 }))

  // 主键必须是 (asset_id, instruction)：同一素材两条指令各存一行
  raw.prepare('INSERT INTO analyses VALUES (?,?,?,?)').run('am', '完整理解内容', JSON.stringify({ summary: '完整的一份', segments: [{ start_us: 0, end_us: 1000000, visual: '甲', audio: '', tags: [], confidence: 0.9 }] }), 1)
  raw.prepare('INSERT INTO analyses VALUES (?,?,?,?)').run('am', '只看高光', JSON.stringify({ summary: '高光的一份', segments: [{ start_us: 2000000, end_us: 3000000, visual: '乙', audio: '', tags: [], confidence: 0.9 }] }), 2)
  const stored = raw.prepare('SELECT instruction FROM analyses WHERE asset_id=? ORDER BY instruction').all('am').map(r => r.instruction)
  raw.close()
  record('同一素材可存多份分析（按指令）', stored.length === 2, `存了 ${stored.length} 份：${JSON.stringify(stored)}`)

  // 两份都应参与检索，并标出来自哪条指令
  const found = (await vw.search('pm', '一')).length
  const segs = (await vw.search('pm', '甲'))[0].matches
  const froms = new Set([...(await vw.search('pm', '甲'))[0].matches, ...(await vw.search('pm', '乙'))[0].matches].map(s => s.from_instruction))
  record('两份分析都参与检索', froms.size === 2, `命中片段来自：${JSON.stringify([...froms])}`)
  void found
  record('检索结果标注来源指令', segs.length === 1 && segs[0].from_instruction === '完整理解内容',
    `from_instruction=${JSON.stringify(segs[0]?.from_instruction)}`)
}

// ── 只有 analyses 是旧表时，不能整体跳过迁移 ────────────────────────────────
{
  const dir = await mkdtemp(join(tmpdir(), 'goclip-half-'))
  const { DatabaseSync: DS3 } = await import('node:sqlite')
  const old = new DS3(join(dir, 'video-tools.sqlite'))
  // 关系约束齐（带 REFERENCES），但 analyses 还是「每素材一行」的旧结构
  old.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE assets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,path TEXT NOT NULL,meta TEXT NOT NULL);
    CREATE TABLE analyses(asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,data TEXT NOT NULL);
    CREATE TABLE timelines(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,start_us INTEGER NOT NULL,end_us INTEGER NOT NULL,revision INTEGER NOT NULL,CHECK (end_us > start_us));
    CREATE TABLE jobs(id TEXT PRIMARY KEY,timeline_id TEXT NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,status TEXT NOT NULL,output TEXT,detail TEXT);`)
  old.prepare('INSERT INTO projects VALUES (?,?)').run('ph', '半新库')
  old.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('ah', 'ph', 'oss://x', '{"duration_us":9000000}')
  // 这一份 data 里嵌了 instruction，迁移要从这里读出来
  old.prepare('INSERT INTO analyses VALUES (?,?)').run('ah', JSON.stringify({ instruction: '只看动作', summary: '带指令的一份', segments: [] }))
  old.close()

  const half = new VideoWorkspace({ ...config, dataDir: dir })
  await half.projects()
  const check = new DS3(join(dir, 'video-tools.sqlite'))
  const ddl = check.prepare("SELECT sql FROM sqlite_master WHERE name='analyses'").get().sql
  const rows = check.prepare('SELECT asset_id,instruction FROM analyses').all()
  const timelinesKept = check.prepare('SELECT count(*) c FROM timelines').get().c
  check.close()
  record('只有 analyses 是旧表时也会迁移', ddl.includes('instruction'), ddl.includes('instruction') ? 'analyses 已按指令存储' : '仍是旧结构')
  record('迁移从 data 里取出 embedded instruction', rows.length === 1 && rows[0].instruction === '只看动作',
    `analyses=${JSON.stringify(rows)}`)
  void timelinesKept
}

// ── 旧数据里的空串字段要在迁移/恢复时归一为 null ────────────────────────────
{
  const dir = await mkdtemp(join(tmpdir(), 'goclip-norm-'))
  const { DatabaseSync: DSN } = await import('node:sqlite')
  const old = new DSN(join(dir, 'video-tools.sqlite'))
  old.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE assets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,path TEXT NOT NULL,meta TEXT NOT NULL);
    CREATE TABLE analyses(asset_id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE timelines(id TEXT PRIMARY KEY,name TEXT,project_id TEXT NOT NULL,asset_id TEXT NOT NULL,start_us INTEGER NOT NULL,end_us INTEGER NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,timeline_id TEXT NOT NULL,status TEXT NOT NULL,output TEXT,detail TEXT);`)
  old.prepare('INSERT INTO projects VALUES (?,?)').run('pn', '归一测试')
  old.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('an', 'pn', 'oss://x', '{"duration_us":9000000}')
  // 旧数据：两段，一段空串、一段空白字符、一段有值
  old.prepare('INSERT INTO analyses VALUES (?,?)').run('an', JSON.stringify({ segments: [
    { start_us: 0, end_us: 1000000, visual: '甲', highlight_reason: '' },
    { start_us: 2000000, end_us: 3000000, visual: '乙', highlight_reason: '   ' },
    { start_us: 4000000, end_us: 5000000, visual: '丙', highlight_reason: '真的理由' },
  ] }))
  old.close()
  const vw = new VideoWorkspace({ ...config, dataDir: dir })
  await vw.projects()
  const check = new DSN(join(dir, 'video-tools.sqlite'))
  const segs = JSON.parse(check.prepare('SELECT data FROM analyses').get().data).segments
  check.close()
  const states = segs.map(s => s.highlight_reason === null ? 'null' : (s.highlight_reason === undefined ? '缺失' : '有值'))
  record('迁移时空串/空白字符归一为 null', states[0] === 'null' && states[1] === 'null' && states[2] === '有值',
    `三段状态：${JSON.stringify(states)}`)
}
for (const f of [checkBundleFreshness(RUNTIME)]) record(f.name, f.ok, f.detail)

console.log('\n' + '='.repeat(64))
const bad = results.filter(r => !r.ok)
console.log(`共 ${results.length} 项，发现问题 ${bad.length} 项`)
for (const b of bad) console.log(`  · ${b.name}`)

