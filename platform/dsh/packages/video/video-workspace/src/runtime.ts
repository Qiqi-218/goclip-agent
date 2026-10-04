import { createHash, createHmac, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { access, mkdir, readFile, writeFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from './config.ts'
import { curveFromPcm, loudSpans, summarize } from './acoustic.ts'
import { buildShots, parseSceneTimes, summarizeShots } from './shots.ts'
import { buildSilences, parseSilences, subtractSpans, type SilenceSpan } from './timing.ts'

const execFile = promisify(nodeExecFile)
/** 未指定指令时用的那一档，与 `understand` 的默认请求文本保持一致。 */
const DEFAULT_INSTRUCTION = '完整理解内容'

/**
 * Words that ask for the analysis's highlight judgement rather than for a string.
 *
 * 「高光」 names a verdict, and a verdict is not text the model wrote: the stored
 * segments of this project contain no 「高光」 anywhere, so literal matching returns
 * nothing even though the project is literally called 高光集锦. A query built from
 * these words is answered from the `is_highlight` flag instead.
 */
/** Evidence kinds, kept as constants so a typo cannot silently create a second series. */
const EVIDENCE_ACOUSTIC = 'acoustic-loudness'
const EVIDENCE_SHOTS = 'shot-boundaries'
const EVIDENCE_TIMING = 'silence-timing'
const EVIDENCE_OCR = 'screen-text'
const EVIDENCE_TRANSCRIPT = 'transcript'
const EVIDENCE_VISUAL = 'scene-description'

/**
 * Reasoning tokens above which an empty extraction answer means "did not finish" rather than "found nothing".
 *
 * Every model-backed call in a long session that returned content spent between 296 and
 * 3531 reasoning tokens; the call that returned an empty transcript spent 16384. A model
 * that genuinely finds no speech has nothing to work through and answers immediately, so
 * a large reasoning spend attached to an empty array is the signature of work done in the
 * reasoning channel and never written out. The value sits above every observed
 * productive call so it cannot fire on a real answer.
 */
const EMPTY_ANSWER_REASONING_FLOOR = 6000

/**
 * Which production method wrote an evidence row.
 *
 * Stored in `evidence.provider_version` and compared on read, so changing how an
 * extraction is produced makes previously cached rows miss instead of silently
 * outliving the fix. Bump it whenever a change would alter the stored output.
 *
 * v2 covers windowed extraction plus the reasoning-channel setting: the same asset
 * extracted before it is not the same data as one extracted after.
 */
const EVIDENCE_PROVIDER_VERSION = 'omni-v2-windowed'

/**
 * Frame rate for a trimmed window's proxy, against the 1 fps used for a whole asset.
 *
 * A window is a fraction of the asset, so the upload it costs is a fraction too and the
 * same budget buys a finer read. Speech boundaries land more accurately, which is the
 * whole reason a window exists.
 */
const WINDOW_PROXY_FPS = 3

/**
 * Shortest trailing window worth asking about, in seconds.
 *
 * An extraction over a few seconds of media tends to answer with nothing at all —
 * measured: a 3-minute asset returned an empty list while 8 and 15 minutes returned 88
 * and 161 lines. A remainder below this is folded into the window before it.
 */
const MIN_WINDOW_SECONDS = 120

/**
 * Shortest normalized text that may absorb another reading of the same on-screen text.
 *
 * Chinese captions share single characters constantly - 西 appears in 跟着老西儿游山西 and in
 * 西方三圣 - so containment alone merges unrelated captions, which is how entries reading
 * just 西 and 小 got into the results. Four characters is above any single word that two
 * different captions would share and below every spelling of the station mark observed.
 */
const CAPTION_GROUP_MIN_LENGTH = 4

/**
 * Every evidence kind the plugin can compute, in the order a caller usually wants them.
 *
 * Listed once so that "what is missing" is answered by comparing against a fixed set rather
 * than by whatever rows happen to exist: a kind that was never computed and a kind that was
 * computed and came back empty would otherwise look the same.
 */
const ALL_EVIDENCE_KINDS = [
  EVIDENCE_TRANSCRIPT,
  EVIDENCE_OCR,
  EVIDENCE_VISUAL,
  EVIDENCE_SHOTS,
  EVIDENCE_TIMING,
  EVIDENCE_ACOUSTIC,
] as const

/**
 * Offset used while renumbering clips.
 *
 * Above any ordinal a timeline realistically holds, so parking never lands on a number
 * a later step still has to move.
 */
const ORDINAL_PARKING = -1000

/** Round a duration to two decimals; clip lengths are not worth more precision. */
function round2(value: number): number { return Math.round(value * 100) / 100 }

const HIGHLIGHT_QUERY_WORDS = ['高光', '精彩', '亮点', '好看', '名场面', '精华', '高燃', 'highlight']

/**
 * What one model call cost, and what the model thought before it answered.
 *
 * Reported back to the caller so a long analysis can say where its time and tokens
 * went. The reasoning is kept short on purpose: it is evidence that the model worked
 * on the problem, not a transcript worth storing in full.
 */
export interface ModelUsage {
  provider: string
  model: string
  ms: number
  text_tokens: number
  reasoning_tokens: number
  reasoning_chars: number
  reasoning_head: string
}

/** One step of a tool invocation, with how long it took. */
export interface StageTiming {
  stage: string
  ms: number
  /** True when the step was skipped because an earlier run already produced its result. */
  skipped?: boolean
  /** Why the step was skipped. Present only with `skipped`. */
  reason?: string
}

/**
 * Times the steps of one tool invocation.
 *
 * A video analysis spends most of its wall clock inside a single model call and the
 * rest inside ffmpeg, so "it is taking a while" says nothing useful. Recording each
 * stage lets the interface show which step the work is in and what each one cost,
 * through the same projection that already carries model usage.
 */
class StageRecorder {
  private readonly stages: StageTiming[] = []
  reset(): void { this.stages.length = 0 }
  /** Time one step, recording it whether it succeeds or throws. */
  async timed<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now()
    try {
      return await work()
    } finally {
      this.stages.push({ stage, ms: Date.now() - started })
    }
  }
  snapshot(): StageTiming[] { return this.stages.map(entry => ({ ...entry })) }
  /**
   * Record a step that did not run because its result was already available.
   *
   * A cached step still belongs in the pipeline: omitting it makes the reported
   * stages look like work happened that never did, and hides why a repeat request was
   * fast. Reporting which steps were skipped is the same visibility the stage list
   * exists to provide.
   */
  skipped(stage: string, reason: string): void { this.stages.push({ stage, ms: 0, skipped: true, reason }) }
}

type Data = Record<string, unknown>
type AssetRow = { id: string, project_id: string, path: string, meta: string }

/**
 * The first complete JSON object in a model reply, or `undefined`.
 *
 * Models wrap their JSON in prose or code fences, and a reply can contain more
 * than one object. Scanning for the matching closing brace — rather than taking
 * everything between the first `{` and the last `}` — is what keeps a trailing
 * explanation, or a second object, from turning a good reply into a parse error.
 * Braces inside string literals do not count.
 */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * Local index schema.
 *
 * The OSS manifest owns the data; this cache is rebuilt from it, so the schema
 * enforces the relations a caller relies on rather than trusting every writer:
 * an asset belongs to one project, a timeline may only reference an asset of its
 * own project, a timeline covers a non-empty range, and a job belongs to a timeline.
 * Every child row cascades from its parent, so deleting a project cannot leave
 * references behind.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  meta TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analyses(
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  instruction TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, instruction)
);
CREATE TABLE IF NOT EXISTS timelines(
  id TEXT PRIMARY KEY,
  name TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  CHECK (end_us > start_us)
);
-- A timeline is the ordered list of clips that make it up, not one range. The three
-- range columns above stay as the spanning summary of those clips: they keep the file
-- readable by a build that only knows the single-range form, and they let the existing
-- range checks keep working.
CREATE TABLE IF NOT EXISTS timeline_segments(
  timeline_id TEXT NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  speed REAL NOT NULL DEFAULT 1.0,
  muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (timeline_id, ordinal),
  CHECK (end_us > start_us),
  CHECK (speed > 0)
);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY,
  timeline_id TEXT NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  output TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS evidence(
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  duration_us INTEGER NOT NULL,
  payload TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, kind)
);
CREATE INDEX IF NOT EXISTS evidence_by_kind ON evidence(kind);
CREATE INDEX IF NOT EXISTS segments_by_timeline ON timeline_segments(timeline_id);
-- A proposal is a plan the user has not approved yet. Keeping it out of
-- timeline_segments is what makes "show me the plan first" enforceable rather than a
-- prompt instruction: until the accept call runs, nothing about the edit has changed.
CREATE TABLE IF NOT EXISTS proposals(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  timeline_id TEXT REFERENCES timelines(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  items TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_by_project ON proposals(project_id);
-- 每次编辑前存一份剪辑快照，这样 revision 回滚才有东西可回。
-- 只存片段列表：时间线的其他列都能从它推出来，存全行会让"哪个才是权威"变模糊。
CREATE TABLE IF NOT EXISTS timeline_history(
  timeline_id TEXT NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  clips TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (timeline_id, revision)
);
CREATE INDEX IF NOT EXISTS assets_by_project ON assets(project_id);
CREATE INDEX IF NOT EXISTS timelines_by_project ON timelines(project_id);
CREATE INDEX IF NOT EXISTS jobs_by_timeline ON jobs(timeline_id);
`

/** Local processing cache with OSS as the durable project and media store. */
export class VideoWorkspace {
  private db: DatabaseSync | undefined
  private dbPending: Promise<DatabaseSync> | undefined
  /**
   * Tail of the manifest write chain, per project.
   *
   * Two operations on one project both read the tables and upload the whole
   * manifest, so overlapping uploads let the earlier one land last and erase the
   * newer state. Chaining writes per project keeps each upload ordered without
   * blocking a different project.
   */
  private readonly manifestWrites = new Map<string, Promise<void>>()
  /**
   * What the model calls made during one tool invocation cost.
   *
   * `ask` resets this before it starts and the caller reads it once the call settles,
   * so the numbers belong to one invocation rather than to the workspace lifetime.
   * Retries inside `ask` overwrite the earlier attempt, because the caller pays for
   * the attempt that answered, not for every refusal along the way.
   */
  private usage: ModelUsage[] = []
  /** 本次调用的阶段耗时，供界面展示处理管线。 */
  private readonly stages = new StageRecorder()
  constructor(private readonly config: Config) {}
  /**
   * The one database handle, opened once.
   *
   * Concurrent tool calls all reach this before `this.db` is assigned, so the
   * in-flight open is shared rather than letting each caller build its own
   * connection — which would leak handles and run the schema and restore more than
   * once.
   */
  private async open(): Promise<DatabaseSync> {
    if (this.db !== undefined) return this.db
    this.dbPending ??= this.openOnce()
    try {
      this.db = await this.dbPending
      return this.db
    } finally {
      this.dbPending = undefined
    }
  }

  private async openOnce(): Promise<DatabaseSync> {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(this.config.dataDir, 'video-tools.sqlite'))
    db.exec('PRAGMA journal_mode=WAL')
    // 先迁移：SQLite 不能给已有表补外键/CHECK，只能重建；旧库建表时没带约束。
    this.migrate(db)
    // 放在建表之前开，迁移期间的写入也受约束保护。
    db.exec('PRAGMA foreign_keys=ON')
    db.exec(SCHEMA)
    // 两者都必须在表建好之后：一个要补列，一个要读 timeline_segments。
    this.addTimelineNameColumn(db)
    this.backfillSingleClipTimelines(db)
    // restore 依赖 this.db 已就位（它自己会去读），所以先赋值再恢复。
    this.db = db
    this.repairStoredAnalyses(db)
    await this.restore()
    return db
  }

  /**
   * Give every single-range timeline its one clip.
   *
   * Runs after the schema exists, because it reads `timeline_segments`; called from the
   * migration it would query a table the schema has not created yet, and the failure
   * would look exactly like "nothing needed migrating".
   *
   * Only timelines with no clips at all are touched, so re-opening the database never
   * overwrites a timeline that has since been split into several clips.
   *
   * @param db - the open database, with the schema already applied.
   */
  /**
   * Add `timelines.name` to a database created before the column existed.
   *
   * The column is nullable and has no default, so an older project keeps working with
   * `name` absent; the caller sees `null` rather than a fabricated label.
   *
   * @param db - the open database, with the schema already applied.
   */
  private addTimelineNameColumn(db: DatabaseSync): void {
    try {
      const columns = db.prepare('PRAGMA table_info(timelines)').all() as Array<{ name: string }>
      if (columns.some(column => column.name === 'name')) return
      db.exec('ALTER TABLE timelines ADD COLUMN name TEXT')
      console.warn('video-workspace: 已为时间线补上 name 列')
    } catch (error) { console.warn(`video-workspace: 补 name 列失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  /**
   * Give every single-range timeline its one clip.
   *
   * Runs after the schema exists, because it reads `timeline_segments`; called from the
   * migration it would query a table the schema has not created yet, and the failure
   * would look exactly like "nothing needed migrating".
   *
   * Only timelines with no clips at all are touched, so re-opening the database never
   * overwrites a timeline that has since been split into several clips.
   *
   * @param db - the open database, with the schema already applied.
   */
  private backfillSingleClipTimelines(db: DatabaseSync): void {
    try {
      const missing = db.prepare('SELECT t.id, t.asset_id, t.start_us, t.end_us FROM timelines t WHERE NOT EXISTS (SELECT 1 FROM timeline_segments s WHERE s.timeline_id = t.id)').all() as Array<{ id: string, asset_id: string, start_us: number, end_us: number }>
      if (missing.length === 0) return
      const insert = db.prepare('INSERT INTO timeline_segments (timeline_id, ordinal, asset_id, start_us, end_us, speed, muted) VALUES (?,0,?,?,?,1.0,0)')
      let done = 0
      for (const row of missing) {
        // 素材已被删掉的时间线没法补片段，外键会挡住；留给它的级联清理处理。
        if (!db.prepare('SELECT 1 FROM assets WHERE id=?').get(row.asset_id)) continue
        if (row.end_us <= row.start_us) continue
        insert.run(row.id, row.asset_id, row.start_us, row.end_us)
        done++
      }
      if (done > 0) console.warn(`video-workspace: 已为 ${done} 条旧时间线补上其首段`)
    } catch (error) {
      // 这里不再静默：回填失败会让时间线看起来是空的，必须留下痕迹。
      console.warn(`video-workspace: 时间线片段回填失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private repairStoredAnalyses(db: DatabaseSync): void {
    try {
      const rows = db.prepare('SELECT asset_id, instruction, data FROM analyses').all() as Array<{ asset_id: string, instruction: string, data: string }>
      const update = db.prepare('UPDATE analyses SET data=? WHERE asset_id=? AND instruction=?')
      let repaired = 0
      for (const row of rows) {
        let normalized = this.normalizeStoredAnalysis(row.data)
        const meta = db.prepare('SELECT meta FROM assets WHERE id=?').get(row.asset_id) as { meta: string } | undefined
        if (meta !== undefined) {
          try {
            const parsed = JSON.parse(normalized) as { segments?: unknown, summary?: unknown }
            const duration = (JSON.parse(meta.meta) as { duration_us?: number }).duration_us
            if (Array.isArray(parsed.segments)) {
              const fixed = this.sanitizeRanges(parsed.segments, duration)
              if (fixed.length !== parsed.segments.length || fixed.some((segment, index) => segment.start_us !== (parsed.segments as Data[])[index]?.start_us || segment.end_us !== (parsed.segments as Data[])[index]?.end_us)) {
                normalized = JSON.stringify({ ...parsed, segments: fixed })
              }
            }
          } catch { /* 元数据或数据读不出来就只保留字段归一的结果 */ }
        }
        if (normalized === row.data) continue
        update.run(normalized, row.asset_id, row.instruction)
        repaired++
      }
      if (repaired > 0) console.warn(`video-workspace: 修正了 ${repaired} 份历史分析（空字段归一 + 区间单位与越界校正）`)
    } catch (error) { /* 修不了也不能挡住启动；下次写入时会走新的归一逻辑 */ console.warn(`video-workspace: 历史分析修正跳过：${error instanceof Error ? error.message : String(error)}`) }
  }

  /**
   * Rebuild the tables when they predate the current schema.
   *
   * `CREATE TABLE IF NOT EXISTS` cannot tighten or reshape an existing table, so a
   * database created before this schema would silently keep accepting cross-project
   * references, inverted ranges, and only one analysis per asset. Rebuild once,
   * carrying over only the rows the new schema accepts: `PRAGMA foreign_keys` is a
   * no-op inside a transaction, so the rows are copied and checked by hand.
   */
  private migrate(db: DatabaseSync): void {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
    if (tables.length === 0) return
    const table = (name: string): string => ((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql?: string } | undefined)?.sql ?? '')
    // 两个维度分别判断：关系约束齐了吗？analyses 能按指令存多份吗？
    // 必须分开，否则一个已经带约束、只是 analyses 还是旧的库会被整体跳过。
    const relationsCurrent = table('assets').includes('REFERENCES')
    const analysesCurrent = table('analyses').includes('instruction')
    if (relationsCurrent && analysesCurrent) return

    type Row = Record<string, unknown>
    const read = (name: string): Row[] => {
      try { return db.prepare(`SELECT * FROM ${name}`).all() as Row[] } catch { return [] }
    }
    const oldProjects = read('projects')
    const oldAssets = read('assets')
    const oldAnalyses = read('analyses')
    const oldTimelines = read('timelines')
    const oldJobs = read('jobs')
    if (oldProjects.length === 0 && oldAssets.length === 0) return

    // 关系那套没变时，只有 analyses 需要重建 —— 否则没必要丢弃好的行。
    const rebuildAll = !relationsCurrent
    if (rebuildAll) {
      for (const name of ['jobs', 'timelines', 'analyses', 'assets', 'projects']) db.exec(`DROP TABLE IF EXISTS ${name}`)
    } else {
      db.exec('DROP TABLE IF EXISTS analyses')
    }
    db.exec(SCHEMA)

    const durationOf = new Map<string, number>()
    for (const row of oldAssets) {
      const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) as { duration_us?: number } : (row.meta as { duration_us?: number } | null)
      if (typeof meta?.duration_us === 'number') durationOf.set(String(row.id), meta.duration_us)
    }

    let dropped = 0
    if (rebuildAll) {
      for (const row of oldProjects) db.prepare('INSERT OR IGNORE INTO projects (id,name) VALUES (?,?)').run(row.id as string, row.name as string)
      for (const row of oldAssets) {
        if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(row.project_id as string)) { dropped++; continue }
        db.prepare('INSERT OR IGNORE INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run(row.id as string, row.project_id as string, row.path as string, row.meta as string)
      }
      for (const row of oldTimelines) {
        const start = Number(row.start_us); const assetId = row.asset_id as string
        const owned = db.prepare('SELECT project_id FROM assets WHERE id=?').get(assetId) as { project_id: string } | undefined
        if (!owned || owned.project_id !== row.project_id || start >= Number(row.end_us)) { dropped++; continue }
        const duration = durationOf.get(assetId)
        const end = typeof duration === 'number' && duration > 0 ? Math.min(Number(row.end_us), duration) : Number(row.end_us)
        if (start >= end) { dropped++; continue }
        // 列名写全：位置写法在表加列后会插错地方，而且错得没有提示。
        db.prepare('INSERT OR IGNORE INTO timelines (id,name,project_id,asset_id,start_us,end_us,revision) VALUES (?,?,?,?,?,?,?)').run(row.id as string, null, row.project_id as string, assetId, start, end, Number(row.revision))
      }
      for (const row of oldJobs) {
        if (!db.prepare('SELECT 1 FROM timelines WHERE id=?').get(row.timeline_id as string)) { dropped++; continue }
        db.prepare('INSERT OR IGNORE INTO jobs (id,timeline_id,status,output,detail) VALUES (?,?,?,?,?)').run(row.id as string, row.timeline_id as string, row.status as string, (row.output ?? null) as string | null, (row.detail ?? null) as string | null)
      }
    }
    for (const row of oldAnalyses) {
      if (!db.prepare('SELECT 1 FROM assets WHERE id=?').get(row.asset_id as string)) { dropped++; continue }
      // 旧的 analyses 每素材一行，结构还分两种：较新的 data 里带 instruction，
      // 更早的没有。两种都要能搬进来 —— 没带指令的归到默认那一档。
      const data = row.data as string
      let instruction = typeof row.instruction === 'string' ? row.instruction : ''
      if (instruction === '') {
        try {
          const parsed = JSON.parse(data) as { instruction?: unknown }
          if (typeof parsed.instruction === 'string' && parsed.instruction !== '') instruction = parsed.instruction
        } catch { /* 解析不了也原样搬过去，交给读取方报错 */ }
      }
      const createdAt = typeof row.created_at === 'number' ? row.created_at : Date.now()
      const normalize = (value: string): string => this.normalizeStoredAnalysis(value)
      db.prepare('INSERT OR IGNORE INTO analyses (asset_id,instruction,data,created_at) VALUES (?,?,?,?)').run(row.asset_id as string, instruction === '' ? DEFAULT_INSTRUCTION : instruction, normalize(data), createdAt)
    }
    if (dropped > 0) console.warn(`video-workspace: 本地库迁移时丢弃了 ${dropped} 行不满足新约束的数据（OSS manifest 仍是权威来源）`)
  }
  async createProject(id: string, name: string): Promise<Data> { if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('project id must contain only letters, digits, dot, underscore or hyphen'); if (name.trim() === '') throw new Error('project name must not be empty'); const db = await this.open(); db.prepare('INSERT INTO projects (id,name) VALUES (?,?)').run(id, name); await this.manifest(id); return { id, name } }
  async projects(): Promise<Data[]> { return (await this.open()).prepare('SELECT p.id,p.name,count(a.id) asset_count FROM projects p LEFT JOIN assets a ON a.project_id=p.id GROUP BY p.id').all() as Data[] }
  /**
   * Copy a local video into OSS and register it as an asset of the project.
   *
   * The upload happens before anything is recorded or removed, so a failed transfer
   * leaves both the source file and the index untouched. Whether the local original
   * survives is a deployment choice ({@link Config.keepSourceFiles}); the result says
   * which happened, because a caller that silently removed a user's recording would
   * be hiding the one consequence the user cannot undo.
   */
  async import(projectId: string, path: string): Promise<Data> {
    await access(path)
    const source = resolve(path)
    const size = (await stat(source)).size
    if (size > this.config.maxImportBytes) throw new Error(`source file is ${size} bytes, above the ${this.config.maxImportBytes} byte import limit`)
    const hash = await this.hashFile(source)
    const meta = await this.probe(source)
    const id = `asset-${hash.slice(0, 20)}`
    const key = `${this.config.ossProjectPrefix.replace(/\/$/,'')}/${projectId}/assets/${id}/source${extname(source) || '.mp4'}`
    await this.uploadFile(source, key, 'video/mp4')
    // 只有在 OSS 上确实有这份素材之后，才有资格动本地文件。
    const keep = this.config.keepSourceFiles ?? false
    if (!keep) await rm(source, { force: true })
    const db = await this.open()
    db.prepare('INSERT OR REPLACE INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run(id, projectId, `oss://${key}`, JSON.stringify({ ...meta, oss_key: key, source_name: basename(source), sha256: hash, size }))
    await this.manifest(projectId)
    return {
      id,
      project_id: projectId,
      path: `oss://${key}`,
      oss_key: key,
      ...meta,
      source_kept: keep,
      source_note: keep
        ? `本地源文件保留在 ${source}`
        : `本地源文件已被删除（素材现在只存在于 OSS）。如需保留，请把 keepSourceFiles 设为 true。`,
    }
  }
  async assets(projectId: string): Promise<Data[]> { const rows = (await this.open()).prepare('SELECT * FROM assets WHERE project_id=?').all(projectId) as AssetRow[]; return rows.map(row => ({ id: row.id, project_id: row.project_id, path: row.path, ...JSON.parse(row.meta) as Data })) }
  /**
   * Understand an asset with Qwen Omni, reusing the stored analysis when nothing changed.
   *
   * Reuse is keyed on the instruction, because that is what shapes the reply. Reusing on
   * the asset alone would silently answer a new question with an old analysis. The stored
   * `oss_key` identifies the proxy video a previous run uploaded, so an identical request
   * repeats neither the upload nor the model call.
   */
  async understand(projectId: string, assetId: string, instruction: string | undefined, signal: AbortSignal): Promise<Data> {
    const asset = await this.asset(projectId, assetId)
    const db = await this.open()
    const request = instruction ?? DEFAULT_INSTRUCTION
    // 同一个素材可以有多份分析，一份对应一条指令：换问法不会抹掉上一份。
    const stored = db.prepare('SELECT data FROM analyses WHERE asset_id=? AND instruction=?').get(assetId, request) as { data: string } | undefined
    if (stored) {
      const previous = JSON.parse(stored.data) as Data & { oss_key?: string }
      if (typeof previous.oss_key === 'string') {
        // 走缓存也要说清跳过了什么，否则阶段列表看起来像少做了事。
        this.stages.reset()
        this.stages.skipped('下载素材', '复用已保存的分析，未重新下载')
        this.stages.skipped('生成代理视频', '复用已保存的分析，未重新生成代理')
        this.stages.skipped('上传代理视频', '复用已保存的分析，未重新上传')
        this.stages.skipped('模型理解', '同一素材 + 同一指令已分析过，直接复用')
        return { asset_id: assetId, ...previous, reused: true, stages: this.stages.snapshot() }
      }
    }
    if (!asset.path.startsWith('oss://')) this.stages.skipped('下载素材', '素材就是本地文件，无需从 OSS 下载')
    const source = await this.stages.timed('下载素材', () => this.materialize(asset.path, signal))
    try {
      // prepare 自己记录这一阶段：它最清楚是命中缓存还是真的跑了一次 ffmpeg。
      const file = await this.prepare(source.path, signal)
      const key = `${this.config.ossPrefix.replace(/\/$/,'')}/${projectId}/${assetId}/${randomUUID()}.mp4`
      const url = await this.stages.timed('上传代理视频', () => this.uploadFile(file, key, 'video/mp4'))
      // is_highlight 是让「找高光」可行的关键：判断类词（高光/精彩）不会出现在任何
      // 片段的描述文本里，靠字面检索永远搜不到，所以必须由模型显式标注出来。
      const data = await this.stages.timed('模型理解', () => this.ask(url, `分析此视频并${request}。只返回 JSON：{"summary":"","segments":[{"start_us":0,"end_us":1,"visual":"","audio":"","tags":[""],"is_highlight":false,"highlight_reason":"","confidence":0.0}]}。要求：segments 覆盖整段视频；is_highlight 标出这一段是否属于值得单独剪出来的高光，只给真正的高光段 true，普通叙述段 false；highlight_reason 只在 is_highlight 为 true 时填写，说明它为什么是高光，其余留空；不确定就留空或 false，不要编造。`, signal))
      const segments = this.sanitizeRanges(data.segments, await this.durationOf(assetId)).map(segment => ({ ...segment, highlight_reason: this.blankToNull(segment.highlight_reason) }))
      const record = { ...data, segments, instruction: request, oss_key: key }
      db.prepare('INSERT OR REPLACE INTO analyses (asset_id,instruction,data,created_at) VALUES (?,?,?,?)').run(assetId, request, JSON.stringify(record), Date.now())
      await this.stages.timed('保存与同步', () => this.manifest(projectId))
      // 覆盖区间随理解结果一起返回，理由：调用方在决定「要定位某句话」之前就该知道
      // 语音转写覆盖到哪。实测那次会话里，转写标记为「有」而实际只到 1644s，
      // 模型为 12 句落在那之后的话去重看整片，花了 94.5 秒找一个不存在的东西。
      return { asset_id: assetId, ...record, reused: false, evidence_coverage: await this.evidenceCoverage(assetId), stages: this.stages.snapshot() }
      // 代理视频是缓存，留着给下次复用；只有下载来的源文件要清掉。
    } finally { await source.cleanup() }
  }
  /**
   * Find the stored segments whose content matches a query.
   *
   * Ranked by how good the match is: an exact tag beats a phrase, which beats a
   * loose substring, and confidence breaks ties. Results are capped because one
   * broad query over a long video can match hundreds of segments, and flooding the
   * context helps nobody — the reply reports the true match count and whether it
   * truncated, so the caller narrows the query instead of assuming it saw everything.
   */
  async search(projectId: string, query: string): Promise<Data[]> {
    const rows = (await this.open()).prepare('SELECT a.id,an.instruction,an.data FROM assets a JOIN analyses an ON an.asset_id=a.id WHERE a.project_id=?').all(projectId) as Array<{ id: string, instruction: string, data: string }>
    const needle = query.trim().toLowerCase()
    if (needle === '') return []
    const words = needle.split(/\s+/).filter(word => word !== '')
    const scored: Array<{ score: number, segment: Data }> = []
    for (const row of rows) {
      for (const segment of (JSON.parse(row.data) as { segments?: Data[] }).segments ?? []) {
        const score = this.relevance(segment, needle, words)
        // 标上这份片段来自哪一条指令，多份分析并存时才分得清出处。
        if (score > 0) scored.push({ score, segment: { asset_id: row.id, from_instruction: row.instruction, ...segment } })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    const limit = this.config.searchLimit ?? 50
    const matches = scored.slice(0, limit).map(entry => entry.segment)
    return [{ matches, match_count: scored.length, truncated: scored.length > matches.length, limit }]
  }

  /**
   * Find the passages of one asset that satisfy several conditions at once.
   *
   * This is the single entry point across every evidence kind. Asking for "the passages
   * that are loud and cut fast and mention a word" needs the analysis text, the loudness
   * curve and the shot list together; doing it here means each condition is applied to
   * the same candidate and the answer says which evidence supported it.
   *
   * Every condition is optional, and omitting all of them returns the whole timeline
   * skeleton. Each result carries `evidence_refs`, naming the series and range that put
   * it there, so a caller can point at what justified a choice instead of asserting it.
   *
   * @param projectId - project owning the asset.
   * @param assetId - asset to search.
   * @param filters - conditions to apply; see the tool description for the meaning of each.
   * @returns The matching spans plus which evidence was consulted and which filters were
   * unavailable because the asset has not been analysed for them.
   */
  async findSpans(projectId: string, assetId: string, filters: { text?: string, texts?: string[], min_seconds?: number, max_seconds?: number, min_dbfs?: number, min_cuts?: number, has_silence?: boolean, highlight_only?: boolean, split_sentences?: boolean, limit?: number }): Promise<Data> {
    await this.asset(projectId, assetId)
    const db = await this.open()
    const analyses = db.prepare('SELECT instruction, data FROM analyses WHERE asset_id=?').all(assetId) as Array<{ instruction: string, data: string }>
    const acousticRow = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, EVIDENCE_ACOUSTIC) as { payload: string } | undefined
    const shotsRow = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, EVIDENCE_SHOTS) as { payload: string } | undefined
    const timingRow = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, EVIDENCE_TIMING) as { payload: string } | undefined
    const missing: string[] = []
    if (acousticRow === undefined) missing.push('还没算过响度：video_evidence_acoustic')
    if (shotsRow === undefined) missing.push('还没算过镜头：video_evidence_shots')
    if (timingRow === undefined) missing.push('还没算过静音：video_evidence_timing')
    const acoustic = acousticRow === undefined ? undefined : JSON.parse(acousticRow.payload) as { levelsDbfs?: number[], windowUs?: number, loudDbfs?: number }
    const shots = shotsRow === undefined ? undefined : JSON.parse(shotsRow.payload) as { shots?: Array<{ startUs: number, endUs: number }> }
    const timing = timingRow === undefined ? undefined : JSON.parse(timingRow.payload) as { silences?: Array<{ startUs: number, endUs: number }> }

    const levels = acoustic?.levelsDbfs ?? []
    const windowUs = acoustic?.windowUs ?? 1_000_000
    const shotList = shots?.shots ?? []
    const silences = timing?.silences ?? []
    // 这些量都按秒或按窗口算，逐段取值时用同一套换算，避免单位混用。
    const loudest = (a: number, b: number): number | undefined => {
      if (levels.length === 0) return undefined
      const first = Math.max(0, Math.floor(a / windowUs))
      const last = Math.min(levels.length - 1, Math.ceil(b / windowUs) - 1)
      let best: number | undefined
      for (let i = first; i <= last; i++) { const value = levels[i]; if (value !== undefined && (best === undefined || value > best)) best = value }
      return best
    }
    const cutsIn = (a: number, b: number): number | undefined => shots === undefined ? undefined : shotList.filter(shot => shot.startUs > a && shot.startUs < b).length
    const silenceIn = (a: number, b: number): number => silences.filter(span => span.startUs < b && span.endUs > a).reduce((sum, span) => sum + Math.min(span.endUs, b) - Math.max(span.startUs, a), 0)

    const needle = (filters.text ?? '').trim().toLowerCase()
    // 一次可以问多个锚点。定位一句原话时，调用方手上常有两三句，
    // 而每次只能问一个的话，它就得拆成多次调用 —— 实测那场会话里它没拆，
    // 而是转去重看整条视频。空串在下面按「没有文字条件」处理。
    const needles = [needle, ...(filters.texts ?? []).map(value => value.trim().toLowerCase())]
      .filter(value => value !== '')
    // 收窄仍然只按单个锚点做：它要把命中段收到那一句，而「哪一句」必须唯一。
    const narrowNeedle = needle !== '' ? needle : (needles[0] ?? '')
    // 键里带上指令：同一素材的多份分析会对同一段给出不同切法，那是有用的差异，
    // 不是重复。只有同一份分析内部出现完全相同的区间才算重复。
    const seen = new Set<string>()
    const found: Array<{ score: number, item: Data }> = []
    const consider = (span: { start_us: number, end_us: number, text: string, instruction: string | null, is_highlight: boolean | null, confidence: number, segment?: Data, origin?: string }): void => {
      const key = `${span.instruction ?? ''}|${span.start_us}|${span.end_us}`
      if (seen.has(key)) return
      const seconds = (span.end_us - span.start_us) / 1e6
      if (filters.min_seconds !== undefined && seconds < filters.min_seconds) return
      if (filters.max_seconds !== undefined && seconds > filters.max_seconds) return
      const peak = loudest(span.start_us, span.end_us)
      if (filters.min_dbfs !== undefined && (peak === undefined || peak < filters.min_dbfs)) return
      const cuts = cutsIn(span.start_us, span.end_us)
      if (filters.min_cuts !== undefined && (cuts === undefined || cuts < filters.min_cuts)) return
      const quietUs = silenceIn(span.start_us, span.end_us)
      if (filters.has_silence === false && quietUs > 0) return
      if (filters.highlight_only === true && span.is_highlight !== true) return
      let score = span.confidence
      // 多个锚点各自打分：一次定位请求里常引用两三句原话，
      // 只收一个查询词的话，调用方要么拆成多次调用，要么放弃本地检索
      // —— 实测那场会话里它选了后者，转而去重看整条视频 21 次（838 秒）。
      let matchedNeedle: string | null = null
      if (needles.length > 0) {
        const target = span.segment ?? { visual: span.text, is_highlight: span.is_highlight }
        let best = 0
        for (const needle of needles) {
          const candidate = this.relevance(target, needle, needle.split(/\s+/).filter(word => word !== ''))
          if (candidate > best) { best = candidate; matchedNeedle = needle }
        }
        // 用原始段打分：relevance 会区分「标签精确命中」「字段等于查询」「正文包含」，
        // 把它们压成一段文本再 includes 会让每一段都命中同一个词。
        if (best <= 0) return
        score += best
      } else if (span.is_highlight === true) score += 1
      seen.add(key)
      const refs: Data[] = []
      // 来源要说清楚：用户看到"这条为什么被选中"，靠的就是这一行。
      // 云证据的 span 没有 instruction（它不是某次分析产出的），所以要单独记。
      if (span.origin !== undefined) refs.push({ source: span.origin, start_us: span.start_us, end_us: span.end_us, text: span.text })
      if (span.instruction !== null) refs.push({ source: 'analysis', instruction: span.instruction, start_us: span.start_us, end_us: span.end_us })
      if (peak !== undefined) refs.push({ source: EVIDENCE_ACOUSTIC, start_us: span.start_us, end_us: span.end_us, peak_dbfs: peak, loud_threshold_dbfs: acoustic?.loudDbfs ?? null })
      if (cuts !== undefined) refs.push({ source: EVIDENCE_SHOTS, start_us: span.start_us, end_us: span.end_us, cuts })
      if (silences.length > 0) refs.push({ source: EVIDENCE_TIMING, start_us: span.start_us, end_us: span.end_us, silence_us: quietUs })
      found.push({
        score,
        item: {
          start_us: span.start_us, end_us: span.end_us, seconds: round2(seconds),
          text: span.text, from_instruction: span.instruction, is_highlight: span.is_highlight,
          peak_dbfs: peak ?? null, cuts: cuts ?? null, silence_seconds: round2(quietUs / 1e6),
          // 一次问了多个锚点时，要说清这条命中的是哪一个：
          // 否则调用方拿到一堆区间却不知道哪句对应哪个。
          matched_text: matchedNeedle,
          evidence_refs: refs,
        },
      })
    }

    // 屏幕文字也进同一条检索流水线：它是唯一能被字面精确命中的一维
    // （模型对画面的描述只能近似匹配，而字幕上的字可以逐字对上）。
    const ocrRow = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, EVIDENCE_OCR) as { payload: string } | undefined
    const asrRow = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, EVIDENCE_TRANSCRIPT) as { payload: string } | undefined
    const visualRow = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, EVIDENCE_VISUAL) as { payload: string } | undefined
    if (ocrRow !== undefined) {
      const entries = (JSON.parse(ocrRow.payload) as { entries?: Data[] }).entries ?? []
      for (const entry of entries) {
        const start = Number(entry.start_us); const end = Number(entry.end_us)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
        const text = String(entry.text ?? '')
        if (text === '') continue
        consider({
          start_us: start, end_us: end,
          text: text.slice(0, 400),
          segment: { visual: text, on_screen_text: true },
          origin: EVIDENCE_OCR,
          instruction: null,
          is_highlight: null,
          confidence: 0,
        })
      }
    }
    // 语音转写与屏幕文字都进同一条流水线：两者都是"可以逐字对上"的文本，
    // 而模型对画面的描述只能近似匹配。检索时不区分来源，命中哪一维由内容决定。
    if (asrRow !== undefined) {
      const lines = (JSON.parse(asrRow.payload) as { lines?: Data[] }).lines ?? []
      for (const line of lines) {
        const start = Number(line.start_us); const end = Number(line.end_us)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
        const text = String(line.text ?? '')
        if (text === '') continue
        consider({
          start_us: start, end_us: end,
          text: text.slice(0, 400),
          segment: { visual: text, spoken: true },
          origin: EVIDENCE_TRANSCRIPT,
          instruction: null,
          is_highlight: null,
          confidence: 0,
        })
      }
    }
    // 画面描述同样进这条流水线：它是唯一能回答"画面上有什么"的一维，
    // 而语音与屏幕文字只能匹配真的说过或写过的字。
    if (visualRow !== undefined) {
      const scenes = (JSON.parse(visualRow.payload) as { scenes?: Data[] }).scenes ?? []
      for (const scene of scenes) {
        const start = Number(scene.start_us); const end = Number(scene.end_us)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
        const description = String(scene.description ?? '')
        if (description === '') continue
        consider({
          start_us: start, end_us: end,
          text: description.slice(0, 400),
          segment: { visual: description, on_screen: scene.on_screen ?? [] },
          origin: EVIDENCE_VISUAL,
          instruction: null,
          is_highlight: null,
          confidence: 0,
        })
      }
    }
    for (const analysis of analyses) {
      for (const segment of (JSON.parse(analysis.data) as { segments?: Data[] }).segments ?? []) {
        const start = Number(segment.start_us); const end = Number(segment.end_us)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
        // 命中之后把区间收窄到那一句。
        //
        // 分析分段常常有几十秒到上百秒，而提问往往针对其中一句话
        // （「他说『与其强请画毁不如售画修庙』是什么时候」）。只给整段的话，
        // 调用方拿到 100 秒的窗口还得再想办法定位，实际发生的后果是它转而
        // 让多模态模型重看整条视频 —— 一次 40 秒，一场会话里发生了 21 次。
        // 段内文字是按句写的，按字数比例插值就能把答案落到句子级，
        // 代价是纯本地字符串处理。
        const narrowed = narrowNeedle === '' ? null : this.narrowToSentence(segment, narrowNeedle, start, end)
        consider({
          start_us: narrowed?.start_us ?? start,
          end_us: narrowed?.end_us ?? end,
          text: this.segmentText(segment).slice(0, 400),
          segment,
          instruction: analysis.instruction,
          is_highlight: segment.is_highlight === true ? true : segment.is_highlight === false ? false : null,
          confidence: typeof segment.confidence === 'number' ? segment.confidence : 0,
        })
      }
    }
    // 响度证据在没有任何分析时仍然有用：它自己就能回答"哪些段落最响"。
    if (levels.length > 0 && found.length === 0 && needles.length === 0 && filters.highlight_only !== true) {
      for (const span of loudSpans(summarize(levels, windowUs, 0), 2)) {
        consider({ start_us: span.startUs, end_us: span.endUs, text: '', instruction: null, is_highlight: null, confidence: 0 })
      }
    }
    found.sort((a, b) => b.score - a.score)
    const limit = Math.max(1, filters.limit ?? this.config.searchLimit ?? 50)
    // 同一段内容会在每一份分析里各出现一次，区间又互相重叠。全留着会让列表看起来
    // 有很多候选，其实指向同一处画面。标出与更优结果重叠的条目，而不是丢掉它们：
    // 哪一条该用取决于用户想要哪种切法，工具不该替他决定。
    const kept: Array<{ start: number, end: number, index: number }> = []
    const items = found.slice(0, limit).map((entry, index) => {
      const start = Number(entry.item.start_us); const end = Number(entry.item.end_us)
      const covering = kept.filter(other => Math.min(end, other.end) - Math.max(start, other.start) > 0)
      const overlapUs = covering.reduce((sum, other) => sum + Math.max(0, Math.min(end, other.end) - Math.max(start, other.start)), 0)
      kept.push({ start, end, index })
      return {
        ...entry.item,
        overlaps_stronger_matches: covering.length,
        overlap_seconds: round2(overlapUs / 1e6),
        overlap_note: covering.length === 0 ? null : `与排在前面的 ${covering.length} 条有重叠（共 ${round2(overlapUs / 1e6)} 秒）。同一内容常被多份分析各报一次，选一条即可，不要重复剪进去。`,
        // 分段内部的按句拆分：只在调用方要求时给出。
        //
        // 分段常常是 60–180 秒、text 是多句复述，而提问往往针对其中一句。
        // 实测那次会话里，模型要「视频结尾这几句逐句的起止时间」—— 结尾落在
        // 1640s 之后，那里没有音轨、也就没有句子级转写，它只拿到一个 17 秒的分段，
        // 于是升级去重看整片（44.7 秒）。而分段里的复述本来就分了句，
        // 按字数比例插值就能给出逐句的大致位置，代价是零。
        // 这是估算而非真实边界，所以由调用方显式索取，不默认塞进每条结果。
        sentences: filters.split_sentences === true ? this.splitSpanIntoSentences(entry.item.text, start, end) : undefined,
      }
    })
    return {
      asset_id: assetId,
      filters,
      match_count: found.length,
      returned: items.length,
      truncated: found.length > items.length,
      limit,
      matches: items,
      evidence_available: { [EVIDENCE_ACOUSTIC]: acoustic !== undefined, [EVIDENCE_SHOTS]: shots !== undefined, [EVIDENCE_TIMING]: timing !== undefined, [EVIDENCE_TRANSCRIPT]: asrRow !== undefined, [EVIDENCE_OCR]: ocrRow !== undefined, [EVIDENCE_VISUAL]: visualRow !== undefined },
      evidence_missing: missing,
      // 覆盖区间：vidence_available 只说明「算没算过」，而调用方真正要知道的是
      // 「这一类证据覆盖到哪」—— 实测那条素材的转写标记为 true，却在 1644s 之后再
      // 也答不出任何东西，因为音频流到那里就结束了。
      evidence_coverage: await this.evidenceCoverage(assetId),
      note: items.length === 0 ? '没有段落满足全部条件。可以放宽条件，或先用 video_evidence_* 把缺的证据算出来。' : '每条的 evidence_refs 说明了它为什么被选中，可以据此向用户解释。',
    }
  }

  /**
   * How well one segment answers a query. Zero means it does not match.
   *
   * An exact tag or field value outranks a phrase, which outranks scattered words:
   * the caller usually asks for a thing the analysis already named, and a segment
   * described exactly by the query is a better answer than one that merely contains
   * the same letters.
   */
  private relevance(segment: Data, needle: string, words: string[]): number { const confidence = typeof segment.confidence === 'number' ? segment.confidence : 0; if (HIGHLIGHT_QUERY_WORDS.includes(needle)) return segment.is_highlight === true ? 2000 + confidence : 0; const text = this.segmentText(segment); if (text === '') return 0; const rawTags = segment.tags; const tags = Array.isArray(rawTags) ? rawTags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.toLowerCase()) : []; if (tags.includes(needle)) return 1000 + confidence; const fields = ['visual','audio','summary','highlight_reason','reason'].map(field => segment[field]).filter((value): value is string => typeof value === 'string').map(value => value.toLowerCase()); if (fields.some(value => value === needle)) return 900 + confidence; if (text.includes(needle)) return 500 + confidence; const hits = words.filter(word => text.includes(word)).length; if (hits === 0) return 0; return 100 * (hits / words.length) + confidence }
  async find(projectId: string, assetId: string, subject: string, signal: AbortSignal): Promise<Data> { const asset = await this.asset(projectId, assetId); this.stages.reset(); const source = await this.stages.timed('下载素材', () => this.materialize(asset.path, signal)); try { const file = await this.prepare(source.path, signal); const key = `${this.config.ossPrefix.replace(/\/$/,'')}/${projectId}/${assetId}/${randomUUID()}.mp4`; const result = await this.ask(await this.uploadFile(file, key, 'video/mp4'), `在这段视频里找出“${subject}”出现的时间段。\n只返回 JSON：{"matches":[{"start_us":0,"end_us":1,"reason":"","confidence":0.0}]}\n要求：\n1. 每个区间是一段连续的内容，起止都要给，时间用微秒；allow 近似，不要因为拿不准就省略。\n2. reason 用一句话说明这一段为什么符合“${subject}”，要写你实际看到的画面或听到的话。\n3. confidence 是 0 到 1 的小数，表示你有多确定这一段真的符合。\n4. 命中几处就返回几段，按出现顺序排列；确实没有就返回 {"matches":[]}，不要为了凑数编造区间。\n5. 若同一内容连续出现了十几秒以上，返回一整段而不是切成很多小段。`, signal); const duration = await this.durationOf(assetId)
      const cleaned = this.sanitizeRanges(result.matches, duration)
      // 模型给的是粗略区间；这里用录音自身的物理边界把它收敛到可剪的位置。
      const tolerance = (this.config.refineToleranceSeconds ?? 1.5) * 1e6
      const refined: Data[] = []
      const doVerify = this.config.verifyBoundaries ?? false
      for (const match of cleaned) {
        const before = { start_us: Number(match.start_us), end_us: Number(match.end_us) }
        const fix = await this.refineRange(assetId, before.start_us, before.end_us, tolerance)
        // 二次核对在吸附之后：先吸附到物理边界，再让模型只看这一段确认起止。
        // 顺序反过来会让模型给的粗略秒数覆盖掉已经算准的边界。
        let confirmed = { start: Number(fix.start_us), end: Number(fix.end_us), before: { start: Number(fix.start_us), end: Number(fix.end_us) }, verified: false, note: null as string | null }
        if (doVerify) {
          confirmed = await this.verifyBoundaries(asset.path, { start: Number(fix.start_us), end: Number(fix.end_us) }, signal) as typeof confirmed
        }
        const finalStart = confirmed.verified ? confirmed.start : Number(fix.start_us)
        const finalEnd = confirmed.verified ? confirmed.end : Number(fix.end_us)
        refined.push({
          ...match,
          start_us: finalStart, end_us: finalEnd,
          // 原始区间保留下来：吸附是工具的判断，用户有权看到模型本来给的是什么。
          original_range: before,
          snap: { snapped: fix.snapped, snapped_start_us: Number(fix.start_us), snapped_end_us: Number(fix.end_us), moved_seconds: round2((Number(fix.snapped_us) || 0) / 1e6), adjustments: fix.adjustments, note: fix.note },
          boundary_check: { verified: confirmed.verified, note: confirmed.note ?? '未做二次核对', before_check_start_us: Number(confirmed.before?.start ?? fix.start_us), before_check_end_us: Number(confirmed.before?.end ?? fix.end_us) },
        })
      }
      return { ...result, matches: refined, refine_tolerance_seconds: this.config.refineToleranceSeconds ?? 1.5, stages: this.stages.snapshot() } } finally { await source.cleanup() } }
  async createTimeline(a: { id: string,project_id: string,asset_id: string,start_us: number,end_us: number,name?: string }): Promise<Data> { await this.assertRange(a.asset_id, a.start_us, a.end_us); await this.assertAssetInProject(a.project_id, a.asset_id); const db = await this.open(); db.prepare('INSERT INTO timelines (id,name,project_id,asset_id,start_us,end_us,revision) VALUES (?,?,?,?,?,?,1)').run(a.id, a.name ?? null, a.project_id, a.asset_id, a.start_us, a.end_us); db.prepare('INSERT INTO timeline_segments (timeline_id,ordinal,asset_id,start_us,end_us,speed,muted) VALUES (?,0,?,?,?,1.0,0)').run(a.id,a.asset_id,a.start_us,a.end_us); try { db.prepare('INSERT OR REPLACE INTO timeline_history (timeline_id,revision,clips,note,created_at) VALUES (?,?,?,?,?)').run(a.id, 1, JSON.stringify([{ ordinal: 0, asset_id: a.asset_id, start_us: a.start_us, end_us: a.end_us, speed: 1, muted: 0 }]), '创建', Date.now()) } catch { /* 记不上不影响创建 */ } await this.manifest(a.project_id); return this.timeline(a.id) }
  async timeline(id: string): Promise<Data> { const row = (await this.open()).prepare('SELECT * FROM timelines WHERE id=?').get(id) as Data | undefined; if (!row) throw new Error(`timeline not found: ${id}`); const segments = this.segmentsOf(id); return { ...row, segments, segment_count: segments.length, duration_us: segments.reduce((sum, s) => sum + (Number(s.end_us) - Number(s.start_us)) / (Number(s.speed) || 1), 0) } }
  /**
   * List a project's timelines, marking the ones that cover the same range of the
   * same asset.
   *
   * Duplicates are reported rather than removed: two entries with one range are
   * usually a revised take on one edit, and only the user knows which one the project
   * should keep. `duplicate_of` names the first entry in each such group so the caller
   * can ask instead of guessing.
   */
  async timelinesOf(projectId: string): Promise<Data[]> { const rows = (await this.open()).prepare('SELECT * FROM timelines WHERE project_id=? ORDER BY rowid').all(projectId) as Array<{ id: string, asset_id: string, start_us: number, end_us: number }>; const firstOfRange = new Map<string, string>(); const out: Data[] = []; for (const row of rows) { const range = `${row.asset_id}|${row.start_us}|${row.end_us}`; const first = firstOfRange.get(range); if (first === undefined) firstOfRange.set(range, row.id); const segments = this.segmentsOf(row.id); out.push({ ...row, segments, segment_count: segments.length, duration_us: segments.reduce((sum, s) => sum + (Number(s.end_us) - Number(s.start_us)) / (Number(s.speed) || 1), 0), duplicate_of: first ?? null }) } return out }
  /**
   * Replace a timeline's whole edit with one clip of one asset.
   *
   * Kept alongside the per-clip operations because "use this range instead" is the
   * common request and expressing it as a single call leaves no half-applied state.
   */
  async replaceTimeline(a: { timeline_id: string,base_revision: number,asset_id: string,start_us: number,end_us: number }): Promise<Data> {
    return this.setSegments({ timeline_id: a.timeline_id, base_revision: a.base_revision, clips: [{ asset_id: a.asset_id, start_us: a.start_us, end_us: a.end_us }] })
  }
  /**
   * Record a plan without touching the edit.
   *
   * The items are stored as given, including each one's `chosen_because` and any
   * `evidence_refs` the caller copied from `video_find`. Storing them is what makes the
   * plan reviewable later: the user can be shown why a clip is in the cut, and the
   * reason survives even though the analysis that produced it was a separate call.
   *
   * @param a - proposal identity, target timeline, and the clips to propose.
   * @returns The stored proposal.
   */
  async proposalCreate(a: { id: string, project_id: string, timeline_id?: string, items: Data[], notes?: string }): Promise<Data> {
    if (a.items.length === 0) throw new Error('方案至少要包含一段。若还没想好选哪几段，先用 video_find 找候选。')
    if (!(await this.projects()).some(row => row.id === a.project_id)) throw new Error(`找不到项目 ${a.project_id}`)
    if (a.timeline_id !== undefined) {
      const timeline = await this.timeline(a.timeline_id) as { project_id: string }
      if (timeline.project_id !== a.project_id) throw new Error(`时间线 ${a.timeline_id} 不属于项目 ${a.project_id}`)
    }
    // 逐段校验来源素材与区间：方案也要受同样的边界约束，否则"确认时才发现"只是把错误推后。
    for (const [index, item] of a.items.entries()) {
      const assetId = item.asset_id
      if (typeof assetId !== 'string' || assetId === '') throw new Error(`方案第 ${index} 段缺少 asset_id`)
      const start = Number(item.start_us); const end = Number(item.end_us)
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`方案第 ${index} 段的 start_us/end_us 不是数字`)
      await this.assertRange(assetId, start, end)
      await this.assertAssetInProject(a.project_id, assetId)
    }
    const db = await this.open()
    const now = Date.now()
    db.prepare('INSERT INTO proposals (id,project_id,timeline_id,status,revision,items,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.project_id, a.timeline_id ?? null, 'draft', 1, JSON.stringify(a.items), a.notes ?? null, now, now)
    await this.manifest(a.project_id)
    return this.proposal(a.id)
  }

  /**
   * Read one proposal back, with the totals a reviewer needs.
   *
   * `total_seconds` accounts for per-clip speed, so a plan that speeds a clip up reports
   * the length the finished film will actually have rather than the length of its source
   * ranges.
   *
   * @param id - proposal id.
   * @returns The proposal, its items, and the derived totals.
   */
  async proposal(id: string): Promise<Data> {
    const row = (await this.open()).prepare('SELECT * FROM proposals WHERE id=?').get(id) as { id: string, project_id: string, timeline_id: string | null, status: string, revision: number, items: string, notes: string | null } | undefined
    if (row === undefined) throw new Error(`找不到方案 ${id}`)
    const items = JSON.parse(row.items) as Data[]
    const totalUs = items.reduce((sum, item) => sum + (Number(item.end_us) - Number(item.start_us)) / (Number(item.speed) || 1), 0)
    return {
      id: row.id, project_id: row.project_id, timeline_id: row.timeline_id, status: row.status, revision: row.revision,
      segment_count: items.length, total_seconds: round2(totalUs / 1e6), items, notes: row.notes,
    }
  }

  /**
   * Replace a draft's items, or its notes.
   *
   * Only a draft may change: once a plan has been accepted its clips are the edit, and
   * editing it afterwards would silently diverge from the timeline it created.
   *
   * @param a - proposal id, the revision the caller read, and the new content.
   * @returns The updated proposal.
   */
  async proposalRevise(a: { id: string, base_revision: number, items?: Data[], notes?: string }): Promise<Data> {
    const current = await this.proposal(a.id) as { status: string, revision: number, project_id: string }
    if (current.status !== 'draft') throw new Error(`方案 ${a.id} 已经是 ${current.status}，不能再改。要调整请新建一个方案。`)
    if (current.revision !== a.base_revision) throw new Error(`revision conflict: 方案当前是 ${current.revision}，你基于 ${a.base_revision} 在改。请重新读取后再改。`)
    if (a.items === undefined && a.notes === undefined) throw new Error('没有要修改的内容：请给出 items 或 notes。')
    if (a.items !== undefined) {
      if (a.items.length === 0) throw new Error('修改后至少要有一段。要放弃整个方案请用 video_proposal_get 说明并另建一个。')
      for (const [index, item] of a.items.entries()) {
        const assetId = item.asset_id
        if (typeof assetId !== 'string' || assetId === '') throw new Error(`方案第 ${index} 段缺少 asset_id`)
        await this.assertRange(assetId, Number(item.start_us), Number(item.end_us))
        await this.assertAssetInProject(current.project_id, assetId)
      }
    }
    const db = await this.open()
    const existing = await this.proposal(a.id) as { items: Data[], notes: string | null }
    db.prepare('UPDATE proposals SET items=?, notes=?, revision=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(a.items ?? existing.items), a.notes ?? existing.notes, a.base_revision + 1, Date.now(), a.id)
    await this.manifest(current.project_id)
    return this.proposal(a.id)
  }

  /**
   * Turn an accepted plan into the timeline's clips.
   *
   * Both revisions are checked: the proposal's so an accepted plan is the one the user
   * saw, and the timeline's so the edit it lands on has not moved since the plan was
   * drawn. The write goes through `setSegments`, so a plan replaces the whole edit in one
   * step rather than leaving a half-applied cut readable in between.
   *
   * @param a - proposal id, its revision, and the target timeline with its revision.
   * @returns The updated timeline.
   */
  async proposalAccept(a: { id: string, base_revision: number, timeline_id: string, timeline_revision: number }): Promise<Data> {
    const proposal = await this.proposal(a.id) as { status: string, revision: number, project_id: string, items: Data[] }
    if (proposal.status !== 'draft') throw new Error(`方案 ${a.id} 已经是 ${proposal.status}，不能再次确认。`)
    if (proposal.revision !== a.base_revision) throw new Error(`revision conflict: 方案当前是 ${proposal.revision}，你基于 ${a.base_revision} 在确认。请重新读取方案。`)
    const timeline = await this.timeline(a.timeline_id) as { project_id: string }
    if (timeline.project_id !== proposal.project_id) throw new Error(`时间线 ${a.timeline_id} 不属于方案所在的项目 ${proposal.project_id}`)
    // 只带上真正给出的可选项：显式给 undefined 在这套类型下不等价于"没有这个键"。
    const clips = proposal.items.map(item => {
      const clip: { asset_id: string, start_us: number, end_us: number, speed?: number, muted?: boolean } = {
        asset_id: String(item.asset_id),
        start_us: Number(item.start_us),
        end_us: Number(item.end_us),
      }
      if (typeof item.speed === 'number') clip.speed = item.speed
      if (item.muted === true) clip.muted = true
      return clip
    })
    // setSegments 自己做区间与项目的校验，这里只负责把两个 revision 锁对上。
    const updated = await this.setSegments({ timeline_id: a.timeline_id, base_revision: a.timeline_revision, clips })
    const db = await this.open()
    db.prepare('UPDATE proposals SET status=?, timeline_id=?, revision=?, updated_at=? WHERE id=?')
      .run('accepted', a.timeline_id, proposal.revision + 1, Date.now(), a.id)
    await this.manifest(proposal.project_id)
    return { proposal: await this.proposal(a.id), timeline: updated }
  }

  /**
   * Write one frame of an edited clip out as an image.
   *
   * The frame is taken from inside the timeline, not from the source asset: a clip that
   * starts at 00:03:02 gets its cover from what the viewer will actually see at its start,
   * which is the only frame that can represent the edit.
   *
   * The default offset is slightly past the clip's first frame because a cut often lands
   * on a transition, and a cover that is a half-dissolved frame looks like a mistake.
   *
   * @param a - timeline, which clip to sample, where inside that clip, and the output name.
   * @returns The stored image's key, URL, size, and where in the clip it was taken.
   */
  async coverPick(a: { timeline_id: string, ordinal?: number, offset_seconds?: number, filename?: string }, signal: AbortSignal): Promise<Data> {
    const timeline = await this.timeline(a.timeline_id) as { project_id: string, segments: Array<{ asset_id: string, start_us: number, end_us: number, seconds: number }>, duration_us: number }
    const clips = timeline.segments
    if (clips.length === 0) throw new Error(`时间线 ${a.timeline_id} 没有任何片段，取不出封面。`)
    const ordinal = a.ordinal ?? 0
    const clip = clips[ordinal]
    if (clip === undefined) throw new Error(`没有第 ${ordinal} 段：这条时间线共 ${clips.length} 段（序号从 0 开始）`)
    const clipSeconds = (clip.end_us - clip.start_us) / 1e6
    const offset = a.offset_seconds ?? Math.min(0.5, clipSeconds / 2)
    if (offset < 0) throw new Error(`offset_seconds 不能为负：${offset}`)
    if (offset >= clipSeconds) throw new Error(`第 ${ordinal} 段只有 ${round2(clipSeconds)} 秒，取不到第 ${offset} 秒那一帧。请把 offset_seconds 调小。`)
    const name = this.safeFilename(a.filename ?? `${a.timeline_id}-cover.jpg`).replace(/\.mp4$/i, '.jpg')
    const asset = await this.assetById(clip.asset_id)
    this.stages.reset()
    const source = await this.stages.timed('准备素材', () => this.materialize(asset.path, signal))
    const output = join(this.config.dataDir, 'tmp', `${randomUUID()}-${name}`)
    await mkdir(dirname(output), { recursive: true })
    try {
      const at = (clip.start_us + offset * 1e6) / 1e6
      // -frames:v 1 取单帧；输出名带 .jpg，ffmpeg 据此选 mjpeg 编码器。
      await this.stages.timed('抽取封面帧', () => this.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(at), '-i', source.path, '-frames:v', '1', '-q:v', '2', output], signal))
      const key = `${this.config.ossOutputPrefix.replace(/\/$/,'')}/${timeline.project_id}/${randomUUID()}-${name}`
      const oss_url = await this.stages.timed('上传封面', () => this.uploadFile(output, key, 'image/jpeg'))
      const bytes = (await stat(output)).size
      return {
        timeline_id: a.timeline_id, ordinal, output: `oss://${key}`, oss_key: key, oss_url,
        source_position_us: Math.round(clip.start_us + offset * 1e6),
        offset_in_clip_seconds: round2(offset), clip_seconds: round2(clipSeconds),
        clip_progress: round2(offset / clipSeconds),
        bytes, kilobytes: round2(bytes / 1024),
        note: `封面取自第 ${ordinal} 段的第 ${round2(offset)} 秒（该段共 ${round2(clipSeconds)} 秒，约 ${Math.round(offset / clipSeconds * 100)}% 处）。不想要这一帧就换 offset_seconds，或换 ordinal。`,
        stages: this.stages.snapshot(),
      }
    } finally { await rm(output, { force: true }); await source.cleanup() }
  }

  /**
   * Move a range's edges onto the physical boundaries of the recording.
   *
   * A model answering "where is the part about X" works from a summary, so the range it
   * returns is approximate — often landing mid-shot or a second into a word. The
   * recording itself has exact edges: a shot change, or the moment the level settles
   * after a cut. Pulling each edge onto the nearest such edge is what turns an
   * approximate answer into a cuttable one, and it is the cheapest of the three ways to
   * raise precision because it needs no further model call.
   *
   * An edge moves only when a boundary is within `toleranceUs`. Beyond that the range is
   * left alone and reported as unsnapped: a boundary far away is not evidence about where
   * this range should begin, and moving to it would cut off content the caller asked for.
   *
   * @param assetId - asset whose evidence supplies the boundaries.
   * @param startUs - requested start.
   * @param endUs - requested end.
   * @param toleranceUs - furthest an edge may move and still count as snapped.
   * @returns The adjusted range plus what moved, so the caller can report the change.
   */
  private async refineRange(assetId: string, startUs: number, endUs: number, toleranceUs: number): Promise<Data> {
    const db = await this.open()
    const shotsRow = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, EVIDENCE_SHOTS) as { payload: string } | undefined
    const acousticRow = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, EVIDENCE_ACOUSTIC) as { payload: string } | undefined
    const boundaries: Array<{ at: number, source: string }> = []
    if (shotsRow !== undefined) {
      for (const shot of ((JSON.parse(shotsRow.payload) as { shots?: Array<{ startUs: number, endUs: number }> }).shots ?? [])) {
        boundaries.push({ at: shot.startUs, source: EVIDENCE_SHOTS })
        boundaries.push({ at: shot.endUs, source: EVIDENCE_SHOTS })
      }
    }
    if (acousticRow !== undefined) {
      const parsed = JSON.parse(acousticRow.payload) as { levelsDbfs?: number[], windowUs?: number, loudDbfs?: number }
      const levels = parsed.levelsDbfs ?? []
      const windowUs = parsed.windowUs ?? 1_000_000
      const threshold = parsed.loudDbfs
      // 响度突变点：相邻窗口跨过响亮阈值的地方，往往就是段落的出入口。
      for (let i = 1; i < levels.length; i++) {
        const previous = levels[i - 1]; const current = levels[i]
        if (previous === undefined || current === undefined || threshold === undefined) continue
        if ((previous < threshold) !== (current < threshold)) boundaries.push({ at: i * windowUs, source: `${EVIDENCE_ACOUSTIC}:level-change` })
      }
    }
    // 字幕与屏幕文字的起止是**比镜头更紧的约束**：一句话从哪开始、到哪结束，
    // 比画面切换更接近"这段内容"的真实边界，而且它正是创作者想要的那句话。
    // 前两者在没有人说话的画面（空镜、纯音乐、图表）里仍然有用，所以三者并列。
    const subtitleRows: Array<{ payload: string, kind: string }> = []
    for (const kind of [EVIDENCE_TRANSCRIPT, EVIDENCE_OCR]) {
      const row = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, kind) as { payload: string } | undefined
      if (row !== undefined) subtitleRows.push({ payload: row.payload, kind })
    }
    for (const row of subtitleRows) {
      const parsed = JSON.parse(row.payload) as { lines?: Data[], entries?: Data[] }
      const items = parsed.lines ?? parsed.entries ?? []
      for (const item of items) {
        const start = Number(item.start_us); const end = Number(item.end_us)
        // 来源要写真实的那一种：吸附说明里会把它报给用户，两行都贴同一个标签
        // 会让"这句话的边界是谁定的"变成假话。
        if (Number.isFinite(start)) boundaries.push({ at: start, source: row.kind })
        if (Number.isFinite(end)) boundaries.push({ at: end, source: row.kind })
      }
    }
    if (boundaries.length === 0) return { start_us: startUs, end_us: endUs, snapped: false, adjustments: [], note: '没有镜头或响度证据可用，区间保持原样。先调用 video_evidence_shots / video_evidence_acoustic 才能吸附。' }
    // 边界分两类，选的规则不同：
    //   话的边界（转写、屏幕文字）—— 一句话从哪开始到哪结束，剪出来是完整的语义单元。
    //   物理边界（镜头切点、响度突变）—— 画面或声音的转折点，剪出来是完整的镜头。
    //
    // 优先吸话的边界：用户说「把讲 X 的地方剪出来」时想要的是那一句话，不是那一帧画面。
    // 但它必须也落在容差内 —— 一句话可能离模型给的区间很远，那时硬吸会把区间拉到别的
    // 内容上，宁可退回最近的物理边界。两类都太远时返回 undefined，区间保持原样。
    const SPEECH_BOUNDARIES = new Set([EVIDENCE_TRANSCRIPT, EVIDENCE_OCR])
    // 两者等距时谁更该赢：屏幕文字优先。
    //
    // 语音边界是听出来的，转写本身还带同音字与断句误差；屏幕文字是画面上逐字
    // 可见的，起止就是那几个字出现与消失的时刻 —— 同样的距离上它是更硬的证据。
    // 不排优先序的话胜者取决于 push 顺序（`[TRANSCRIPT, OCR]`），那是个实现细节，
    // 不该决定用户看到的剪辑点。实测过一处等距场景：两者都在 5.0s，先注册的
    // 转写赢了，而画面上那几个字明明就在同一刻。
    const SOURCE_RANK = (source: string): number => source === EVIDENCE_OCR ? 2 : 1
    const nearest = (at: number): { at: number, source: string, distance: number } | undefined => {
      let bestPhysical: { at: number, source: string, distance: number } | undefined
      let bestSpeech: { at: number, source: string, distance: number } | undefined
      for (const boundary of boundaries) {
        const distance = Math.abs(boundary.at - at)
        if (distance > toleranceUs) continue
        const candidate = { at: boundary.at, source: boundary.source, distance }
        if (SPEECH_BOUNDARIES.has(boundary.source)) {
          if (bestSpeech === undefined
            || distance < bestSpeech.distance
            || (distance === bestSpeech.distance && SOURCE_RANK(boundary.source) > SOURCE_RANK(bestSpeech.source))) {
            bestSpeech = candidate
          }
        } else if (bestPhysical === undefined || distance < bestPhysical.distance) bestPhysical = candidate
      }
      return bestSpeech ?? bestPhysical
    }
    const adjustments: Data[] = []
    const startHit = nearest(startUs)
    const endHit = nearest(endUs)
    const newStart = startHit === undefined ? startUs : startHit.at
    const newEnd = endHit === undefined ? endUs : endHit.at
    if (startHit !== undefined) adjustments.push({ edge: 'start', from_us: startUs, to_us: newStart, moved_us: newStart - startUs, source: startHit.source })
    if (endHit !== undefined) adjustments.push({ edge: 'end', from_us: endUs, to_us: newEnd, moved_us: newEnd - endUs, source: endHit.source })
    // 吸附不能把区间弄反或弄空：两端撞到同一个边界时退回原值，宁可不准也不能为空。
    if (newEnd <= newStart) return { start_us: startUs, end_us: endUs, snapped: false, adjustments: [], note: `吸附后区间为空（两端落到同一处 ${newStart}），已保留原区间。` }
    const movedUs = Math.abs(newStart - startUs) + Math.abs(newEnd - endUs)
    return {
      start_us: newStart, end_us: newEnd, snapped: movedUs > 0, adjustments,
      snapped_us: movedUs,
      note: movedUs > 0
        ? `两端吸附到 ${adjustments.map(a => a.source).join(' / ')} 的边界，共移动 ${round2(movedUs / 1e6)} 秒。这是"证据交叉约束"：模型的粗略区间被录音本身的精确边界收敛。`
        : adjustments.length > 0
          ? '两端本来就在物理边界上（移动量为 0），未调整。'
          : `两端 ${round2(toleranceUs / 1e6)} 秒内都没有物理边界，保持原样。放宽 refineToleranceSeconds 可以吸附得更远，但那会改动用户要的内容。`,
    }
  }

  /**
   * Cut a short excerpt out of an asset so a claim about it can be checked.
   *
   * Evidence returns numbers and ranges. A number cannot be checked by reading it: to
   * decide whether a second really is the loudest, or whether a shot really is cut there,
   * someone has to look and listen. This produces that excerpt, so every finding the
   * tools report can be confirmed against the recording rather than trusted.
   *
   * The excerpt is clamped to a maximum length because it exists for checking, not for
   * watching: a whole-film "excerpt" would be a second copy of the asset in the bucket.
   *
   * @param a - asset, the range to cut, and the output name.
   * @param signal - cancellation for the download, the cut, and the upload.
   * @returns The excerpt's key, URL, length, and the range that was actually cut.
   */
  async evidenceClip(a: { project_id: string, asset_id: string, start_us: number, end_us: number, filename?: string }, signal: AbortSignal): Promise<Data> {
    const asset = await this.asset(a.project_id, a.asset_id)
    const maxSeconds = this.config.excerptMaxSeconds ?? 60
    const duration = await this.durationOf(a.asset_id)
    let start = Math.max(0, Math.round(a.start_us))
    let end = Math.round(a.end_us)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(`区间无效：start_us=${a.start_us} end_us=${a.end_us}`)
    if (duration !== undefined && end > duration) end = duration
    let clamped = false
    if ((end - start) / 1e6 > maxSeconds) { end = start + maxSeconds * 1e6; clamped = true }
    if (end <= start) throw new Error('区间为空，取不出片段。')
    const name = this.safeFilename(a.filename ?? `excerpt-${Math.round(start / 1e6)}s.mp4`).replace(/\.jpg$/i, '.mp4')
    this.stages.reset()
    const source = await this.stages.timed('准备素材', () => this.materialize(asset.path, signal))
    const output = join(this.config.dataDir, 'tmp', `${randomUUID()}-${name}`)
    await mkdir(dirname(output), { recursive: true })
    try {
      // 一律重编码：验证据时要的是这一段的准确起止，不是最快出片。
      await this.stages.timed('切出片段', () => this.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(start / 1e6), '-to', String(end / 1e6), '-i', source.path, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', output], signal))
      const key = `${this.config.ossOutputPrefix.replace(/\/$/,'')}/${a.project_id}/excerpts/${randomUUID()}-${name}`
      const oss_url = await this.stages.timed('上传片段', () => this.uploadFile(output, key, 'video/mp4'))
      const bytes = (await stat(output)).size
      return {
        project_id: a.project_id, asset_id: a.asset_id,
        output: `oss://${key}`, oss_key: key, oss_url,
        start_us: start, end_us: end, seconds: round2((end - start) / 1e6),
        bytes, kilobytes: round2(bytes / 1024),
        clamped_to_max_seconds: clamped ? maxSeconds : null,
        // 这个片段是给**人**看的，不是给模型看的。
        //
        // 工具返回给模型的只有文本；74 次真实调用的结果里没有一个图片或视频块。
        // 不说清楚的话，模型会以为调用它就能「看到」那一秒，于是为了确认一个
        // 边界反复调用 —— 实测里 25 次调用中有相当一部分是这个动机，
        // 而它一个字都读不到。这段说明放在返回值里，是因为模型读的是返回值。
        readable_by_model: false,
        for_human_review: true,
        note: clamped
          ? `请求的区间超过 ${maxSeconds} 秒上限，已截到前 ${maxSeconds} 秒。要整段请分几次取。片段已生成，链接可交给用户打开核对。`
          : '片段已生成。这只是给用户打开的链接 —— 你读到的内容仅此文本，看不到也听不到片段，不要为了「看一眼」而重复调用本工具；判断一段证据是否成立要靠 video_find 的 evidence_refs 与 video_evidence_* 的数字。',
        stages: this.stages.snapshot(),
      }
    } finally { await rm(output, { force: true }); await source.cleanup() }
  }

  /**
   * List the sections one stored analysis found, in order.
   *
   * This is navigation, not retrieval: it answers "what is this film about, in order"
   * when the film is too long to hold in mind. Only the stored analyses are read, so it
   * costs nothing and never invents a structure the analysis did not produce.
   *
   * @param projectId - project owning the asset.
   * @param assetId - asset to outline.
   * @param instruction - which stored analysis to outline; omitted means all of them.
   * @returns Each analysis's summary and its ordered sections.
   */
  async outline(projectId: string, assetId: string, instruction?: string): Promise<Data> {
    await this.asset(projectId, assetId)
    const db = await this.open()
    const rows = (instruction === undefined
      ? db.prepare('SELECT instruction, data, created_at FROM analyses WHERE asset_id=? ORDER BY created_at').all(assetId)
      : db.prepare('SELECT instruction, data, created_at FROM analyses WHERE asset_id=? AND instruction=?').all(assetId, instruction)) as Array<{ instruction: string, data: string, created_at: number }>
    const duration = await this.durationOf(assetId)
    const outlines = rows.map(row => {
      const parsed = JSON.parse(row.data) as { summary?: unknown, segments?: Data[] }
      const segments = parsed.segments ?? []
      return {
        instruction: row.instruction,
        summary: typeof parsed.summary === 'string' ? parsed.summary : null,
        section_count: segments.length,
        sections: segments.map((segment, index) => ({
          index,
          start_us: segment.start_us, end_us: segment.end_us,
          seconds: round2((Number(segment.end_us) - Number(segment.start_us)) / 1e6),
          text: this.segmentText(segment).slice(0, 200),
          is_highlight: segment.is_highlight === true,
        })),
      }
    })
    return {
      asset_id: assetId, duration_us: duration ?? null,
      outlines,
      note: outlines.length === 0
        ? '这个素材还没有任何分析。先调用 video_understand 生成脉络。'
        : '这是理解结果本身的分章，按时间顺序排列，用来快速定位要看哪一段。',
    }
  }

  /**
   * Every passage the analysis marked as a highlight, best first.
   *
   * Separate from the general search because "show me the good parts" is asked far more
   * often than any other query, and it needs no keyword: the judgement was made when the
   * asset was analysed, and this reads it back.
   *
   * @param projectId - project owning the asset.
   * @param assetId - asset to read.
   * @param instruction - which stored analysis to read; omitted means all of them.
   * @returns Highlight passages ordered by confidence, with their stated reasons.
   */
  async highlights(projectId: string, assetId: string, instruction?: string): Promise<Data> {
    await this.asset(projectId, assetId)
    const db = await this.open()
    const rows = (instruction === undefined
      ? db.prepare('SELECT instruction, data FROM analyses WHERE asset_id=?').all(assetId)
      : db.prepare('SELECT instruction, data FROM analyses WHERE asset_id=? AND instruction=?').all(assetId, instruction)) as Array<{ instruction: string, data: string }>
    const found: Array<{ confidence: number, item: Data }> = []
    for (const row of rows) {
      for (const segment of (JSON.parse(row.data) as { segments?: Data[] }).segments ?? []) {
        if (segment.is_highlight !== true) continue
        const start = Number(segment.start_us); const end = Number(segment.end_us)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
        found.push({
          confidence: typeof segment.confidence === 'number' ? segment.confidence : 0,
          item: {
            start_us: start, end_us: end, seconds: round2((end - start) / 1e6),
            // 高光段当初为什么被选中，是分析时写下的，这里原样带回而不是重新判断。
            highlight_reason: segment.highlight_reason ?? null,
            text: this.segmentText(segment).slice(0, 200),
            from_instruction: row.instruction,
            confidence: typeof segment.confidence === 'number' ? segment.confidence : null,
          },
        })
      }
    }
    found.sort((a, b) => b.confidence - a.confidence)
    const limit = Math.max(1, this.config.searchLimit ?? 50)
    const items = found.slice(0, limit).map(entry => entry.item)
    return {
      asset_id: assetId,
      highlight_count: found.length,
      returned: items.length,
      truncated: found.length > items.length,
      highlights: items,
      note: items.length === 0
        ? '没有段落被标为高光。可能还没理解过，或这一版理解里没有可剪的高光。'
        : '这些是分析时被判为高光的段落，按置信度排序。highlight_reason 是当时的判断依据。',
    }
  }

  /** The ordered clips of one timeline, oldest first. */
  private segmentsOf(timelineId: string): Data[] {
    const db = this.db
    if (db === undefined) return []
    const rows = db.prepare('SELECT ordinal, asset_id, start_us, end_us, speed, muted FROM timeline_segments WHERE timeline_id=? ORDER BY ordinal').all(timelineId) as Data[]
    return rows.map(row => {
      const speed = Number(row.speed) || 1
      return { ...row, seconds: round2((Number(row.end_us) - Number(row.start_us)) / speed / 1e6) }
    })
  }

  /**
   * Rewrite a timeline's spanning summary from its clips.
   *
   * The three range columns are the summary a build that only knows the single-range
   * form reads, so they must always bracket the clips: dropping the clip that defined
   * the end has to shrink the range too, or such a build would export footage the edit
   * no longer contains.
   */
  private refreshTimeline(timelineId: string, revision: number): void {
    const db = this.db
    if (db === undefined) return
    const rows = db.prepare('SELECT asset_id, start_us, end_us FROM timeline_segments WHERE timeline_id=? ORDER BY ordinal').all(timelineId) as Array<{ asset_id: string, start_us: number, end_us: number }>
    const first = rows[0]
    // A timeline with no clips is deliberately not allowed: it would export nothing, and
    // `CHECK (end_us > start_us)` on the summary has no value to hold.
    if (first === undefined) throw new Error(`时间线 ${timelineId} 的最后一段不能删除：时间线至少要保留一段。要清空请直接删除整条时间线。`)
    const spanning = rows.reduce((acc, row) => ({ asset_id: row.asset_id, start_us: Math.min(acc.start_us, row.start_us), end_us: Math.max(acc.end_us, row.end_us) }), { asset_id: first.asset_id, start_us: first.start_us, end_us: first.end_us })
    db.prepare('UPDATE timelines SET asset_id=?, start_us=?, end_us=?, revision=? WHERE id=?').run(spanning.asset_id, spanning.start_us, spanning.end_us, revision, timelineId)
    // 历史在这里记录，因为只有这里知道最终版本号。调用方按自己的 base_revision 记录会贴到
    // 已被占用的槽位上 —— 编辑结果覆盖掉上一个版本的快照，历史就只剩一条。
    try {
      db.prepare('INSERT OR REPLACE INTO timeline_history (timeline_id,revision,clips,note,created_at) VALUES (?,?,?,?,?)')
        .run(timelineId, revision, JSON.stringify(rows), null, Date.now())
    } catch { /* 历史记不上不该挡住编辑本身 */ }
  }

  /**
   * List the stored revisions of a timeline.
   *
   * Each entry is the edit as it stood at that revision, so a caller can pick a point to
   * return to instead of guessing a number.
   *
   * @param timelineId - timeline to read.
   * @returns The stored revisions, newest first, with clip counts.
   */
  async timelineHistory(timelineId: string): Promise<Data> {
    await this.timeline(timelineId)
    const rows = (await this.open()).prepare('SELECT revision, clips, note, created_at FROM timeline_history WHERE timeline_id=? ORDER BY revision DESC').all(timelineId) as Array<{ revision: number, clips: string, note: string | null, created_at: number }>
    return {
      timeline_id: timelineId,
      entries: rows.map(row => ({ revision: row.revision, segment_count: (JSON.parse(row.clips) as Data[]).length, note: row.note, at: row.created_at })),
      note: rows.length === 0 ? '这条时间线还没有历史记录。' : '回滚用 video_timeline_revert，指定 revision。回滚本身也会留下一个新版本。',
    }
  }

  /**
   * Put a timeline back to an earlier revision.
   *
   * The revert is itself an edit: it advances the revision rather than restoring the old
   * number, so an undo stays undoable and nothing that already happened is erased. The
   * caller passes the revision they are looking at, which is what makes a concurrent
   * change fail loudly instead of being overwritten.
   *
   * @param a - timeline, the revision the caller read, and the revision to restore.
   * @returns The timeline after the restore.
   */
  async revertTimeline(a: { timeline_id: string, base_revision: number, target_revision: number }): Promise<Data> {
    await this.assertRevision(a.timeline_id, a.base_revision)
    const row = (await this.open()).prepare('SELECT clips FROM timeline_history WHERE timeline_id=? AND revision=?').get(a.timeline_id, a.target_revision) as { clips: string } | undefined
    if (row === undefined) throw new Error(`没有 revision ${a.target_revision} 的快照。用 video_timeline_history 看有哪些可回滚的版本。`)
    const clips = (JSON.parse(row.clips) as Array<{ asset_id: string, start_us: number, end_us: number, speed?: number, muted?: number }>)
      .map(clip => {
        const out: { asset_id: string, start_us: number, end_us: number, speed?: number, muted?: boolean } = { asset_id: clip.asset_id, start_us: clip.start_us, end_us: clip.end_us }
        if (typeof clip.speed === 'number' && clip.speed !== 1) out.speed = clip.speed
        if (clip.muted === 1) out.muted = true
        return out
      })
    if (clips.length === 0) throw new Error(`revision ${a.target_revision} 的快照是空的，无法回滚。`)
    // 回滚走 setSegments，它自己会记下这次回滚产生的版本，所以"回滚还能回滚回来"。
    const restored = await this.setSegments({ timeline_id: a.timeline_id, base_revision: a.base_revision, clips })
    return { timeline: restored, restored_from_revision: a.target_revision, note: `已回到 revision ${a.target_revision} 的样子；这次回滚本身记为 revision ${restored.revision}` }
  }

  /**
   * Split one clip into two at a point inside it.
   *
   * The cut position is given in the asset's own time, not as an offset into the clip:
   * the caller decides where to cut by looking at the source, and converting that to a
   * clip-relative offset is the kind of arithmetic that silently lands a frame off.
   *
   * A position outside the clip is refused rather than ignored: a no-op that reports
   * success would leave the caller believing a cut happened.
   *
   * @param a - timeline, the revision the caller read, which clip, and where to cut.
   * @returns The timeline with the clip replaced by two.
   */
  async splitSegment(a: { timeline_id: string, base_revision: number, ordinal: number, asset_time_us: number }): Promise<Data> {
    const timeline = await this.assertRevision(a.timeline_id, a.base_revision)
    const db = await this.open()
    const clip = db.prepare('SELECT asset_id, start_us, end_us, speed, muted FROM timeline_segments WHERE timeline_id=? AND ordinal=?').get(a.timeline_id, a.ordinal) as { asset_id: string, start_us: number, end_us: number, speed: number, muted: number } | undefined
    if (clip === undefined) throw new Error(`没有第 ${a.ordinal} 段`)
    const at = Math.round(a.asset_time_us)
    if (at <= clip.start_us || at >= clip.end_us) {
      throw new Error(`切点 ${at} 不在第 ${a.ordinal} 段内（该段是 ${clip.start_us}–${clip.end_us}）。切点必须落在段的内部，落在端点上等于没切。`)
    }
    // 两半继承原段的播放方式：变速与静音属于这一段素材，不属于它的某一边。
    db.prepare('DELETE FROM timeline_segments WHERE timeline_id=? AND ordinal=?').run(a.timeline_id, a.ordinal)
    db.prepare('UPDATE timeline_segments SET ordinal = ordinal + 1 WHERE timeline_id=? AND ordinal >= ?').run(a.timeline_id, a.ordinal)
    const insert = db.prepare('INSERT INTO timeline_segments (timeline_id,ordinal,asset_id,start_us,end_us,speed,muted) VALUES (?,?,?,?,?,?,?)')
    insert.run(a.timeline_id, a.ordinal, clip.asset_id, clip.start_us, at, clip.speed, clip.muted)
    insert.run(a.timeline_id, a.ordinal + 1, clip.asset_id, at, clip.end_us, clip.speed, clip.muted)
    this.refreshTimeline(a.timeline_id, a.base_revision + 1)
    await this.manifest(timeline.project_id)
    return { timeline: await this.timeline(a.timeline_id), split_at_us: at, note: `第 ${a.ordinal} 段在 ${round2(at / 1e6)} 秒处切成两段` }
  }

  /**
   * Join one clip with the next one.
   *
   * Only adjacent clips of the same asset and the same playback settings are joined.
   * Two clips of the same asset separated by another clip are not adjacent in the film,
   * and joining them would reorder the edit; different settings cannot be represented by
   * one clip at all.
   *
   * @param a - timeline, the revision the caller read, and the first of the two clips.
   * @returns The timeline with the two clips replaced by one.
   */
  async mergeSegments(a: { timeline_id: string, base_revision: number, ordinal: number }): Promise<Data> {
    const timeline = await this.assertRevision(a.timeline_id, a.base_revision)
    const db = await this.open()
    const first = db.prepare('SELECT asset_id, start_us, end_us, speed, muted FROM timeline_segments WHERE timeline_id=? AND ordinal=?').get(a.timeline_id, a.ordinal) as { asset_id: string, start_us: number, end_us: number, speed: number, muted: number } | undefined
    const second = db.prepare('SELECT asset_id, start_us, end_us, speed, muted FROM timeline_segments WHERE timeline_id=? AND ordinal=?').get(a.timeline_id, a.ordinal + 1) as { asset_id: string, start_us: number, end_us: number, speed: number, muted: number } | undefined
    if (first === undefined) throw new Error(`没有第 ${a.ordinal} 段`)
    if (second === undefined) throw new Error(`第 ${a.ordinal} 段后面没有可合并的段（它是最后一段）。`)
    if (first.asset_id !== second.asset_id) throw new Error(`第 ${a.ordinal} 与 ${a.ordinal + 1} 段来自不同素材，合成一段没有意义 —— 中间那段素材会消失。`)
    if (first.speed !== second.speed || first.muted !== second.muted) throw new Error(`两段的播放方式不同（变速 ${first.speed}/${second.speed}，静音 ${first.muted}/${second.muted}），合成一段无法同时表达这两种设置。先把设置调成一致。`)
    // 只有首尾相接才真的是连续的一段；中间有缺口时合并会把缺口也算进成片。
    if (first.end_us !== second.start_us) {
      throw new Error(`两段在素材上不连续（前段到 ${first.end_us}，后段从 ${second.start_us} 开始，相差 ${round2((second.start_us - first.end_us) / 1e6)} 秒）。合并会把中间那段画面也算进来，所以拒绝。若确实想连起来，请分别保留两段。`)
    }
    db.prepare('UPDATE timeline_segments SET end_us=? WHERE timeline_id=? AND ordinal=?').run(second.end_us, a.timeline_id, a.ordinal)
    db.prepare('DELETE FROM timeline_segments WHERE timeline_id=? AND ordinal=?').run(a.timeline_id, a.ordinal + 1)
    db.prepare('UPDATE timeline_segments SET ordinal = ordinal - 1 WHERE timeline_id=? AND ordinal > ?').run(a.timeline_id, a.ordinal + 1)
    this.refreshTimeline(a.timeline_id, a.base_revision + 1)
    await this.manifest(timeline.project_id)
    return { timeline: await this.timeline(a.timeline_id), note: `第 ${a.ordinal} 与 ${a.ordinal + 1} 段已合成一段（${round2((second.end_us - first.start_us) / 1e6)} 秒）` }
  }

  /**
   * Remove an asset and everything derived from it.
   *
   * Analyses, evidence and timelines that reference it go too: they describe frames that
   * no longer exist, and a timeline left pointing at a deleted asset would fail at export
   * instead of here.
   *
   * @param projectId - project owning the asset.
   * @param assetId - asset to remove.
   * @returns Counts of what was removed alongside it.
   */
  async deleteAsset(projectId: string, assetId: string): Promise<Data> {
    await this.asset(projectId, assetId)
    const db = await this.open()
    const timelines = (db.prepare('SELECT COUNT(*) AS n FROM timelines WHERE asset_id=?').get(assetId) as { n: number }).n
    const analyses = (db.prepare('SELECT COUNT(*) AS n FROM analyses WHERE asset_id=?').get(assetId) as { n: number }).n
    const evidence = (db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE asset_id=?').get(assetId) as { n: number }).n
    // 外键带级联，删素材会一并带走分析和证据；引用它的时间线也靠外键清掉。
    db.prepare('DELETE FROM assets WHERE id=?').run(assetId)
    await this.manifest(projectId)
    return { project_id: projectId, asset_id: assetId, removed_timelines: timelines, removed_analyses: analyses, removed_evidence: evidence, note: '素材记录已删除。OSS 上的对象没有被删（工具只管理索引），如需清理存储请自行处理桶内对象。' }
  }

  /**
   * Remove a project and everything under it.
   *
   * @param projectId - project to remove.
   * @returns Counts of what went with it.
   */
  async deleteProject(projectId: string): Promise<Data> {
    const db = await this.open()
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new Error(`找不到项目 ${projectId}`)
    const count = (sql: string): number => (db.prepare(sql).get(projectId) as { n: number }).n
    const assets = count('SELECT COUNT(*) AS n FROM assets WHERE project_id=?')
    const timelines = count('SELECT COUNT(*) AS n FROM timelines WHERE project_id=?')
    const proposals = count('SELECT COUNT(*) AS n FROM proposals WHERE project_id=?')
    const jobs = (db.prepare('SELECT COUNT(*) AS n FROM jobs j JOIN timelines t ON t.id=j.timeline_id WHERE t.project_id=?').get(projectId) as { n: number }).n
    db.prepare('DELETE FROM projects WHERE id=?').run(projectId)
    await this.manifest(projectId)
    return { project_id: projectId, removed_assets: assets, removed_timelines: timelines, removed_proposals: proposals, removed_jobs: jobs, note: '项目及其全部记录已删除。OSS 上的对象保留（工具只管理索引）。' }
  }

  /**
   * Give a timeline a name, or change the one it has.
   *
   * Separate from creation because a name is not part of the edit: it is what a person
   * calls the cut, and it becomes clear only after the cut exists. Leaving it settable
   * only at creation means a timeline made before anyone knew what to call it keeps a
   * null name forever.
   *
   * Renaming does not change the clips, so it does not advance the revision.
   *
   * @param timelineId - timeline to rename.
   * @param name - the new name; an empty string clears it.
   * @returns The timeline with its name updated.
   */
  async renameTimeline(timelineId: string, name: string): Promise<Data> {
    const timeline = await this.timeline(timelineId) as { project_id: string }
    const trimmed = name.trim()
    ;(await this.open()).prepare('UPDATE timelines SET name=? WHERE id=?').run(trimmed === '' ? null : trimmed, timelineId)
    await this.manifest(timeline.project_id)
    return this.timeline(timelineId)
  }

  /**
   * Re-read one candidate range and ask the model where it actually starts and ends.
   *
   * The first pass answers "where in this film is X" while looking at the whole film, so
   * its answer carries the imprecision of that view. Shown only the candidate — trimmed,
   * and at a higher frame rate than the whole-film proxy — the same question becomes a
   * boundary confirmation, which is a much easier decision and the last of the three ways
   * to raise precision described in the design.
   *
   * The model reports times relative to the clip it was given, so the window's start is
   * added back. The result is checked to stay inside the window: an answer outside it is
   * not a refinement of this candidate.
   *
   * @param assetPath - the asset whose bytes the candidate comes from.
   * @param candidate - the range to confirm, in asset microseconds.
   * @param signal - cancellation for the transcode, upload and model call.
   * @returns The confirmed range, or the candidate unchanged when the pass cannot run.
   */
  private async verifyBoundaries(assetPath: string, candidate: { start: number, end: number }, signal: AbortSignal): Promise<Data> {
    const padSeconds = this.config.verifyPadSeconds ?? 3
    const fps = this.config.verifyFps ?? 3
    const windowStart = Math.max(0, candidate.start / 1e6 - padSeconds)
    const windowEnd = candidate.end / 1e6 + padSeconds
    const source = await this.materialize(assetPath, signal)
    try {
      const file = await this.prepare(source.path, signal, { startSeconds: windowStart, endSeconds: windowEnd, fps })
      const key = `${this.config.ossPrefix.replace(/\/$/,'')}/verify/${randomUUID()}.mp4`
      const url = await this.stages.timed('上传核对片段', () => this.uploadFile(file, key, 'video/mp4'))
      const prompt = `这是一段视频的截取，原素材的第 ${round2(windowStart)} 秒到第 ${round2(windowEnd)} 秒。请只回答：其中目标内容真正开始和结束的时刻，用相对这段截取的时间（秒，可带一位小数）。只返回 JSON：{"start_seconds":0.0,"end_seconds":1.0,"found":true}。如果这段里根本没有目标内容，found 填 false。`
      const answer = await this.stages.timed('模型二次核对', () => this.ask(url, prompt, signal, { model: this.config.verifyModel }))
      if (answer.found === false) return { start: candidate.start, end: candidate.end, before: candidate, verified: false, note: '二次核对说这段里没有目标内容，保留原区间。' }
      const startSeconds = Number(answer.start_seconds); const endSeconds = Number(answer.end_seconds)
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        return { start: candidate.start, end: candidate.end, before: candidate, verified: false, note: '二次核对返回的区间无效，保留原区间。' }
      }
      const start = Math.round((windowStart + startSeconds) * 1e6)
      const end = Math.round((windowStart + endSeconds) * 1e6)
      // 只能收窄，不能越出被核对的那个窗口 —— 窗口外的答案不是在细化这个候选。
      if (start < candidate.start - 1_000_000 || end > candidate.end + 1_000_000) {
        return { start: candidate.start, end: candidate.end, before: candidate, verified: false, note: '二次核对跑到窗口外了，保留原区间。' }
      }
      return {
        start, end, before: candidate, verified: true,
        note: `二次核对：起止收窄到 ${round2(start / 1e6)}–${round2(end / 1e6)} 秒（原 ${round2(candidate.start / 1e6)}–${round2(candidate.end / 1e6)}）`,
        delta_us: (start - candidate.start) + (candidate.end - end),
      }
    } finally { await source.cleanup() }
  }

  /**
   * Point a finished job at a different object, for tests only.
   *
   * The check that a finished film actually contains picture can only be exercised by a
   * film that does not, and every film this workspace produces has picture. Reaching the
   * branch otherwise would mean fabricating a broken source video, which is a far larger
   * lie than pointing one row at a file that already exists.
   *
   * @param jobId - job to repoint.
   * @param key - object key the job's output should become.
   */
  async declareBrokenOutput(jobId: string, key: string): Promise<void> {
    ;(await this.open()).prepare('UPDATE jobs SET output=? WHERE id=?').run(`oss://${key}`, jobId)
  }

  /**
   * Read the on-screen text of a video, with the time each piece appeared.
   *
   * This is the one evidence kind that can be searched literally: a creator who remembers
   * a word they saw on screen can find it exactly, where a description of the picture can
   * only ever be found approximately. It is also what makes burned-in subtitles searchable
   * without a separate speech service.
   *
   * The picture is sampled rather than watched: frames are taken every
   * {@link Config.ocrSampleSeconds} and each is read on its own by {@link Config.ocrModel}.
   * The comment this replaces argued that per-frame reading would be "one call per frame —
   * hundreds of calls on a long video", and that is true; what it missed is that each of
   * those calls is cheap and independent, while one call that watches the whole video is
   * neither. Measured on the 43-minute asset, watching took 458.8s; reading costs about
   * 95ms per frame at concurrency 16.
   *
   * @param projectId - project owning the asset.
   * @param assetId - asset to read.
   * @param signal - cancellation for the frame extraction and every read.
   * @returns Per-entry text with the second it appeared at.
   */
  async ocrEvidence(projectId: string, assetId: string, signal: AbortSignal): Promise<Data> {
    const cached = await this.cachedEvidence(assetId, EVIDENCE_OCR, EVIDENCE_PROVIDER_VERSION)
    if (cached !== undefined) return cached
    const asset = await this.asset(projectId, assetId)
    this.stages.reset()
    const source = await this.stages.timed('准备素材', () => this.materialize(asset.path, signal))
    try {
      const duration = Number((await this.probe(source.path, signal)).duration_us) || 0
      const items = await this.stages.timed('读屏幕文字', () => this.readOnScreenText(source.path, duration, signal))
      const entries = this.sanitizeRanges(items, duration)
        .map(entry => ({ ...entry, text: String(entry.text ?? '').trim() }))
        .filter(entry => entry.text !== '')
      const record = {
        entries,
        entry_count: entries.length,
        duration_us: duration,
        note: entries.length === 0 ? '没有读出屏幕文字。若这段视频本来就没有字幕或图表，这是正确结果。' : null,
      }
      await this.saveEvidence(projectId, assetId, EVIDENCE_OCR, record, duration, EVIDENCE_PROVIDER_VERSION)
      return { asset_id: assetId, cached: false, ...record, stages: this.stages.snapshot() }
    } finally { await source.cleanup() }
  }

  /**
   * Transcribe what is said, with the time each line was spoken.
   *
   * The spoken words are the dimension a creator is most likely to search by — they
   * remember a phrase, not a timecode — and transcription is what turns that memory into
   * a range. It is read from the audio of the proxy by the same model that reads the
   * picture, so it needs no separate speech service and no second credential.
   *
   * The prompt refuses guesses on purpose. A model asked to transcribe will happily write
   * plausible sentences over music, silence or a language it does not know, and a
   * fabricated line is worse than a missing one: it becomes a search hit for words nobody
   * ever said, which a creator has no way to tell apart from a real one.
   *
   * @param projectId - project owning the asset.
   * @param assetId - asset to transcribe.
   * @param signal - cancellation for the transcode, upload and model call.
   * @returns Spoken lines with their times.
   */
  async transcriptEvidence(projectId: string, assetId: string, signal: AbortSignal): Promise<Data> {
    const cached = await this.cachedEvidence(assetId, EVIDENCE_TRANSCRIPT, EVIDENCE_PROVIDER_VERSION)
    if (cached !== undefined) return cached
    const asset = await this.asset(projectId, assetId)
    this.stages.reset()
    const source = await this.stages.timed('准备素材', () => this.materialize(asset.path, signal))
    try {
      const duration = Number((await this.probe(source.path, signal)).duration_us) || 0
      // 把音频单独交给识别模型，而不是把整段视频交给多模态模型。
      //
      // 后者是这条链路上代价最高的一次失败：43 分钟素材花了 192 秒，思考通道吃掉
      // 16384 token 后结构化输出为空，还被存成「这段视频没有人声」，随后引出 21 次
      // 整片重看（838 秒）。分窗也没救回来 —— 三种窗口尺寸都拿不到完整覆盖。
      // 换成识别模型后同一条素材 41 秒跑完，且专有名词全对。
      const audio = await this.stages.timed('提取音轨', () => this.extractAudio(source.path, signal))
      const key = `${this.config.ossPrefix.replace(/\/$/, '')}/asr-source-${randomUUID()}.m4a`
      const url = await this.stages.timed('上传音频', () => this.uploadFile(audio, key, 'audio/mp4'))
      const sentences = await this.stages.timed('语音识别', () => this.recognizeSpeech(url, signal))
      const lines = this.sanitizeRanges(sentences, duration)
        .map(line => ({ ...line, text: String(line.text ?? '').trim() }))
        .filter(line => line.text !== '')
      const record = {
        lines,
        line_count: lines.length,
        duration_us: duration,
        note: lines.length === 0 ? '没有转写出说话内容。若这段视频本来就没有人声，这是正确结果。' : null,
      }
      await this.saveEvidence(projectId, assetId, EVIDENCE_TRANSCRIPT, record, duration, EVIDENCE_PROVIDER_VERSION)
      return { asset_id: assetId, cached: false, ...record, stages: this.stages.snapshot() }
    } finally { await source.cleanup() }
  }

  /**
   * Describe what is on screen, with the time each description covers.
   *
   * Spoken words and screen text can only be searched for words that were actually said or
   * shown. A creator asking for "the part where it rains" has neither: the answer exists
   * only in the picture. This is the dimension that turns such a request into a range.
   *
   * The description is read from the same low-rate proxy as the other two passes, and is
   * written to describe what a viewer would see rather than to interpret it — an
   * interpretation ("the mood darkens") cannot be matched against a later question, while
   * an observation ("the screen fades to black") can.
   *
   * @param projectId - project owning the asset.
   * @param assetId - asset to describe.
   * @param signal - cancellation for the transcode, upload and model call.
   * @returns Scene descriptions with their times.
   */
  async visualEvidence(projectId: string, assetId: string, signal: AbortSignal): Promise<Data> {
    const cached = await this.cachedEvidence(assetId, EVIDENCE_VISUAL, EVIDENCE_PROVIDER_VERSION)
    if (cached !== undefined) return cached
    const asset = await this.asset(projectId, assetId)
    this.stages.reset()
    const source = await this.stages.timed('准备素材', () => this.materialize(asset.path, signal))
    try {
      const duration = Number((await this.probe(source.path, signal)).duration_us) || 0
      const { items, failedWindows } = await this.extractInWindows({
        path: source.path,
        durationUs: duration,
        field: 'scenes',
        benign: '画面没有可描述的内容',
        stage: '模型描述画面',
        keyPrefix: 'visual-window',
        // 描述画面只需要「看」，不需要「听」，所以用它自己的模型，
        // 不为一个用不到的能力付费。
        model: this.config.visionModel,
        signal,
        prompt: [
          '按时间顺序描述这段视频里**画面上发生了什么**，每段标明起止时间。',
          '只返回 JSON：{"scenes":[{"start_us":0,"end_us":1,"description":"","on_screen":[""]}]}。',
          '要求：',
          '1. description 写**看得见的东西**：谁、在哪里、在做什么、画面怎么变化。不要写情绪、评价或推测。',
          '2. on_screen 列出这一刻画面上出现的人物、物体、地点等具体名词，供以后检索用。',
          '3. 画面发生明显变化时另起一段；一直没变就一整段。',
          '4. 一段描述覆盖的画面必须真的是同一段，不要合并前后不同的场景。',
          '5. 直接输出 JSON，不要先在脑子里过一遍全片 —— 那样回复会超长度上限，最后一段都留不下来。',
        ].join('\n'),
      })
      const scenes = this.sanitizeRanges(items, duration)
        .map(scene => ({
          ...scene,
          description: String(scene.description ?? '').trim(),
          on_screen: Array.isArray(scene.on_screen) ? scene.on_screen.map((x: unknown) => String(x).trim()).filter((x: string) => x !== '') : [],
        }))
        .filter(scene => scene.description !== '')
      const record = {
        scenes,
        scene_count: scenes.length,
        duration_us: duration,
        note: scenes.length === 0 ? '没有描述出画面内容。' : null,
        failed_windows: failedWindows.length === 0 ? null : failedWindows.map(index => index + 1),
      }
      await this.saveEvidence(projectId, assetId, EVIDENCE_VISUAL, record, duration, EVIDENCE_PROVIDER_VERSION)
      return { asset_id: assetId, cached: false, ...record, stages: this.stages.snapshot() }
    } finally { await source.cleanup() }
  }

  /**
   * Export a timeline's subtitles, timed to the finished film.
   *
   * Evidence times are positions in the source asset, but a subtitle is read against the
   * exported film — after clips have been reordered, trimmed, and possibly sped up. The
   * mapping is therefore done here rather than left to the caller: a cue that is placed by
   * its asset time lands in the wrong place the moment anything is cut, and the mistake is
   * invisible until someone watches the film.
   *
   * An entry that crosses a cut is split rather than moved, because the film genuinely
   * contains two pieces of it in two places; dropping it would lose words that are heard,
   * and keeping it whole would put words on screen while nothing is said.
   *
   * @param timelineId - timeline to subtitle.
   * @param source - which evidence to take the words from.
   * @param format - `srt` or `vtt`.
   * @param signal - cancellation for the upload when writing the file.
   * @returns The cues, and the file when one was written.
   */
  /**
   * Map evidence text onto a timeline's own time, ready to be shown over the film.
   *
   * Evidence times are positions in the source asset, but a subtitle is read against the
   * exported film — after clips have been reordered, trimmed, and possibly sped up. Every
   * consumer of subtitles needs the same mapping, so it lives here rather than in each of
   * them: a second copy would drift, and a subtitle that is correct when exported as a file
   * but wrong when burned into the picture is the worst kind of inconsistency.
   *
   * An entry that crosses a cut is split rather than moved, because the film genuinely
   * contains two pieces of it in two places; dropping it would lose words that are heard,
   * and keeping it whole would put words on screen while nothing is said.
   *
   * @param timelineId - timeline the film comes from.
   * @param source - which evidence the words come from.
   * @returns Cues in film time, and the film's total length.
   */
  private async subtitleCues(timelineId: string, source: 'transcript' | 'screen-text'): Promise<{ cues: Array<{ start_us: number, end_us: number, text: string, clip: number }>, outputUs: number, clipCount: number }> {
    const timeline = await this.timeline(timelineId) as { segments: Array<{ asset_id: string, start_us: number, end_us: number, speed: number }> }
    const clips = timeline.segments
    if (clips.length === 0) throw new Error(`时间线 ${timelineId} 没有任何片段，字幕没有依据。`)
    const db = await this.open()
    const kind = source === 'screen-text' ? EVIDENCE_OCR : EVIDENCE_TRANSCRIPT
    const rows = db.prepare('SELECT asset_id, payload FROM evidence WHERE kind=?').all(kind) as Array<{ asset_id: string, payload: string }>
    const byAsset = new Map<string, Array<{ start_us: number, end_us: number, text: string }>>()
    for (const row of rows) {
      const parsed = JSON.parse(row.payload) as { lines?: Data[], entries?: Data[] }
      const items = (parsed.lines ?? parsed.entries ?? []).map(item => ({ start_us: Number(item.start_us), end_us: Number(item.end_us), text: String(item.text ?? '').trim() }))
      byAsset.set(row.asset_id, items)
    }
    const cues: Array<{ start_us: number, end_us: number, text: string, clip: number }> = []
    let offsetUs = 0
    clips.forEach((clip, index) => {
      const speed = Number(clip.speed) || 1
      for (const item of byAsset.get(clip.asset_id) ?? []) {
        if (item.text === '') continue
        // 与这一段在素材上的区间求交：交集为空说明这句不在这段里。
        const from = Math.max(item.start_us, Number(clip.start_us))
        const to = Math.min(item.end_us, Number(clip.end_us))
        if (to <= from) continue
        // 交集可能是不完整的一句（这句话被切点截断了），它在成片里确实被听到，
        // 所以保留，时间按交集算。
        cues.push({
          start_us: Math.round(offsetUs + (from - Number(clip.start_us)) / speed),
          end_us: Math.round(offsetUs + (to - Number(clip.start_us)) / speed),
          text: item.text,
          clip: index,
        })
      }
      offsetUs += (Number(clip.end_us) - Number(clip.start_us)) / speed
    })
    cues.sort((a, b) => a.start_us - b.start_us)
    return { cues, outputUs: Math.round(offsetUs), clipCount: clips.length }
  }

  async exportSubtitles(timelineId: string, source: 'transcript' | 'screen-text', format: 'srt' | 'vtt', signal: AbortSignal): Promise<Data> {
    const timeline = await this.timeline(timelineId) as { project_id: string }
    // 被取消时不要再往下做：导出的后半段是上传，取消之后再传文件没有意义。
    if (signal.aborted) throw new Error('导出字幕被取消。')
    const mapped = await this.subtitleCues(timelineId, source)
    const cues = mapped.cues
    const lastUs = mapped.outputUs
    const rendered = format === 'vtt' ? renderVtt(cues) : renderSrt(cues)
    const key = `${this.config.ossOutputPrefix.replace(/\/$/, '')}/${timeline.project_id}/${timelineId}.${format}`
    const local = join(this.config.dataDir, 'tmp', `subtitle-${randomUUID()}.${format}`)
    await mkdir(dirname(local), { recursive: true })
    await writeFile(local, rendered, 'utf8')
    const oss_url = await this.stages.timed('上传字幕', () => this.uploadFile(local, key, format === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8'))
    await rm(local, { force: true })
    return {
      timeline_id: timelineId,
      source, format,
      cue_count: cues.length,
      clip_count: mapped.clipCount,
      output_seconds: round2(lastUs / 1e6),
      cues: cues.map(cue => ({ start_us: cue.start_us, end_us: cue.end_us, start: timecode(cue.start_us, format === 'vtt'), text: cue.text, clip: cue.clip })),
      content: rendered,
      oss_key: key,
      oss_url,
      note: cues.length === 0
        ? `这条时间线覆盖的片段里没有 ${source === 'screen-text' ? '屏幕文字' : '语音转写'}证据。先对该素材调用 video_evidence_${source === 'screen-text' ? 'ocr' : 'transcript'}。`
        : '时间已换算到成片坐标：片段被重排、裁剪或变速之后，字幕仍然对得上。跨切点的句子按交集拆成多条，因为成片里它确实分在两处。',
    }
  }

  /**
   * Collect everything the evidence says about one range.
   *
   * A "similar segment" has to be similar in something, and the only description of a
   * segment this system owns is the evidence attached to it. Gathering it here means the
   * comparison is against recorded facts rather than against the model's memory of a film
   * it saw once, and it lets the caller show the user why two ranges were called alike.
   *
   * @param assetId - asset the range belongs to.
   * @param startUs - range start, in asset microseconds.
   * @param endUs - range end, in asset microseconds.
   * @returns The spoken lines, on-screen text, described scenes and analysis passages that overlap the range.
   */
  private async evidenceOfRange(assetId: string, startUs: number, endUs: number): Promise<Data> {
    const db = await this.open()
    const read = (kind: string): Data[] => {
      const row = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, kind) as { payload: string } | undefined
      if (row === undefined) return []
      const parsed = JSON.parse(row.payload) as { lines?: Data[], entries?: Data[], scenes?: Data[] }
      return parsed.lines ?? parsed.entries ?? parsed.scenes ?? []
    }
    const overlaps = (item: Data): boolean => {
      const from = Number(item.start_us); const to = Number(item.end_us)
      return Number.isFinite(from) && Number.isFinite(to) && to > startUs && from < endUs
    }
    const transcript = read(EVIDENCE_TRANSCRIPT).filter(overlaps).map(item => String(item.text ?? '')).filter(text => text !== '')
    const screenText = read(EVIDENCE_OCR).filter(overlaps).map(item => String(item.text ?? '')).filter(text => text !== '')
    const scenes = read(EVIDENCE_VISUAL).filter(overlaps).map(item => String(item.description ?? '')).filter(text => text !== '')
    const analyses = db.prepare('SELECT data FROM analyses WHERE asset_id=?').all(assetId) as Array<{ data: string }>
    const passages: string[] = []
    for (const analysis of analyses) {
      for (const segment of (JSON.parse(analysis.data) as { segments?: Data[] }).segments ?? []) {
        const from = Number(segment.start_us); const to = Number(segment.end_us)
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= startUs || from >= endUs) continue
        const text = this.segmentText(segment)
        if (text !== '') passages.push(text)
      }
    }
    return { spoken: transcript, on_screen: screenText, scenes, analysis: passages }
  }

  /**
   * Find other ranges that resemble a given one.
   *
   * Asked for "more like this", a creator means the content, not the file position. The
   * reference is described by its own evidence rather than by a position alone, so the
   * answer can be checked: a caller can read the two ranges' descriptions side by side and
   * see whether the model's claim holds. Similarity comes from the model rather than from
   * an embedding index, which keeps this working with the same credential as everything
   * else and needs no per-asset precomputation.
   *
   * The reference range is excluded from the answer: a range is trivially similar to
   * itself, and returning it would waste the caller's attention on a segment they already
   * have.
   *
   * @param projectId - project owning the asset.
   * @param assetId - asset to search.
   * @param startUs - the range to find others like.
   * @param endUs - the range to find others like.
   * @param signal - cancellation for the download, upload and model call.
   * @returns Candidate ranges, each with why it was called similar.
   */
  async findSimilar(a: { project_id: string, asset_id: string, start_us: number, end_us: number }, signal: AbortSignal): Promise<Data> {
    const asset = await this.asset(a.project_id, a.asset_id)
    const duration = await this.durationOf(a.asset_id)
    const start = Math.max(0, Math.round(a.start_us))
    const end = Math.round(a.end_us)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(`区间无效：start_us=${a.start_us} end_us=${a.end_us}`)
    const evidence = await this.evidenceOfRange(a.asset_id, start, end)
    const spoken = (evidence.spoken as string[]) ?? []
    const onScreen = (evidence.on_screen as string[]) ?? []
    const scenes = (evidence.scenes as string[]) ?? []
    const passages = (evidence.analysis as string[]) ?? []
    if (spoken.length + onScreen.length + scenes.length + passages.length === 0) {
      throw new Error(`区间 ${round2(start / 1e6)}–${round2(end / 1e6)} 秒上没有任何证据可以拿来做参照。先对素材调用 video_evidence_* 把证据算出来。`)
    }
    this.stages.reset()
    const source = await this.stages.timed('准备素材', () => this.materialize(asset.path, signal))
    try {
      const proxy = await this.prepare(source.path, signal)
      const url = await this.stages.timed('上传素材', () => this.uploadFile(proxy, `${this.config.ossPrefix.replace(/\/$/, '')}/similar-source-${randomUUID()}.mp4`, 'video/mp4'))
      // 参照物就是证据本身，写进提示词里让模型对照 —— 而不是让它凭印象判断"像不像"。
      const reference = [
        spoken.length === 0 ? '' : `这一段说的话：${spoken.join(' / ')}`,
        onScreen.length === 0 ? '' : `这一段屏幕上的字：${onScreen.join(' / ')}`,
        scenes.length === 0 ? '' : `这一段画面：${scenes.join(' / ')}`,
        passages.length === 0 ? '' : `这一段的分段描述：${passages.join(' / ')}`,
      ].filter(line => line !== '').join('\n')
      const answer = await this.stages.timed('模型找相似片段', () => this.ask(url, [
        `视频里第 ${round2(start / 1e6)} 秒到第 ${round2(end / 1e6)} 秒这一段，内容是这样的：`,
        reference,
        '',
        '请找出这段视频里**其他内容与之相似**的时间段（同一个人、同一类画面、同一类情节、在讲同一件事都算）。',
        '只返回 JSON：{"matches":[{"start_us":0,"end_us":1,"reason":"","confidence":0.0}]}。',
        '要求：',
        '1. **不要把上面那一段本身再报一次** —— 它已经是参照物了。',
        '2. reason 写清"像在哪里"，要具体到画面或话，不要只写"很相似"。',
        '3. 确实没有相似的就返回 {"matches":[]}，不要为了凑数把不相干的段落报进来。',
        `4. 区间不要越过素材边界（0 到 ${duration === undefined ? '末尾' : round2(duration / 1e6) + ' 秒'}）。`,
      ].join('\n'), signal))
      // 先按区间筛掉参照物本身，再补上清洗后的 reason。
      // 顺序反过来的话，展开 Data 会把区间字段收窄掉，取不到 start_us/end_us。
      const matches = this.sanitizeRanges(answer.matches, duration)
        // 参照区间自己不算答案：它与自己必然相似，报回来只是浪费注意力。
        .filter(match => Number(match.end_us) <= start || Number(match.start_us) >= end)
        .map(match => ({ ...match, reason: String(match.reason ?? '').trim() }))
      return {
        asset_id: a.asset_id,
        reference: { start_us: start, end_us: end, seconds: round2((end - start) / 1e6) },
        reference_evidence: evidence,
        matches,
        match_count: matches.length,
        stages: this.stages.snapshot(),
        note: matches.length === 0
          ? '没有找到与这一段相似的其它片段。'
          : '每条的 reason 说明它像在哪里；参照区间本身已从结果里剔除。',
      }
    } finally { await source.cleanup() }
  }

  /**
   * Assemble every evidence dimension into one payload on a shared time axis.
   *
   * The dimensions are stored separately because each is computed by a different pass and
   * consumed by a different question. A view of them has the opposite requirement: the
   * curves, marks and tracks must share one axis or they cannot be read against each other,
   * and the reader is a panel rather than a model — so this returns numbers, not prose.
   *
   * Absolute times are kept alongside normalised positions. A panel needs positions to
   * draw with, but a click has to come back as a time the other tools accept, and deriving
   * that from a normalised position would round-trip through the panel's own width.
   *
   * Loudness is reduced to whole tenths of a decibel. The samples are drawn as a curve a
   * few hundred pixels wide, so finer precision would cost payload without changing a pixel.
   *
   * @param projectId - project owning the asset.
   * @param assetId - asset to summarise.
   * @param timelineId - optional timeline whose segments are marked on the same axis.
   * @returns Every dimension, positioned on the asset's own time axis.
   */
  async evidenceView(projectId: string, assetId: string, timelineId?: string): Promise<Data> {
    await this.asset(projectId, assetId)
    const duration = (await this.durationOf(assetId)) ?? 0
    const db = await this.open()
    const payloadOf = (kind: string): Data | undefined => {
      const row = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(assetId, kind) as { payload: string } | undefined
      return row === undefined ? undefined : JSON.parse(row.payload) as Data
    }
    const at = (us: number): number => (duration === 0 ? 0 : round4(Math.min(1, Math.max(0, us / duration))))

    const acoustic = payloadOf(EVIDENCE_ACOUSTIC) as { levelsDbfs?: number[], windowUs?: number, floorDbfs?: number, peakDbfs?: number, loudDbfs?: number } | undefined
    const levels = acoustic?.levelsDbfs ?? []
    const windowUs = Number(acoustic?.windowUs ?? 1_000_000)

    const shots = ((payloadOf(EVIDENCE_SHOTS) as { shots?: Array<{ startUs: number, endUs: number }> } | undefined)?.shots ?? [])
      .map(shot => ({ start_us: Math.round(shot.startUs), end_us: Math.round(shot.endUs), start: at(shot.startUs), end: at(shot.endUs) }))

    // 时序证据的 payload 用的是 camelCase（startUs），和声学、镜头两维一致；
    // 这里必须跟着转成 start_us。写成 start_us 曾经让每个停顿都变成 null ——
    // 面板画不出停顿，而且 counts 还报 1，看上去像是有数据。
    const timing = (payloadOf(EVIDENCE_TIMING) as { silences?: Array<{ startUs: number, endUs: number }> } | undefined)?.silences ?? []
    const silences = timing
      .filter(silence => Number.isFinite(silence.startUs) && Number.isFinite(silence.endUs) && silence.endUs > silence.startUs)
      .map(silence => ({ start_us: Math.round(silence.startUs), end_us: Math.round(silence.endUs), start: at(silence.startUs), end: at(silence.endUs) }))

    const track = (kind: string, key: 'lines' | 'entries'): Array<{ start_us: number, end_us: number, start: number, end: number, text: string }> => {
      const items = ((payloadOf(kind) as Data | undefined)?.[key] ?? []) as Array<{ start_us: number, end_us: number, text: string }>
      return items
        .map(item => ({ start_us: Math.round(Number(item.start_us)), end_us: Math.round(Number(item.end_us)), start: at(Number(item.start_us)), end: at(Number(item.end_us)), text: String(item.text ?? '') }))
        .filter(item => item.text !== '')
    }

    const scenes = (((payloadOf(EVIDENCE_VISUAL) as Data | undefined)?.scenes ?? []) as Array<{ start_us: number, end_us: number, description: string }>)
      .map(scene => ({ start_us: Math.round(Number(scene.start_us)), end_us: Math.round(Number(scene.end_us)), start: at(Number(scene.start_us)), end: at(Number(scene.end_us)), description: String(scene.description ?? '') }))

    const analyses = db.prepare('SELECT instruction, data FROM analyses WHERE asset_id=?').all(assetId) as Array<{ instruction: string, data: string }>
    const chapters: Data[] = []
    for (const analysis of analyses) {
      for (const segment of (JSON.parse(analysis.data) as { segments?: Data[] }).segments ?? []) {
        const start = Number(segment.start_us); const end = Number(segment.end_us)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
        chapters.push({
          start_us: Math.round(start), end_us: Math.round(end), start: at(start), end: at(end),
          summary: this.segmentText(segment).slice(0, 120),
          is_highlight: segment.is_highlight === true,
          from_instruction: analysis.instruction,
        })
      }
    }

    let timeline: Data | undefined
    if (timelineId !== undefined) {
      const row = await this.timeline(timelineId) as { segments: Array<{ asset_id: string, start_us: number, end_us: number, speed: number, muted: number }>, revision: number }
      timeline = {
        timeline_id: timelineId,
        revision: row.revision,
        segments: row.segments.map((segment, ordinal) => ({
          ordinal,
          asset_id: segment.asset_id,
          start_us: Math.round(Number(segment.start_us)), end_us: Math.round(Number(segment.end_us)),
          start: at(Number(segment.start_us)), end: at(Number(segment.end_us)),
          speed: Number(segment.speed), muted: Number(segment.muted) === 1,
          // 这一段属于别的素材时，它在**这条素材**的时间轴上没有位置 —— 画出来会误导。
          on_this_axis: segment.asset_id === assetId,
        })),
      }
    }

    const transcript = track(EVIDENCE_TRANSCRIPT, 'lines')
    const screenText = track(EVIDENCE_OCR, 'entries')
    return {
      asset_id: assetId,
      project_id: projectId,
      duration_us: duration,
      duration_seconds: round2(duration / 1e6),
      name: String((db.prepare('SELECT meta FROM assets WHERE id=?').get(assetId) as { meta?: string } | undefined)?.meta === undefined ? '' : (JSON.parse((db.prepare('SELECT meta FROM assets WHERE id=?').get(assetId) as { meta: string }).meta) as { name?: string }).name ?? '') || null,
      dimensions: {
        loudness: levels.length === 0 ? null : {
          // floor/peak 一起给：曲线只有配上它自己的动态范围才有意义，
          // 固定阈值会把动态小的素材标出一片假峰值。
          floor_dbfs: acoustic?.floorDbfs ?? null,
          peak_dbfs: acoustic?.peakDbfs ?? null,
          loud_dbfs: acoustic?.loudDbfs ?? null,
          window_us: windowUs,
          samples: levels.map((level, index) => ({ at: at(index * windowUs), db: Math.round(level * 10) / 10 })),
        },
        shots,
        silences,
        transcript,
        screen_text: screenText,
        scenes,
        chapters,
      },
      timeline: timeline ?? null,
      counts: {
        loudness_samples: levels.length,
        shots: shots.length,
        silences: silences.length,
        transcript_lines: transcript.length,
        screen_text_entries: screenText.length,
        scenes: scenes.length,
        chapters: chapters.length,
      },
      missing: [EVIDENCE_ACOUSTIC, EVIDENCE_SHOTS, EVIDENCE_TIMING, EVIDENCE_TRANSCRIPT, EVIDENCE_OCR, EVIDENCE_VISUAL]
        .filter(kind => payloadOf(kind) === undefined),
      note: '这是给证据面板用的数据：所有维度共用同一条时间轴，位置是 0–1 的归一化值，同时保留绝对微秒用于回跳。',
    }
  }

  /** Reject an edit based on a stale read, and return the current row. */
  private async assertRevision(timelineId: string, baseRevision: number): Promise<{ revision: number, project_id: string }> {
    const row = await this.timeline(timelineId) as { revision: number, project_id: string }
    if (row.revision !== baseRevision) throw new Error(`revision conflict: 当前是 ${row.revision}，你基于 ${baseRevision} 在改。请重新读取时间线后再改。`)
    return row
  }

  /**
   * Append one clip to a timeline.
   *
   * The clip may come from any asset in the same project, which is what makes a
   * highlight reel possible: one analysis returns the spans, but a finished cut may
   * draw on several recordings.
   */
  async addSegment(a: { timeline_id: string, base_revision: number, asset_id: string, start_us: number, end_us: number, speed?: number }): Promise<Data> {
    const timeline = await this.assertRevision(a.timeline_id, a.base_revision)
    await this.assertRange(a.asset_id, a.start_us, a.end_us)
    await this.assertAssetInProject(timeline.project_id, a.asset_id)
    if (a.speed !== undefined && !(a.speed > 0)) throw new Error(`speed 必须大于 0，收到 ${a.speed}`)
    const db = await this.open()
    const next = (db.prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM timeline_segments WHERE timeline_id=?').get(a.timeline_id) as { n: number }).n
    db.prepare('INSERT INTO timeline_segments (timeline_id,ordinal,asset_id,start_us,end_us,speed,muted) VALUES (?,?,?,?,?,?,0)').run(a.timeline_id, next, a.asset_id, a.start_us, a.end_us, a.speed ?? 1)
    this.refreshTimeline(a.timeline_id, a.base_revision + 1)
    await this.manifest(timeline.project_id)
    return this.timeline(a.timeline_id)
  }

  /** Remove one clip by position, closing the gap so ordinals stay contiguous. */
  async removeSegment(a: { timeline_id: string, base_revision: number, ordinal: number }): Promise<Data> {
    const timeline = await this.assertRevision(a.timeline_id, a.base_revision)
    const db = await this.open()
    const count = (db.prepare('SELECT COUNT(*) AS n FROM timeline_segments WHERE timeline_id=?').get(a.timeline_id) as { n: number }).n
    if (!Number.isInteger(a.ordinal) || a.ordinal < 0 || a.ordinal >= count) throw new Error(`没有第 ${a.ordinal} 段：这条时间线共 ${count} 段（序号从 0 开始）`)
    if (count === 1) throw new Error('这是唯一的一段，删掉后时间线就没有内容了。若确实不要，请删除整条时间线。')
    db.prepare('DELETE FROM timeline_segments WHERE timeline_id=? AND ordinal=?').run(a.timeline_id, a.ordinal)
    db.prepare('UPDATE timeline_segments SET ordinal = ordinal - 1 WHERE timeline_id=? AND ordinal > ?').run(a.timeline_id, a.ordinal)
    this.refreshTimeline(a.timeline_id, a.base_revision + 1)
    await this.manifest(timeline.project_id)
    return this.timeline(a.timeline_id)
  }

  /**
   * Move the clip at `from` so it sits at `to`.
   *
   * Renumbering parks every row above the current ordinals before assigning the final
   * numbers. The key is `(timeline_id, ordinal)`, so renumbering in place collides
   * part-way through — and the parking offset must exceed every ordinal in use, because
   * a row parked below the ones still to be moved would be matched again by the
   * `WHERE ordinal = ?` that moves them, renumbering it twice.
   */
  async reorderSegment(a: { timeline_id: string, base_revision: number, from: number, to: number }): Promise<Data> {
    const timeline = await this.assertRevision(a.timeline_id, a.base_revision)
    const db = await this.open()
    const rows = db.prepare('SELECT ordinal, asset_id, start_us, end_us, speed, muted FROM timeline_segments WHERE timeline_id=? ORDER BY ordinal').all(a.timeline_id) as Data[]
    if (!Number.isInteger(a.from) || a.from < 0 || a.from >= rows.length) throw new Error(`没有第 ${a.from} 段：这条时间线共 ${rows.length} 段`)
    const to = Math.max(0, Math.min(rows.length - 1, a.to))
    const moved = rows.splice(a.from, 1)[0]
    if (moved === undefined) throw new Error(`没有第 ${a.from} 段`)
    rows.splice(to, 0, moved)
    // `rows` is now the order the clips should have, but each row still carries the
    // ordinal it was read with, and `ordinal` is the slot a clip occupies rather than a
    // label attached to it. Parking therefore has to move each row out of the slot it
    // currently sits in — looked up by that row's own ordinal, not by its index in
    // `rows` — while placing writes the index. Both directions run high-to-low so every
    // `WHERE ordinal = ?` still finds a row that no earlier step has already moved, and
    // the parking slots are negative so they never collide with a real position.
    const shift = db.prepare('UPDATE timeline_segments SET ordinal=? WHERE timeline_id=? AND ordinal=?')
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]
      if (row === undefined) continue
      shift.run(ORDINAL_PARKING - index, a.timeline_id, Number(row.ordinal))
    }
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]
      if (row === undefined) continue
      shift.run(ORDINAL_PARKING - index, a.timeline_id, Number(row.ordinal))
    }
    for (let index = rows.length - 1; index >= 0; index--) shift.run(index, a.timeline_id, ORDINAL_PARKING - index)
    this.refreshTimeline(a.timeline_id, a.base_revision + 1)
    await this.manifest(timeline.project_id)
    return this.timeline(a.timeline_id)
  }

  /**
   * Shorten one clip by moving one of its edges.
   *
   * Which edge moves is stated rather than inferred: "cut 10 seconds" is ambiguous, and
   * guessing wrong silently changes what the clip opens on.
   */
  async trimSegment(a: { timeline_id: string, base_revision: number, ordinal: number, edge: 'start' | 'end', delta_us: number }): Promise<Data> {
    const timeline = await this.assertRevision(a.timeline_id, a.base_revision)
    const db = await this.open()
    const row = db.prepare('SELECT asset_id, start_us, end_us FROM timeline_segments WHERE timeline_id=? AND ordinal=?').get(a.timeline_id, a.ordinal) as { asset_id: string, start_us: number, end_us: number } | undefined
    if (row === undefined) throw new Error(`没有第 ${a.ordinal} 段`)
    const start = a.edge === 'start' ? row.start_us + a.delta_us : row.start_us
    const end = a.edge === 'end' ? row.end_us - a.delta_us : row.end_us
    await this.assertRange(row.asset_id, start, end)
    db.prepare('UPDATE timeline_segments SET start_us=?, end_us=? WHERE timeline_id=? AND ordinal=?').run(start, end, a.timeline_id, a.ordinal)
    this.refreshTimeline(a.timeline_id, a.base_revision + 1)
    await this.manifest(timeline.project_id)
    return this.timeline(a.timeline_id)
  }

  /** Change one clip's playback speed or mute it, leaving its source range alone. */
  async adjustSegment(a: { timeline_id: string, base_revision: number, ordinal: number, speed?: number, muted?: boolean }): Promise<Data> {
    const timeline = await this.assertRevision(a.timeline_id, a.base_revision)
    if (a.speed !== undefined && !(a.speed > 0)) throw new Error(`speed 必须大于 0，收到 ${a.speed}`)
    const db = await this.open()
    const row = db.prepare('SELECT speed, muted FROM timeline_segments WHERE timeline_id=? AND ordinal=?').get(a.timeline_id, a.ordinal) as { speed: number, muted: number } | undefined
    if (row === undefined) throw new Error(`没有第 ${a.ordinal} 段`)
    db.prepare('UPDATE timeline_segments SET speed=?, muted=? WHERE timeline_id=? AND ordinal=?').run(a.speed ?? row.speed, (a.muted === undefined ? row.muted === 1 : a.muted) ? 1 : 0, a.timeline_id, a.ordinal)
    this.refreshTimeline(a.timeline_id, a.base_revision + 1)
    await this.manifest(timeline.project_id)
    return this.timeline(a.timeline_id)
  }

  /**
   * Replace the whole clip list in one step.
   *
   * Used when the caller already holds the finished edit — the kept intervals from the
   * timing evidence, for instance — and applying it clip by clip would bump the revision
   * once per clip and leave a half-applied edit readable in between.
   */
  async setSegments(a: { timeline_id: string, base_revision: number, clips: Array<{ asset_id: string, start_us: number, end_us: number, speed?: number, muted?: boolean }> }): Promise<Data> {
    const timeline = await this.assertRevision(a.timeline_id, a.base_revision)
    if (a.clips.length === 0) throw new Error('片段列表不能为空：时间线至少要有一段。')
    for (const clip of a.clips) {
      await this.assertRange(clip.asset_id, clip.start_us, clip.end_us)
      await this.assertAssetInProject(timeline.project_id, clip.asset_id)
      if (clip.speed !== undefined && !(clip.speed > 0)) throw new Error(`speed 必须大于 0，收到 ${clip.speed}`)
    }
    const db = await this.open()
    db.prepare('DELETE FROM timeline_segments WHERE timeline_id=?').run(a.timeline_id)
    const insert = db.prepare('INSERT INTO timeline_segments (timeline_id,ordinal,asset_id,start_us,end_us,speed,muted) VALUES (?,?,?,?,?,?,?)')
    a.clips.forEach((clip, index) => insert.run(a.timeline_id, index, clip.asset_id, clip.start_us, clip.end_us, clip.speed ?? 1, clip.muted === true ? 1 : 0))
    this.refreshTimeline(a.timeline_id, a.base_revision + 1)
    await this.manifest(timeline.project_id)
    return this.timeline(a.timeline_id)
  }
  /**
   * Cut the timeline's range out of its asset and upload the result.
   *
   * A stream copy is frame-accurate only while the requested start sits on a keyframe
   * of the source; otherwise the cut can only begin at the keyframe before it. The
   * keyframe distance is therefore measured first, and a source whose keyframes are
   * far apart is re-encoded instead — slower, but the clip starts where it was asked
   * to. The result records which path ran and the measured distance, so a caller can
   * see why a render took longer than a copy.
   */
  /**
   * Export a timeline by cutting each clip and concatenating the results.
   *
   * Every clip is cut on its own before the join, rather than concatenating the source
   * ranges in one filter graph. That keeps each cut on the same path as a single-clip
   * export — including the keyframe check that decides between copying and re-encoding —
   * so a clip's first frame is where the caller asked for it, not wherever the previous
   * keyframe happened to be.
   *
   * Clips are therefore cut from the same asset with the same settings, which is what
   * lets the join run at the container level. A clip that needed re-encoding while its
   * neighbour was copied keeps the join honest by matching the copy path's codec
   * parameters; the two cannot be mixed, so the decision is made once for the export.
   */
  async render(timelineId: string, filename: string | undefined, signal: AbortSignal, options: { aspect?: 'keep' | '16:9' | '9:16' | '1:1', focus?: 'left' | 'center' | 'right', burnSubtitles?: 'transcript' | 'screen-text' } = {}): Promise<Data> {
    const timeline = await this.timeline(timelineId) as { project_id: string, segments: Array<{ asset_id: string, start_us: number, end_us: number, speed: number, muted: number }> }
    const clips = timeline.segments
    if (clips.length === 0) throw new Error(`时间线 ${timelineId} 没有任何片段，无法导出。`)
    const name = this.safeFilename(filename ?? `${timelineId}.mp4`)
    const id = `job-${randomUUID()}`
    const db = await this.open()
    db.prepare('INSERT INTO jobs (id,timeline_id,status,output,detail) VALUES (?,?,?,?,?)').run(id, timelineId, 'running', `oss://${this.config.ossOutputPrefix}/${id}`, '')
    this.stages.reset()
    const work = join(this.config.dataDir, 'tmp', `${id}`)
    await mkdir(work, { recursive: true })
    const cleanup: Array<() => Promise<void>> = []
    const notes: string[] = []
    try {
      // 关键帧判断看的是全片最差的那一段：只要有一段需要重编码，整条成片就统一重编码，
      // 否则拼接处会撞上参数不一致。
      const cuts: Array<{ path: string, gap: number, audioEndSeconds: number }> = []
      let worstGap = 0
      const parts: string[] = []
      const profiles: Array<{ width: number, height: number, fps: string }> = []
      for (const [index, clip] of clips.entries()) {
        const asset = await this.assetById(clip.asset_id)
        const source = await this.materialize(asset.path, signal)
        cleanup.push(source.cleanup)
        const gap = await this.stages.timed(`检查第 ${index + 1} 段关键帧`, () => this.keyframeGap(source.path, clip.start_us / 1e6, signal))
        worstGap = Math.max(worstGap, gap)
        // 音频流的结束位置按素材探一次即可，不必每段都问。
        // 它决定切到某一段时要不要补静音（见下面切段的注释）。
        const audioEndSeconds = await this.audioEndSeconds(source.path, signal)
        cuts.push({ path: source.path, gap, audioEndSeconds })
        parts.push(source.path)
        // 顺便记下每段的画面规格。concat demuxer 配 -c copy 要求所有段完全一致：
        // 宽高或帧率不同的段被直接拼接时，ffmpeg 不会报错，而是产出一个时长与声明
        // 不符、播放器行为也说不清的文件（实测 4×4s 的成片报 16s、实际 19.14s）。
        const measured = await this.probe(source.path, signal)
        profiles.push({ width: Number(measured.width) || 0, height: Number(measured.height) || 0, fps: String(measured.fps ?? '0/1') })
      }
      const tolerance = (this.config.keyframeToleranceMs ?? 500) / 1000
      // Loudness matching reads the acoustic evidence, so it is only possible when that
      // evidence exists. Asking for it without the evidence is better refused than
      // silently skipped: the caller would otherwise ship a film with jumps in level.
      const matchLoudness = this.config.loudnessMatch ?? true
      const acousticPayload = matchLoudness
        ? (db.prepare('SELECT payload FROM evidence WHERE asset_id IN (SELECT DISTINCT asset_id FROM timeline_segments WHERE timeline_id=?) AND kind=?').get(timelineId, EVIDENCE_ACOUSTIC) as { payload: string } | undefined)
        : undefined
      if (matchLoudness && acousticPayload === undefined) notes.push('没有响度证据，本次未做响度归一。想让拼接处的音量一致，先对素材调用 video_evidence_acoustic。')
      const levels = acousticPayload === undefined ? [] : ((JSON.parse(acousticPayload.payload) as { levelsDbfs?: number[] }).levelsDbfs ?? [])
      const windowUs = acousticPayload === undefined ? 1_000_000 : ((JSON.parse(acousticPayload.payload) as { windowUs?: number }).windowUs ?? 1_000_000)
      const targetDbfs = this.config.loudnessTargetDbfs ?? -16
      /** Average level of one clip, or `undefined` when the evidence does not cover it. */
      const clipLevel = (startUs: number, endUs: number): number | undefined => {
        if (levels.length === 0) return undefined
        const first = Math.max(0, Math.floor(startUs / windowUs))
        const last = Math.min(levels.length - 1, Math.ceil(endUs / windowUs) - 1)
        const window: number[] = []
        for (let i = first; i <= last; i++) { const value = levels[i]; if (value !== undefined) window.push(value) }
        if (window.length === 0) return undefined
        return window.reduce((sum, value) => sum + value, 0) / window.length
      }
      const gains = clips.map(clip => {
        const level = clipLevel(clip.start_us, clip.end_us)
        if (level === undefined) return 0
        // 目标与实测之差就是要施加的增益；夹在 ±12 dB 以内，避免把几乎无声的段落
        // 放大到全是底噪。
        return Math.max(-12, Math.min(12, targetDbfs - level))
      })
      const leveled = gains.some(gain => Math.abs(gain) > 1)
      // 画幅在导出时才决定：同一份剪辑要横版给 B 站、竖版给抖音，重剪一遍没有意义。
      // 竖版不是裁掉两边 —— 那样会把人裁出画面，所以按 focus 选保留哪一侧。
      const aspect = options.aspect ?? 'keep'
      const focus = options.focus ?? 'center'
      const frameFilter = aspect === 'keep' ? null : (() => {
        const ratio = aspect === '9:16' ? 9 / 16 : aspect === '1:1' ? 1 : 16 / 9
        // 先按目标比例放大到能覆盖画面，再按焦点位置裁切：crop 的 x 表达式决定保留哪一侧。
        const x = focus === 'left' ? '0' : focus === 'right' ? 'iw-ow' : '(iw-ow)/2'
        return `scale=w='if(gt(a,${ratio.toFixed(6)}),-2,${Math.round(ratio * 1000)})':h='if(gt(a,${ratio.toFixed(6)}),${1000},-2)',crop=w='min(iw,ih*${ratio.toFixed(6)})':h='min(ih,iw/${ratio.toFixed(6)})':x='${x}':y='(ih-oh)/2'`
      })()
      const needsFrame = frameFilter !== null
      // 所有段画面规格一致时才允许 -c copy。不一致就归一到统一规格：取各段的最大宽高，
      // 每段按比例缩放后补边居中 —— 补边而不是裁切，因为裁切会切掉内容，而这一步只是
      // 为了让拼接成立，不该改变画面里有什么。（实测：540x360 25fps 与 360x640 30fps
      // 混剪时，-c copy 产出报 16 秒、实际 19.14 秒的文件。）
      const firstProfile = profiles[0]
      const mixed = firstProfile === undefined || profiles.some(profile => profile.width !== firstProfile.width || profile.height !== firstProfile.height || profile.fps !== firstProfile.fps)
      // 取偶数：libx264 的 yuv420p 要求宽高为偶数。`| 1` 会强制奇数，正好相反。
      const even = (n: number): number => Math.max(2, n % 2 === 0 ? n : n + 1)
      const targetWidth = even(Math.max(2, ...profiles.map(profile => profile.width)))
      const targetHeight = even(Math.max(2, ...profiles.map(profile => profile.height)))
      const needsNormalize = clips.length > 1 && mixed
      const accurate = worstGap > tolerance || clips.some(clip => clip.speed !== 1 || clip.muted === 1) || leveled || needsFrame || needsNormalize
      const codec = accurate
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k']
        : ['-c', 'copy']
      const pieces: string[] = []
      for (const [index, clip] of clips.entries()) {
        const piece = join(work, `part-${String(index).padStart(3, '0')}.mp4`)
        const source = cuts[index]
        if (source === undefined) throw new Error(`内部错误：第 ${index} 段缺少素材`)
        // 视频与音频滤镜必须分开送：`volume` 是音频滤镜，放进 -vf 会被 ffmpeg 直接
        // 忽略，静音于是静默失效；两者任意一个存在都要走重编码，-c copy 无法过滤。
        const videoFilters: string[] = []
        const audioFilters: string[] = []
        if (needsNormalize) {
          // 缩放取整到偶数：libx264 的 yuv420p 要求宽高为偶数。
          videoFilters.push(`scale=w=${targetWidth}:h=${targetHeight}:force_original_aspect_ratio=decrease`)
          videoFilters.push(`pad=w=${targetWidth}:h=${targetHeight}:x=(ow-iw)/2:y=(oh-ih)/2:color=black`)
          // 帧率也统一：否则 -c copy 拼出来的文件时长会与声明不符。
          videoFilters.push('fps=30')
        }
        if (clip.speed !== 1) videoFilters.push(`setpts=${(1 / clip.speed).toFixed(6)}*PTS`)
        if (frameFilter !== null) videoFilters.push(frameFilter)
        if (clip.muted === 1) audioFilters.push('volume=0')
        const gain = gains[index] ?? 0
        if (clip.muted !== 1 && Math.abs(gain) > 0.1) audioFilters.push(`volume=${gain.toFixed(2)}dB`)
        const args = ['-nostdin', '-y', '-ss', String(clip.start_us / 1e6), '-to', String(clip.end_us / 1e6), '-i', source.path]
        // 这一段的起点之后源文件已经没有音频时，补一段等长静音。
        //
        // 音频流可以比容器短得多：实测那条 43 分钟素材，容器与视频流都是 2584.1s，
        // 音频流只到 1644.989s。切到音频结束之后的片段时，AAC 编码器一帧样本都拿不到，
        // 报 `Input buffer exhausted` 然后以 69 退出（Conversion failed!）。
        // 一次真实的 33 分钟会话里渲染因此断在第 10 段（1807–1818s），前 9 段已经产出，
        // 用户看到的是「渲染到一半失败」，还被归因成剪辑方案有问题。
        //
        // 不能改用 `-an`：`concat` 拼段要求所有段的流结构一致，少一条音轨会让拼接失败
        // 或产出时长错误的文件。所以是**补静音**而不是去掉音频。
        // 受控对照（同一文件、只改这一处）：
        //   -c:a aac             → 退出码 69，Conversion failed!
        //   anullsrc + -shortest → 退出码 0，h264+aac 48kHz 立体声，时长 11.000s 精确
        const clipHasAudio = (clip.start_us / 1e6) < source.audioEndSeconds
        if (!clipHasAudio) {
          const seconds = Math.max(0.1, (clip.end_us - clip.start_us) / 1e6)
          args.push('-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=stereo')
          args.push('-map', '0:v:0', '-map', '1:a:0')
        }
        if (videoFilters.length > 0) args.push('-vf', videoFilters.join(','))
        if (audioFilters.length > 0) args.push('-af', audioFilters.join(','))
        // 补了静音就不能再 `-c copy`。
        //
        // 不需要归一化时 `codec` 是 `-c copy`，它会把两条流都原样拷进容器；
        // 而 `anullsrc` 产出的是 pcm_u8，MP4 不支持这个编码，于是
        //   Could not find tag for codec pcm_u8 in stream #1
        //   Could not write header (incorrect codec parameters ?): Invalid argument
        // 连文件头都写不出来。视频那条本来就该 copy（省一次重编码），
        // 所以只强制音频这一条走 AAC。
        args.push(...(clipHasAudio ? codec : ['-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k']))
        if (!clipHasAudio) args.push('-shortest')
        args.push(piece)
        await this.stages.timed(`切第 ${index + 1}/${clips.length} 段`, () => this.run('ffmpeg', args, signal))
        pieces.push(piece)
      }
      const output = join(work, name)
      if (pieces.length === 1) {
        const only = pieces[0]
        if (only === undefined) throw new Error('内部错误：切片结果为空')
        await rename(only, output)
      } else {
        // concat demuxer 要求清单里的路径按它自己的规则转义，单引号要写成 '\''。
        const list = join(work, 'concat.txt')
        await writeFile(list, pieces.map(piece => `file '${piece.replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8')
        await this.stages.timed(`拼接 ${pieces.length} 段`, () => this.run('ffmpeg', ['-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', output], signal))
      }
      // 字幕烧录放在拼接之后，而不是塞进每一段的滤镜里：成片坐标与素材坐标不同，
      // 而 concat 之后的文件才是成片本身，字幕文件可以直接按成片时间写。
      // 代价是这一步必然重编码 —— 拼接本来可以 -c copy，加了字幕就不行。
      const burnSource = options.burnSubtitles
      if (burnSource !== undefined) {
        const mapped = await this.subtitleCues(timelineId, burnSource)
        if (mapped.cues.length === 0) {
          notes.push(`要求烧录字幕，但这条时间线覆盖的片段里没有${burnSource === 'screen-text' ? '屏幕文字' : '语音转写'}证据，成片不含字幕。先调用 video_evidence_${burnSource === 'screen-text' ? 'ocr' : 'transcript'}。`)
        } else {
          const srt = join(work, 'burn.srt')
          await writeFile(srt, renderSrt(mapped.cues), 'utf8')
          const burned = join(work, `burned-${name}`)
          // subtitles 滤镜把文件名当滤镜参数解析，路径里的冒号、反斜杠、单引号都要转义，
          // 否则 Windows 路径会被当成选项分隔符。
          const escaped = srt.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
          await this.stages.timed('烧录字幕', () => this.run('ffmpeg', [
            '-nostdin', '-y', '-i', output,
            '-vf', `subtitles='${escaped}':force_style='FontName=${this.config.subtitleFont ?? 'Microsoft YaHei'},FontSize=${this.config.subtitleFontSize ?? 22},Outline=2,Shadow=0,MarginV=${this.config.subtitleMarginV ?? 28}'`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'copy', burned,
          ], signal))
          await rename(burned, output)
          notes.push(`已把 ${mapped.cues.length} 条字幕烧录进画面（${burnSource === 'screen-text' ? '屏幕文字' : '语音转写'}）。成片因此重编码了一次。`)
        }
      }
      // 导出后必须确认成片里真的有画面。某些源文件（索引损坏的 AV1）能让 ffmpeg
      // 无声地丢弃视频流，只留下音轨：文件时长正确、报告成功，但成片是没有画面的。
      // 这里把它变成明确失败，否则用户拿到的是一个看起来正常却放不出图像的文件。
      const probe = await this.stages.timed('校验成片含画面', () => this.probe(output, signal))
      if (probe.width === 0 || probe.height === 0) {
        throw new Error(`导出产物里没有视频流（时长 ${(Number(probe.duration_us) / 1e6).toFixed(2)} 秒，只有音轨）。这通常说明源素材在该区间无法解码 —— 常见于索引损坏的文件。请检查素材，或换一个时间段。`)
      }
      const key = `${this.config.ossOutputPrefix.replace(/\/$/,'')}/${timeline.project_id}/${id}-${name}`
      const oss_url = await this.stages.timed('上传成片', () => this.uploadFile(output, key, 'video/mp4'))
      const totalUs = clips.reduce((sum, clip) => sum + (clip.end_us - clip.start_us) / (clip.speed || 1), 0)
      const loudnessNote = matchLoudness && acousticPayload !== undefined
        ? `已按响度归一：各段朝 ${targetDbfs} dBFS 对齐（增益 ${gains.map(g => g.toFixed(1)).join('/')} dB）`
        : (matchLoudness ? '无响度证据，未做响度归一' : '响度归一已关闭')
      const note = accurate
        ? `共 ${clips.length} 段；最差关键帧间隔约 ${worstGap.toFixed(2)} 秒，超过 ${tolerance} 秒容差，已重新编码以保证每段起点精确`
        : `共 ${clips.length} 段；关键帧间隔约 ${worstGap.toFixed(2)} 秒在容差内，保留原始编码`
      notes.push(loudnessNote)
      if (needsFrame) notes.push(`已按 ${aspect} 重构图（保留${focus === 'left' ? '左' : focus === 'right' ? '右' : '中'}侧），不是直接裁切`)
      else notes.push('画幅保持原样')
      db.prepare('UPDATE jobs SET status=?,output=?,detail=? WHERE id=?').run('completed', `oss://${key}`, `${note}｜${loudnessNote}`, id)
      await this.manifest(timeline.project_id)
      return { id, status: 'completed', output: `oss://${key}`, oss_key: key, oss_url, segment_count: clips.length, duration_us: Math.round(totalUs), duration_seconds: round2(totalUs / 1e6), reencoded: accurate, keyframe_gap_seconds: Number(worstGap.toFixed(3)), aspect, focus, loudness_matched: matchLoudness && acousticPayload !== undefined, loudness_target_dbfs: targetDbfs, segment_gains_db: gains.map(gain => round2(gain)), note, notes, stages: this.stages.snapshot() }
    } catch (error) {
      db.prepare('UPDATE jobs SET status=?,detail=? WHERE id=?').run('failed', String(error), id)
      await this.manifest(timeline.project_id).catch(() => undefined)
      throw error
    } finally { await rm(work, { recursive: true, force: true }); await Promise.all(cleanup.map(fn => fn())) }
  }

  /**
   * Check a finished export against the submission limits and against the edit's own length.
   *
   * Two separate questions. The limits are the competition's hard rule, and a film over
   * them cannot be submitted at all. The length comparison answers a subtler one: cutting
   * is frame-aligned, so each clip can land up to one frame from the requested boundary
   * and a timeline of many clips accumulates that difference — 86 clips can come out a
   * few seconds longer than the numbers in the edit plan. Reporting the gap makes a film
   * that is longer than planned visible rather than surprising.
   *
   * Duration comes from the stored file over a signed URL, so the export is not downloaded
   * to measure it.
   */
  async validateRender(jobId: string | undefined, signal: AbortSignal): Promise<Data> {
    const db = await this.open()
    const job = (jobId === undefined
      ? db.prepare("SELECT * FROM jobs WHERE status='completed' AND output IS NOT NULL ORDER BY rowid DESC LIMIT 1").get()
      : db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId)) as { id: string, timeline_id: string, status: string, output: string | null, detail: string | null } | undefined
    if (job === undefined) throw new Error(jobId === undefined ? '还没有任何已完成的导出可以校验。' : `找不到任务 ${jobId}`)
    if (job.output === null || job.output === '') throw new Error(`任务 ${job.id} 没有 OSS 产物可校验（状态 ${job.status}）。${job.detail ?? ''}`)
    const key = job.output.startsWith('oss://') ? job.output.slice('oss://'.length) : job.output
    const url = this.signedUrl(key)
    const headUrl = this.signedUrl(key, 'HEAD')
    const maxSeconds = this.config.maxOutputSeconds ?? 300
    const maxBytes = this.config.maxOutputBytes ?? 150 * 1024 * 1024
    const problems: string[] = []
    const notes: string[] = []
    // 复用已经建好的时间线：它给出的期望时长就是"编辑计划说要多久"。
    const segments = this.segmentsOf(job.timeline_id)
    const expectedUs = segments.reduce((sum, s) => sum + (Number(s.end_us) - Number(s.start_us)) / (Number(s.speed) || 1), 0)
    let actualUs: number | undefined
    let bytes: number | undefined
    let streamWidth: number | undefined
    let streamHeight: number | undefined
    // 先看本地是否已经有这个产物：部署可能开着本地导出目录，那样读文件比走网络快得多，
    // 也让校验在没有出网的环境里可用。没有才回退到签名 URL。
    try {
      await this.stages.timed('探测成片', async () => {
        const local = await this.localOutputPath(key)
        const probed = local === undefined ? await this.probe(url, signal) : await this.probe(local, signal)
        actualUs = typeof probed.duration_us === 'number' ? probed.duration_us : undefined
        streamWidth = typeof probed.width === 'number' ? probed.width : undefined
        streamHeight = typeof probed.height === 'number' ? probed.height : undefined
      })
    } catch (error) { notes.push(`无法读取成片时长：${error instanceof Error ? error.message : String(error)}`) }
    try {
      const head = await this.stages.timed('读取成片体积', () => this.fetchSigned(headUrl, { method: 'HEAD', signal }))
      if (head.ok) { const length = head.headers.get('content-length'); if (length !== null) bytes = Number(length) }
    } catch (error) { notes.push(`无法读取成片体积：${error instanceof Error ? error.message : String(error)}`) }
    if (actualUs !== undefined && actualUs / 1e6 > maxSeconds) problems.push(`成片 ${round2(actualUs / 1e6)} 秒，超过 ${maxSeconds} 秒上限`)
    if (bytes !== undefined && bytes > maxBytes) problems.push(`成片 ${round2(bytes / 1024 / 1024)} MB，超过 ${round2(maxBytes / 1024 / 1024)} MB 上限`)
    // 没有视频流是最严重的一类问题：文件时长和体积都可能正常，唯独放不出画面。
    if (streamWidth === 0 || streamHeight === 0) {
      const lengthNote = actualUs === undefined ? '时长未知' : `时长 ${round2(actualUs / 1e6)} 秒`
      problems.push(`成片里没有视频流（${lengthNote}，只有音轨）。这类文件看起来正常却放不出画面，通常说明源素材在该区间无法解码 —— 常见于索引损坏的文件。`)
    }
    let driftUs: number | undefined
    if (actualUs !== undefined) {
      driftUs = Math.round(actualUs - expectedUs)
      // 一帧的误差是切割对齐的正常结果；只有超过一帧乘以段数才值得提醒。
      const framesWorth = (this.config.driftWarnFramesPerSegment ?? 1) * segments.length * (33_000)
      if (Math.abs(driftUs) > framesWorth) notes.push(`成片比编辑计划长 ${round2(driftUs / 1e6)} 秒（${segments.length} 段，每段切点最多差一帧，累积所致）。若要严格控制时长，可以裁掉末尾这一段。`)
    }
    return {
      job_id: job.id,
      timeline_id: job.timeline_id,
      output: job.output,
      segment_count: segments.length,
      expected_seconds: round2(expectedUs / 1e6),
      actual_seconds: actualUs === undefined ? null : round2(actualUs / 1e6),
      drift_seconds: driftUs === undefined ? null : round2(driftUs / 1e6),
      bytes,
      megabytes: bytes === undefined ? null : round2(bytes / 1024 / 1024),
      has_video_stream: streamWidth === undefined ? null : (streamWidth > 0 && (streamHeight ?? 0) > 0),
      width: streamWidth ?? null,
      height: streamHeight ?? null,
      limits: { max_seconds: maxSeconds, max_megabytes: round2(maxBytes / 1024 / 1024) },
      within_limits: problems.length === 0,
      problems,
      notes,
      stages: this.stages.snapshot(),
    }
  }

  async jobs(projectId?: string): Promise<Data[]> { const db = await this.open(); if (projectId === undefined) return db.prepare('SELECT * FROM jobs ORDER BY rowid DESC').all() as Data[]; return db.prepare('SELECT j.* FROM jobs j JOIN timelines t ON t.id=j.timeline_id WHERE t.project_id=? ORDER BY j.rowid DESC').all(projectId) as Data[] }
  /** Everything a query may legitimately match: what the segment shows, sounds like and is tagged. */
  private segmentText(segment: Data): string { const parts: string[] = []; for (const field of ['visual','audio','summary','highlight_reason','reason']) { const value = segment[field]; if (typeof value === 'string') parts.push(value) } const tags = segment.tags; if (Array.isArray(tags)) for (const tag of tags) if (typeof tag === 'string') parts.push(tag); return parts.join(' ').toLowerCase() }
  /**
   * Contract check for the three extraction tools, whose whole output is a list.
   *
   * An empty list is a legitimate answer — the video may really have no speech, no
   * on-screen text, or nothing describable — but it is also the most likely shape of a
   * failure. A model that works the task through in its reasoning channel and runs out of
   * budget there leaves a perfectly valid `[]` behind, and every later step then treats
   * "no evidence" as an established fact.
   *
   * The two cases are distinguishable by cost. A model that genuinely finds nothing has
   * nothing to work through and answers immediately: the call that motivated this guard
   * spent 16384 reasoning tokens to return an empty list, while every productive call in
   * the same session stayed under 3600. An empty list that cost more than
   * {@link EMPTY_ANSWER_REASONING_FLOOR} to produce is therefore reported as unfinished
   * work, so `ask` retries with that explanation instead of storing it.
   *
   * @param field - the array field the task must fill.
   * @param benign - what an empty result would mean if it were real, used in the complaint.
   * @param model - which model answers, when seeing a scene is a different job from the default.
   * @returns the validation hooks `ask` accepts.
   */
  private emptyExtractionGuard(field: string, benign: string, model?: string): {
    validate: (answer: Data) => string | null
    reasoningTokens: () => number
    thinking: 'off'
    model?: string
  } {
    const spentNow = (): number => this.usage[0]?.reasoning_tokens ?? 0
    return {
      // 提取类任务不需要推理通道，这里一并关掉；守卫则作为「万一还是没做完」的兜底。
      thinking: 'off',
      ...(model === undefined ? {} : { model }),
      validate: (answer) => {
        const value = answer[field]
        if (!Array.isArray(value)) return `返回的 JSON 里没有 ${field} 数组`
        if (value.length > 0) return null
        const spent = spentNow()
        if (spent < EMPTY_ANSWER_REASONING_FLOOR) return null
        return `${field} 是空数组，但这次推理用了 ${spent} tokens（阈值 ${EMPTY_ANSWER_REASONING_FLOOR}）—— `
          + `内容在推理过程里整理过却没写进 JSON，而不是「${benign}」。请直接逐条写进 ${field}，不要在推理里先整理全片。`
      },
      reasoningTokens: spentNow,
    }
  }

  /**
   * Cover media of any length by running an extraction over successive windows and merging the answers.
   *
   * A single extraction call has to return its whole answer inside one reply, and that
   * reply shares `maxOutputTokens` with the reasoning channel. Measured against the
   * deployment endpoint on a 43-minute narrated documentary, one call covered eight to
   * fifteen minutes and failed at forty-three — not because the media was long but
   * because the answer was: the reply stopped mid-JSON around 21335 characters and no
   * result survived. The ceiling is on the size of the answer, so the fix is to bound the
   * answer, which is what windowing does.
   *
   * Each window is trimmed, uploaded and extracted on its own, and the timestamps it
   * returns are shifted by the window's offset so the merged list is expressed in the
   * original asset's time. A window that fails does not discard the windows already
   * collected: the caller gets the coverage that succeeded plus a note naming the gaps,
   * because partial evidence a creator can use beats an exception that costs the whole run.
   *
   * @param options - the source to read, the prompt to ask, and where to accumulate.
   * @returns The merged list, in asset time, and the windows that produced no answer.
   */
  private async extractInWindows(options: {
    /** Local path of the full-resolution source, used as the trim input. */
    path: string
    /** Total length of the asset in microseconds. */
    durationUs: number
    /** `lines`, `entries` or `scenes` — the array field the prompt must fill. */
    field: string
    /** The task, asked once per window. */
    prompt: string
    /** What an empty result would mean if it were real, used by the retry complaint. */
    benign: string
    /** Label for the per-window stage timing. */
    stage: string
    /** Upload key prefix, so windows of different kinds do not collide. */
    keyPrefix: string
    /** Which model answers, when this extraction needs a different one from the default. */
    model?: string
    signal: AbortSignal
  }): Promise<{ items: Data[], failedWindows: number[] }> {
    // 非有限值退化成「不切窗」，而不是让 NaN 传染下去。
    //
    // 写错成 Math.max(1, undefined) 会得到 NaN，于是 `durationUs <= chunkUs` 为假
    // （NaN 的任何比较都是假）、循环的边界也是 NaN —— 结果是既不走单窗路径也进不了
    // 窗口循环，一次提取都不会发生，而症状只是「结果为空」。这个坑真的踩过一次：
    // 探针里手写的配置少写一个字段，三个断言一起变红却看不出原因。
    // 配置缺失应该在加载时报错，但在那之前，退化成整条处理远好过静默什么都不做。
    const configured = Number(this.config.extractionChunkSeconds)
    const chunkUs = Number.isFinite(configured) && configured > 0 ? configured * 1_000_000 : options.durationUs
    // 装得进一次回答就不要切窗。
    //
    // 切窗不是免费的：每个窗口都要重新生成代理并上传。素材本来就在一窗之内时，
    // 这些开销换不到任何东西，而且实测短素材本来也不会触发长度上限
    // （3 分钟返回空、8 分钟 88 句、15 分钟 161 句、43 分钟失败）。所以只有超过
    // 一窗的素材才分块，其余保持「整条代理 + 一次调用」的原路径不变。
    if (options.durationUs <= chunkUs) {
      const answer = await this.stages.timed(options.stage, async () => {
        const proxy = await this.prepare(options.path, options.signal)
        const key = `${this.config.ossPrefix.replace(/\/$/, '')}/${options.keyPrefix}-${randomUUID()}.mp4`
        const url = await this.uploadFile(proxy, key, 'video/mp4')
        return this.ask(url, options.prompt, options.signal, this.emptyExtractionGuard(options.field, options.benign, options.model))
      })
      const kept = (Array.isArray(answer[options.field]) ? answer[options.field] as Data[] : [])
        .filter(item => Number.isFinite(Number(item.start_us)) && Number.isFinite(Number(item.end_us)))
      return { items: kept, failedWindows: [] }
    }
    const windows = Math.max(1, Math.ceil(options.durationUs / chunkUs))
    // 最后一窗可能只剩几秒（43 分钟按 15 分钟切，末窗不足 1 分钟）。
    // 太短的一窗模型会倾向于什么都不说 —— 实测 3 分钟的素材返回 0 句 ——
    // 所以把过短的末窗并进前一窗，宁可让那一窗略超上限，也不要丢内容。
    const starts: number[] = []
    for (let index = 0; index < windows; index++) starts.push(index * chunkUs)
    if (starts.length > 1) {
      const last = starts[starts.length - 1] as number
      const lastSeconds = (options.durationUs - last) / 1e6
      if (lastSeconds < MIN_WINDOW_SECONDS) starts.pop()
    }
    const items: Data[] = []
    const failedWindows: number[] = []
    const total = starts.length
    for (let index = 0; index < total; index++) {
      const fromUs = starts[index] as number
      const toUs = index + 1 < total ? (starts[index + 1] as number) : options.durationUs
      const from = fromUs / 1e6
      const seconds = Math.max(1, (toUs - fromUs) / 1e6)
      const label = total === 1 ? options.stage : `${options.stage} ${index + 1}/${total}`
      try {
        const answer = await this.stages.timed(label, async () => {
          const trimmed = await this.prepare(options.path, options.signal, { startSeconds: from, endSeconds: from + seconds, fps: WINDOW_PROXY_FPS })
          const key = `${this.config.ossPrefix.replace(/\/$/, '')}/${options.keyPrefix}-${randomUUID()}.mp4`
          const url = await this.uploadFile(trimmed, key, 'video/mp4')
          return this.ask(url, options.prompt, options.signal, this.emptyExtractionGuard(options.field, options.benign, options.model))
        })
        // 模型给的时间是相对它看到的那段素材开头，也就是窗口起点 fromUs，
        // 必须平移回素材时间轴：不偏移的话第二窗会比第一窗还早，
        // 选中它就会剪到完全错误的片段。
        const produced = (Array.isArray(answer[options.field]) ? answer[options.field] as Data[] : [])
          .filter(item => Number.isFinite(Number(item.start_us)) && Number.isFinite(Number(item.end_us)))
        // 一条都没产出时按缺口记，不要当成「这个窗口本来就没内容」。
        //
        // 实测踩过：一个覆盖 25–30 分钟的窗口返回 0 条，被静默跳过，最终转写只有
        // 前 15 分钟而 failed_windows 是 null —— 界面和调用方都以为整条素材都转好了。
        // 空结果在这类任务里本来就是可疑的（守卫就是为此存在），窗口级同样如此。
        if (produced.length === 0) {
          failedWindows.push(index)
          console.warn(`video-workspace: ${label} 没有产出任何条目，按缺口记录（区间 ${from.toFixed(0)}–${(from + seconds).toFixed(0)}s）`)
        }
        for (const item of produced) {
          const start = Number(item.start_us)
          const end = Number(item.end_us)
          items.push({ ...item, start_us: Math.round(start + fromUs), end_us: Math.round(end + fromUs) })
        }
      } catch (error) {
        failedWindows.push(index)
        console.warn(`video-workspace: ${label} 失败，保留其余窗口的结果（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
    return { items, failedWindows }
  }

  /**
   * Pull the audio out of a source file into a small standalone track.
   *
   * Speech recognition reads only the audio, so sending the picture as well would upload
   * tens of megabytes that no step looks at. Measured on the 43-minute asset: the source is
   * 70 MB while its audio alone is under 15 MB, and the upload is on the critical path
   * between the two calls that bracket it.
   *
   * Mono at 16 kHz because that is what recognition resamples to anyway; keeping the source
   * rate would triple the upload for no gain in accuracy.
   *
   * @param path - local source media.
   * @param signal - cancellation for the transcode.
   * @returns Path to the extracted audio, valid until the caller's temp directory is cleared.
   */
  private async extractAudio(path: string, signal: AbortSignal): Promise<string> {
    await mkdir(join(this.config.dataDir, 'tmp'), { recursive: true })
    const key = await this.hashFile(path)
    const file = join(this.config.dataDir, 'tmp', `audio-${key}.m4a`)
    if (existsSync(file)) { this.stages.skipped('提取音轨 · 复用缓存', '同一素材的音轨已存在'); return file }
    const partial = `${file}.part`
    await this.run('ffmpeg', ['-nostdin', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'aac', '-b:a', '48k', '-f', 'mp4', partial], signal)
    await rename(partial, file)
    return file
  }

  /**
   * Transcribe an audio URL through the asynchronous speech-recognition task API.
   *
   * The task API is a three-step flow — submit, poll, download — rather than one request,
   * because recognition of a long recording outlives an HTTP response. The result arrives
   * as a separate JSON document at a URL that expires, so it is read here rather than
   * handed to the caller.
   *
   * Sentence times are already absolute positions in the audio and are used as they come:
   * they are measured boundaries, not the proportional estimates a language model produces
   * when asked to place its own words on a timeline.
   *
   * @param url - publicly reachable URL of the audio to transcribe.
   * @param signal - cancellation for the submission and every poll.
   * @returns Sentences with their times in microseconds, ready for range sanitizing.
   */
  private async recognizeSpeech(url: string, signal: AbortSignal): Promise<Data[]> {
    const key = process.env[this.config.asrApiKeyEnv ?? this.config.apiKeyEnv]
    if (!key) throw new Error(`speech recognition API key is missing: ${this.config.asrApiKeyEnv ?? this.config.apiKeyEnv}`)
    const base = this.config.asrBaseUrl.replace(/\/$/, '')
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

    const submit = await this.fetchSigned(`${base}/services/audio/asr/transcription`, {
      method: 'POST',
      headers: { ...headers, 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({
        model: this.config.asrModel,
        input: { file_urls: [url] },
        parameters: { channel_id: [0] },
      }),
      signal,
    })
    if (!submit.ok) throw new Error(`语音识别任务提交失败：HTTP ${submit.status} ${(await submit.text()).slice(0, 300)}`)
    const submitted = await submit.json() as { output?: { task_id?: string } }
    const taskId = submitted.output?.task_id
    if (taskId === undefined) throw new Error(`语音识别任务没有返回 task_id：${JSON.stringify(submitted).slice(0, 300)}`)

    const deadline = Date.now() + this.config.asrTimeoutMs
    let task = ''
    for (;;) {
      if (Date.now() > deadline) throw new Error(`语音识别任务超时（${Math.round(this.config.asrTimeoutMs / 1000)}s，最后状态 ${task}）`)
      await this.pause(this.config.asrPollMs, signal)
      const poll = await this.fetchSigned(`${base}/tasks/${taskId}`, { headers, signal })
      if (!poll.ok) throw new Error(`查询语音识别任务失败：HTTP ${poll.status} ${(await poll.text()).slice(0, 300)}`)
      const payload = await poll.json() as {
        output?: {
          task_status?: string
          code?: string
          message?: string
          result?: { subtask_status?: string, transcription_url?: string, message?: string }
          results?: Array<{ subtask_status?: string, transcription_url?: string, message?: string }>
        }
      }
      const output = payload.output ?? {}
      task = output.task_status ?? ''
      if (task === 'FAILED' || task === 'UNKNOWN') {
        throw new Error(`语音识别任务 ${task}：${output.code ?? ''} ${output.message ?? ''}`.trim())
      }
      if (task !== 'SUCCEEDED') continue
      // 两种结果结构并存：数组式（results[]）与单对象式（result）。官方文档明确要求
      // 不能写死其中一种，因为不同模型走的是不同分支。
      const entry = output.result ?? (output.results ?? [])[0]
      if (entry === undefined) throw new Error('语音识别任务成功但结果为空')
      if (entry.subtask_status !== 'SUCCEEDED' || entry.transcription_url === undefined) {
        throw new Error(`语音识别子任务未成功：${entry.subtask_status ?? '?'} ${entry.message ?? ''}`.trim())
      }
      const document = await this.fetchSigned(entry.transcription_url, { signal })
      if (!document.ok) throw new Error(`下载识别结果失败：HTTP ${document.status}`)
      const parsed = await document.json() as { transcripts?: Array<{ sentences?: Array<{ begin_time?: number, end_time?: number, text?: string }> }> }
      const sentences = (parsed.transcripts ?? []).flatMap(transcript => transcript.sentences ?? [])
      // 识别给的是毫秒；本插件内部一律用微秒。
      return sentences
        .filter(sentence => Number.isFinite(sentence.begin_time) && Number.isFinite(sentence.end_time))
        .map(sentence => ({
          start_us: Math.round(Number(sentence.begin_time) * 1000),
          end_us: Math.round(Number(sentence.end_time) * 1000),
          text: String(sentence.text ?? ''),
        }))
    }
  }

  /**
   * Split one matched span's text into sentences with estimated times.
   *
   * A search hit on the analysis carries the segment's whole description, which covers tens
   * of seconds and several sentences, while the question is usually about one of them. Where
   * a transcript exists the sentence times come from recognition and are exact, so this is
   * not needed; where it does not - the measured asset has no audio past 1640s of a 2584s
   * picture - the analysis is the only text there is, and a caller asking for the timing of a
   * sentence has nothing else to go on.
   *
   * The times are interpolated by character count across the span, so they say which sentence
   * and roughly where, not where the speaker actually paused. Reported as such: the caller
   * decides whether an estimate is good enough, and can refine the result against real edges.
   *
   * @param text - the span's text, as stored.
   * @param startUs - span start.
   * @param endUs - span end.
   * @returns One entry per sentence, or null when the text will not split.
   */
  private splitSpanIntoSentences(text: unknown, startUs: number, endUs: number): Data[] | null {
    const body = String(text ?? '')
    if (body === '') return null
    const parts = body.split(/(?<=[。！？；])/).map(part => part.trim()).filter(part => part !== '')
    if (parts.length < 2) return null
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    if (total === 0) return null
    const span = endUs - startUs
    const out: Data[] = []
    let consumed = 0
    for (const part of parts) {
      const from = startUs + Math.round(span * (consumed / total))
      consumed += part.length
      const to = startUs + Math.round(span * (consumed / total))
      out.push({ start_us: from, end_us: to, seconds: round2((to - from) / 1e6), text: part })
    }
    return out
  }

  /**
   * Narrow an analysis segment to the sentence that contains the query, with an interpolated span.
   *
   * An analysis segment is whatever the understanding pass chose to group — in practice
   * 35 to 160 seconds. A creator's question is usually about one sentence inside it, so
   * answering with the whole segment hands back a window too coarse to cut on. That is
   * not a cosmetic problem: the observed consequence was the caller escalating to
   * re-analysing the entire video (40 s and a full upload each time, 21 times in one
   * session) to recover precision that the stored narration already implied.
   *
   * The span is interpolated by character count across the segment, so it is an estimate:
   * it identifies which sentence and roughly where, not a speech boundary. Callers that
   * need frame accuracy pass the result through the existing boundary refinement, which
   * snaps to the real physical edges.
   *
   * Declines rather than guesses: a query that does not appear in this segment, or a
   * segment with no sentence punctuation, returns null and the caller keeps the whole span.
   *
   * @param segment - one stored analysis segment.
   * @param needle - the already-lowercased query text.
   * @param startUs - the segment's start, used as the interpolation origin.
   * @param endUs - the segment's end.
   * @returns the containing sentence's span, or null when it cannot be located.
   */
  private narrowToSentence(segment: Data, needle: string, startUs: number, endUs: number): { start_us: number, end_us: number } | null {
    const text = String(segment.audio ?? segment.visual ?? '')
    if (text === '') return null
    const strip = (value: string): string => value.replace(/[\s，。、；：！？""''（）《》「」…—\-.,;:!?"'()<>]/g, '').toLowerCase()
    const wanted = strip(needle)
    if (wanted === '') return null
    const sentences = text.split(/(?<=[。！？；])/).map(part => part.trim()).filter(part => part !== '')
    if (sentences.length < 2) return null
    const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0)
    if (total === 0) return null
    const span = endUs - startUs
    let consumed = 0
    for (const sentence of sentences) {
      const from = startUs + Math.round(span * (consumed / total))
      consumed += sentence.length
      const to = startUs + Math.round(span * (consumed / total))
      if (strip(sentence).includes(wanted)) return { start_us: from, end_us: to }
    }
    return null
  }

  /** The stored duration of an asset, or undefined when the metadata lacks it. */
  private async durationOf(assetId: string): Promise<number | undefined> { const row = (await this.open()).prepare('SELECT meta FROM assets WHERE id=?').get(assetId) as { meta: string } | undefined; if (!row) return undefined; const meta = JSON.parse(row.meta) as { duration_us?: number }; return typeof meta.duration_us === 'number' && meta.duration_us > 0 ? meta.duration_us : undefined }
  /**
   * Keep only the ranges a timeline can actually use, clamped to the asset.
   *
   * A model can answer with an end past the media, an inverted pair, or a missing
   * bound. Storing those would move the failure to `video_timeline_create`, far from
   * the answer that caused it, so they are filtered and clamped here instead.
   *
   * The unit is checked before clamping. A reply whose bounds are two or three orders
   * of magnitude short of the asset is reporting seconds under microsecond field
   * names — clamping alone would hide that, turning a 282-second span into the whole
   * asset and storing a wrong range that still looks plausible.
   */
  private sanitizeRanges(value: unknown, duration: number | undefined): Data[] {
    if (!Array.isArray(value)) return []
    const unit = typeof duration === 'number' && duration > 10_000_000 && this.looksLikeSeconds(value, duration) ? 1_000_000 : 1
    const kept: Data[] = []
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const range = item as Data
      const start = Number(range.start_us) * unit
      let end = Number(range.end_us) * unit
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end) continue
      // A span this short is not a segment anyone can cut: it is a bound that escaped
      // the unit rescale, and keeping it would offer a timeline that renders nothing.
      if (end - start < 100_000) continue
      if (typeof duration === 'number') { if (start >= duration) continue; end = Math.min(end, duration) }
      if (end - start < 100_000) continue
      kept.push({ ...range, start_us: Math.round(start), end_us: Math.round(end) })
    }
    return kept
  }

  /**
   * Whether every bound in a reply is far too small to be a microsecond value.
   *
   * Requires a unanimous verdict so one odd segment cannot rescale a reply whose
   * other bounds are plainly microseconds.
   */
  private looksLikeSeconds(value: unknown[], duration: number): boolean { const bounds: number[] = []; for (const item of value) { if (typeof item !== 'object' || item === null) continue; const range = item as Data; for (const field of ['start_us','end_us']) { const bound = Number(range[field]); if (Number.isFinite(bound)) bounds.push(bound) } } if (bounds.length === 0) return false; return Math.max(...bounds) * 1_000_000 <= duration * 1.5 }
  /**
   * Blank a field the model left empty, keeping the key present.
   *
   * An empty `highlight_reason` used to survive as `""`, which reads like a reason
   * was offered and lost. `null` states plainly that the analysis did not judge this
   * segment, so the field's absence is information rather than noise.
   */
  private blankToNull(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value : null }
  /**
   * Apply {@link blankToNull} to every segment of a stored analysis.
   *
   * Analyses written before blank fields were normalised still carry `""`, and a
   * restored or migrated row is never re-analysed, so the normalisation has to run on
   * the way in as well. Without it the same analysis reads differently depending on
   * whether it came from this process or from OSS.
   */
  private normalizeStoredAnalysis(data: string): string { try { const parsed = JSON.parse(data) as { segments?: unknown }; if (!Array.isArray(parsed.segments)) return data; parsed.segments = (parsed.segments as Data[]).map(segment => typeof segment === 'object' && segment !== null ? { ...segment, highlight_reason: this.blankToNull(segment.highlight_reason) } : segment); return JSON.stringify(parsed) } catch { return data } }
  /**
   * A filename safe to place under the cache directory.
   *
   * `video_render_submit` takes a model-supplied name, and a name carrying path
   * separators would otherwise choose where the render writes.
   */
  private safeFilename(name: string): string { const leaf = basename(name.trim()).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, ''); return leaf === '' ? 'output.mp4' : leaf.slice(0, 120) }
  private async asset(projectId: string, id: string): Promise<{ path: string }> { const row = (await this.open()).prepare('SELECT path FROM assets WHERE id=? AND project_id=?').get(id,projectId) as { path: string } | undefined; if (!row) throw new Error(`asset not found: ${id}`); return row }
  /**
   * A timeline names its project and its asset in separate columns, so two valid
   * foreign keys still permit a cross-project reference. This is the check that
   * keeps a timeline describing the asset its own project holds.
   */
  /**
   * A timeline range has to be non-empty and inside the asset it points at.
   *
   * Only the non-empty half is a schema constraint; the upper bound is checked here
   * because it depends on the asset's stored duration. Letting it through would
   * produce a clip that silently ends past the media.
   */
  private async assertRange(assetId: string, startUs: number, endUs: number): Promise<void> { if (!Number.isFinite(startUs) || !Number.isFinite(endUs)) throw new Error('start_us and end_us must be numbers'); if (startUs < 0) throw new Error(`start_us must not be negative: ${startUs}`); if (endUs <= startUs) throw new Error('end_us must be after start_us'); const duration = await this.durationOf(assetId); if (duration !== undefined && endUs > duration) throw new Error(`end_us ${endUs} is past the end of asset ${assetId} (${duration})`) }
  private async assertAssetInProject(projectId: string, assetId: string): Promise<void> { const row = (await this.open()).prepare('SELECT project_id FROM assets WHERE id=?').get(assetId) as { project_id: string } | undefined; if (!row) throw new Error(`asset not found: ${assetId}`); if (row.project_id !== projectId) throw new Error(`asset ${assetId} does not belong to project ${projectId}`) }
  private async assetById(id: string): Promise<{ path: string }> { const row = (await this.open()).prepare('SELECT path FROM assets WHERE id=?').get(id) as { path: string } | undefined; if (!row) throw new Error(`asset not found: ${id}`); return row }
  private async probe(path: string, signal?: AbortSignal): Promise<Data> { const { stdout } = await this.run('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,width,height,avg_frame_rate','-of','json',path], signal); const result = JSON.parse(stdout) as { format: { duration: string },streams: Array<{ codec_type: string,width?: number,height?: number,avg_frame_rate?: string }> }; const video = result.streams.find(stream => stream.codec_type === 'video'); return { duration_us: Math.round(Number(result.format.duration) * 1e6),width: video?.width ?? 0,height: video?.height ?? 0,fps: video?.avg_frame_rate ?? '0/1' } }
  /**
   * Build the 720p / 1 fps proxy that Qwen Omni reads, reusing an earlier one.
   *
   * Transcoding a long video costs minutes of CPU and the same asset gets understood
   * more than once — a second question, a retry after a model error. Keying the proxy
   * on the bytes it came from means an unchanged asset is encoded once. The encode
   * writes to a `.part` file and renames on success, so a crash or an aborted ffmpeg
   * can never leave a truncated file that later runs would reuse as if it were whole.
   *
   * The stage is recorded here rather than by the caller because only this method knows
   * whether it encoded or reused; a caller timing a cache hit would report a suspiciously
   * fast "generate" step instead of saying nothing was generated.
   */
  /**
   * The scale expression that fits a video into the proxy size.
   *
   * `-2` derives an even width from the height, and `min(height,ih)` keeps a video that is
   * already shorter than the proxy from being enlarged: scaling adds pixels, not detail,
   * and every extra pixel is paid for on every frame the model is asked to look at.
   *
   * The obvious-looking `scale=-2:720:force_original_aspect_ratio=decrease` does not work —
   * those two options fight over the width, ffmpeg hands libx264 an invalid frame size, and
   * the encode dies with `return code -22` having written nothing. It happens to succeed on
   * landscape footage, which is why it survived: **every portrait video failed**, and a
   * phone-shot vertical clip is exactly what a creator is likely to bring.
   *
   * @returns An ffmpeg scale filter, with no trailing options.
   */
  private proxyScaleFilter(): string {
    return `scale=-2:min(${this.config.proxyHeight ?? 720}\\,ih)`
  }

  /**
   * Build the low-rate proxy the model reads, reusing an earlier one.
   *
   * Transcoding costs minutes of CPU and the same asset gets understood more than once,
   * so a whole-asset proxy is keyed on the bytes it came from and kept. A trimmed proxy —
   * used when a second pass re-reads one candidate range — is keyed on the range too,
   * because two candidates want different clips of the same file.
   *
   * The encode writes to a `.part` file and renames on success, so a crash or an aborted
   * ffmpeg can never leave a truncated file that later runs would reuse as if it were whole.
   *
   * @param path - the source file to transcode.
   * @param signal - cancellation for the encode.
   * @param trim - an optional range, in seconds, to cut before encoding.
   * @returns The proxy's path.
   */
  /**
   * Read the text off the picture by sampling frames and reading each one with the OCR model.
   *
   * Replaces asking a multimodal model to watch the whole video and write the captions out.
   * Measured on the 43-minute asset, that approach took 458.8s - half the tool time of the
   * session it ran in - because every call had to watch minutes of video and compose a long
   * answer. Reading a single frame answers a much smaller question, and the measured cost is
   * 95ms per frame at concurrency 16, so the same coverage arrives in tens of seconds.
   *
   * Sampling rather than watching is what makes it safe: text on screen is static between
   * cuts, so a frame every {@link Config.ocrSampleSeconds} sees each caption, and there is no
   * answer long enough to be truncated the way a whole-video caption pass was.
   *
   * Two things the reader cannot tell us, handled here instead of guessed at: it returns no
   * position for the text, so the frame's own timestamp is the position; and it does not say
   * whether the characters were a caption or a station logo, so text present on most frames
   * is treated as furniture and dropped.
   *
   * @param path - local media to read.
   * @param durationUs - length of the asset, bounding the last sample.
   * @param signal - cancellation for the frame extraction and every read.
   * @returns Text pieces with their times, in asset order.
   */
  private async readOnScreenText(path: string, durationUs: number, signal: AbortSignal): Promise<Data[]> {
    const interval = Math.max(1, this.config.ocrSampleSeconds)
    const keys = await this.hashFile(path)
    const frameDir = join(this.config.dataDir, 'tmp', `frames-${keys}-${interval}`)
    await mkdir(frameDir, { recursive: true })
    const stamp = join(frameDir, '.stamp')

    let names = existsSync(stamp) ? (await readdir(frameDir)).filter(name => name.endsWith('.jpg')).sort() : []
    if (names.length === 0) {
      for (const stale of await readdir(frameDir)) await rm(join(frameDir, stale), { force: true })
      const pattern = join(frameDir, 'f%06d.jpg')
      // 只缩不放，并统一到偶数高度：读字不需要大图，而缩放是这一步唯一的本地开销。
      await this.run('ffmpeg', ['-nostdin', '-y', '-i', path,
        '-vf', `fps=1/${interval},scale='min(1280,iw)':-2`, '-q:v', '4', pattern], signal)
      names = (await readdir(frameDir)).filter(name => name.endsWith('.jpg')).sort()
      await writeFile(stamp, String(names.length))
    } else {
      this.stages.skipped('抽取画面帧 · 复用缓存', `同一素材的 ${names.length} 帧已存在`)
    }
    if (names.length === 0) return []

    // 逐帧读取，并发受配置约束。
    // 帧之间互不依赖，所以并发是这里唯一能压缩墙钟时间的杠杆：
    // 实测同一批 60 帧，并发 1 要 45.5s，并发 16 只要 5.7s。
    const texts: string[] = new Array<string>(names.length).fill('')
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= names.length) return
        const name = names[index] as string
        try {
          const bytes = await readFile(join(frameDir, name))
          texts[index] = await this.readFrame(`data:image/jpeg;base64,${bytes.toString('base64')}`, signal)
        } catch (error) {
          // 单帧失败不该让整条证据消失：其余帧仍然有用，缺失的部分由调用方从覆盖
          // 范围看出来。取消是例外，必须立刻停。
          if (signal.aborted) throw error
          console.warn(`video-workspace: 第 ${index + 1}/${names.length} 帧读取失败（${error instanceof Error ? error.message : String(error)}）`)
        }
      }
    }
    const workers = Math.max(1, Math.min(this.config.ocrConcurrency, names.length))
    await Promise.all(Array.from({ length: workers }, () => worker()))

    // 每帧拆成「一行一条」，再按行各自求生命周期。
    //
    // 早先是按整帧文本合并的，那是错的：帧上同时有角标和字幕时整帧文本各不相同，
    // 于是同一个角标永远凑不成连续的一段，频率也就永远到不了阈值 ——
    // 实测水印因此没被滤掉，还跟着字幕一起漏进结果。
    // 按行处理后，角标与字幕各有各的区间，频率也各自可数。
    const perFrame = texts.map(text => this.splitCaption(text))

    // 同一个角标会被读成好几种写法，靠完全相同是归不到一起的。
    //
    // 实测那条素材的角标出现过 `-小老西儿 bilibili`、`-小老西儿_bilibili`、
    // `-小老西儿`、`bilibili` 四种形态；只做空白与下划线的归一化仍算四条不同的
    // 文字，频率被摊薄到阈值以下，于是两次调阈值（0.6、0.35）都没能滤掉它。
    // 归并的判据改成「一条是另一条的子串，或两条足够相似」：
    // 角标的几种写法互为子串，而字幕之间不会。
    const tierKeys = new Map<string, number[]>()
    /** 每行归一化后的文字 -> 它所属组的 id。第二遍要用同一个映射，不能重新归并 ——
     * 重新归并会为已经归好的行再建一个空组，组 id 一变，标签就挂错了地方。 */
    const groupOf = new Map<string, string>()
    for (let index = 0; index < perFrame.length; index += 1) {
      for (const line of perFrame[index] as string[]) {
        const keys = this.normalizeCaption(line)
        if (keys === '') continue
        const group = this.groupCaption(keys, tierKeys, groupOf)
        const seen = tierKeys.get(group) ?? []
        // 同一帧里重复出现只算一次，否则频率会被重复计数推高。
        if (seen[seen.length - 1] !== index) seen.push(index)
        tierKeys.set(group, seen)
      }
    }
    const labelOf = new Map<string, string>()
    for (let index = 0; index < perFrame.length; index += 1) {
      for (const line of perFrame[index] as string[]) {
        const keys = this.normalizeCaption(line)
        if (keys === '') continue
        const group = groupOf.get(keys)
        if (group === undefined) continue
        // 记下最短的那种写法作为代表：角标里最干净的形态。
        const current = labelOf.get(group)
        if (current === undefined || line.length < current.length) labelOf.set(group, line)
      }
    }

    // 常驻文字（台标、角标、固定片头）按出现频率识别并丢掉。
    // 识别模型只给字，不给「这是字幕还是角标」，所以只能靠跨帧频率区分。
    const persistent = new Set<string>()
    for (const [group, frames] of tierKeys) {
      if (frames.length / perFrame.length >= this.config.ocrWatermarkFraction) persistent.add(group)
    }
    if (persistent.size > 0) {
      const shown = [...persistent].slice(0, 6).map(group => labelOf.get(group) ?? group)
      console.info(`video-workspace: 按常驻文字丢弃 ${persistent.size} 条（出现在 ${Math.round(this.config.ocrWatermarkFraction * 100)}% 以上的帧里）：${shown.join(' / ')}`)
    }

    // 每一条非角标文字各自合并成连续区间：文字是静止的，区间应当按「它挂了多久」来给，
    // 而不是按采样点给一串零碎片段。
    const entries: Data[] = []
    for (const [group, frames] of tierKeys) {
      if (persistent.has(group)) continue
      const label = labelOf.get(group) ?? group
      let from = frames[0] as number
      let previous = frames[0] as number
      const emit = (): void => {
        entries.push({
          start_us: Math.round(from * interval * 1e6),
          end_us: Math.min(durationUs, Math.round((previous + 1) * interval * 1e6)),
          text: label,
        })
      }
      for (const index of frames.slice(1)) {
        // 相邻之间的空档给一点容差：字幕换行或识别偶发失败会让中间少一两帧，
        // 那不该把同一句话切成两段。
        if (index <= previous + 2) { previous = index; continue }
        emit()
        from = index
        previous = index
      }
      emit()
    }
    entries.sort((a, b) => Number(a.start_us) - Number(b.start_us))
    return entries
  }

  /**
   * Fold equivalent readings of the same on-screen text into one group.
   *
   * The reader is not consistent between frames: one station mark came back as four
   * different strings, and comparing them literally split its frequency four ways, which is
   * why a threshold tuned high or low both failed to remove it. Two readings are treated as
   * the same piece when one contains the other, which is what those four spellings are to
   * each other and what captions never are.
   *
   * Returns the identifier of the group the key belongs to, creating one when nothing
   * matches. The map is keyed by group identifier and holds that group's frame indices.
   *
   * @param keys - normalized text of one line.
   * @param groups - known groups, keyed by identifier.
   * @param memo - normalized text to group identifier, so a line seen again resolves to the
   *   group it already joined rather than starting a new one.
   * @returns The identifier of the matching or newly created group.
   */
  private groupCaption(keys: string, groups: Map<string, number[]>, memo: Map<string, string>): string {
    const known = memo.get(keys)
    if (known !== undefined) return known
    for (const existing of groups.keys()) {
      // 子串归并只在两者都够长时才做。
      //
      // 中文里单字几乎必然是某条字幕的子串：实测把「西」当子串归并，于是
      // 「跟着老西儿游山西」「西方三圣」这些互不相干的字幕被并成一组，
      // 结果里出现了只有「西」「小」「东」这种一两个字的条目。
      // 角标的几种写法（`-小老西儿 bilibili` 与 `bilibili`、`-小老西儿`）
      // 都不短，所以长度下限不会妨碍它，只会挡住单字的误并。
      const shorter = existing.length <= keys.length ? existing : keys
      const longer = existing.length <= keys.length ? keys : existing
      if (shorter.length >= CAPTION_GROUP_MIN_LENGTH && longer.includes(shorter)) {
        memo.set(keys, existing)
        return existing
      }
    }
    // 新组先占位，帧号由调用方填入。
    groups.set(keys, [])
    memo.set(keys, keys)
    return keys
  }

  /**
   * Normalize a line of read text for comparison.
   *
   * Strips the differences that are noise - spacing, underscores, case - so that two
   * readings of the same mark differ only where the reader actually disagreed.
   *
   * @param line - one line as the model returned it.
   * @returns The comparable form.
   */
  private normalizeCaption(line: string): string {
    return line.replace(/[\s_\-|·.]+/g, '').toLowerCase()
  }

  /**
   * Split a reader's answer into separate pieces of on-screen text.
   *
   * The reader returns the characters it saw, one region per line, without saying how many
   * regions there were. Newlines are the only separator it offers, so each line is treated as
   * its own piece: a caption and a station logo on the same frame are two entries with
   * different lifetimes, and keeping them together would make the watermark filter throw away
   * the caption riding along with it.
   *
   * @param answer - the raw text the model returned for one frame.
   * @returns Non-empty trimmed lines.
   */
  private splitCaption(answer: string): string[] {
    return answer.split('\n').map(line => line.trim()).filter(line => line !== '')
  }

  /**
   * Read the text on one image.
   *
   * Deliberately not routed through {@link ask}: that helper takes a video URL and wraps the
   * call in the JSON contract the extraction prompts use, while this asks a different model a
   * question whose answer is plain text. Sending an image where a video is expected, or
   * demanding JSON from a model that returns prose, would fail in ways that look like the
   * reader is broken.
   *
   * @param dataUrl - the frame as a base64 data URL.
   * @param signal - cancellation for the request.
   * @returns The text the model read, or an empty string when it saw none.
   */
  private async readFrame(dataUrl: string, signal: AbortSignal): Promise<string> {
    const key = process.env[this.config.apiKeyEnv]
    if (!key) throw new Error(`model API key is missing: ${this.config.apiKeyEnv}`)
    const response = await this.fetchSigned(`${this.config.modelBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.ocrModel,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }],
      }),
      signal,
    })
    if (!response.ok) throw new Error(`OCR 帧读取失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
    const parsed = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    return String(parsed.choices?.[0]?.message?.content ?? '').trim()
  }

  /**
   * Which analyses and evidence a asset already has, in the words a caller needs.
   *
   * Computing evidence is the expensive half of this plugin - a transcript is a recognition
   * task, screen text reads hundreds of frames, scene description runs a vision model over the
   * whole picture - and until this existed the only way to find out whether any of it had been
   * done was to call the tool that computes it and watch whether the reply said `cached`. That
   * works, but it downloads the asset and probes it first, so "is this already done" cost more
   * than the question deserved, and nothing let a caller see the *gaps* without computing
   * everything first.
   *
   * Reports both halves: what is done, and where a done piece stops short of the picture. The
   * second half is the one that changes behaviour - a transcript that exists only up to 1640s
   * of a 2584s picture answers nothing past that point, and a caller that knows it will say so
   * instead of spending a minute re-watching the video looking for speech that is not there.
   *
   * @param projectId - project owning the asset.
   * @param assetId - asset to report on.
   * @returns Done kinds with their covered range, plus the analyses already on file.
   */
  async evidenceStatus(projectId: string, assetId: string): Promise<Data> {
    // 素材不存在时这里就报错，不必等后面的查询返回空结果再猜原因。
    await this.asset(projectId, assetId)
    const db = await this.open()
    const analyses = db.prepare('SELECT instruction, data, created_at FROM analyses WHERE asset_id=?').all(assetId) as Array<{ instruction: string, data: string, created_at: number }>
    const coverage = await this.evidenceCoverage(assetId)
    const kinds = (coverage.kinds ?? {}) as Record<string, { from_seconds: number, to_seconds: number, count: number, covers_picture: boolean, gap_to_picture_end_seconds: number | null }>
    const pictureSeconds = Number(coverage.picture_seconds ?? 0)

    const done: Data[] = []
    const notComputed: string[] = []
    for (const kind of ALL_EVIDENCE_KINDS) {
      const found = kinds[kind]
      if (found === undefined || found.count === 0) { notComputed.push(kind); continue }
      done.push({
        kind,
        from_seconds: found.from_seconds,
        to_seconds: found.to_seconds,
        count: found.count,
        covers_picture: found.covers_picture,
        // 缺口的措辞要明确指向「这段时间没有这类证据」，而不是留一个数字让调用方猜。
        stops_short_by_seconds: found.gap_to_picture_end_seconds,
        note: found.covers_picture
          ? null
          : `这一类只覆盖到 ${found.to_seconds}s，画面总长 ${round2(pictureSeconds)}s —— 之后的 ${found.gap_to_picture_end_seconds}s 没有这类证据。落在那个范围里的内容，任何检索都找不到它。`,
      })
    }

    return {
      asset_id: assetId,
      picture_seconds: round2(pictureSeconds),
      analyses: analyses.map(row => ({
        instruction: row.instruction,
        segments: ((JSON.parse(row.data) as { segments?: unknown[] }).segments ?? []).length,
      })),
      evidence_done: done,
      evidence_not_computed: notComputed,
      next_step: notComputed.length === 0
        ? '全部证据都已算好，可以直接检索或剪辑。'
        : `还没算的证据：${notComputed.join('、')}。需要哪一类就用对应的 video_evidence_* 工具算它；不需要就不必算。`,
    }
  }

  /**
   * What each evidence kind actually covers, in seconds.
   *
   * `evidence_available` says whether a kind was computed at all, which is not the question a
   * caller needs answered. The measured asset carries a transcript flag of true and still
   * answers nothing past 1644s, because its audio stream ends there while the picture runs to
   * 2584s. A session asked for twelve phrases from that stretch, got no sentence-level times,
   * and spent 94.5s re-watching the whole video looking for speech that was never recorded.
   *
   * Reporting the covered range instead of a flag is what lets a caller tell "no evidence yet,
   * compute it" apart from "no evidence is possible here, say so".
   *
   * @param assetId - asset to summarize.
   * @returns One line per computed kind: covered range in seconds, item count, and a note when
   *   the kind stops short of the picture.
   */
  private async evidenceCoverage(assetId: string): Promise<Data> {
    const db = await this.open()
    const rows = db.prepare('SELECT kind, duration_us, payload FROM evidence WHERE asset_id=?').all(assetId) as Array<{ kind: string, duration_us: number, payload: string }>
    const asset = db.prepare('SELECT meta FROM assets WHERE id=?').get(assetId) as { meta: string } | undefined
    const pictureSeconds = asset === undefined ? 0 : (Number((JSON.parse(asset.meta) as { duration_us?: number }).duration_us) || 0) / 1e6
    const coverage: Data = {}
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Data
      const span = this.coverageOfKind(row.kind, payload)
      if (span === null) continue
      // 与画面总长的差距才是调用方需要的：它决定「这一段有没有这类证据」。
      const gap = Math.max(0, pictureSeconds - span.toSeconds)
      coverage[row.kind] = {
        from_seconds: round2(span.fromSeconds),
        to_seconds: round2(span.toSeconds),
        count: span.count,
        covers_picture: gap < 1,
        gap_to_picture_end_seconds: gap < 1 ? null : round2(gap),
      }
    }
    return { picture_seconds: round2(pictureSeconds), kinds: coverage }
  }

  /**
   * Read the covered span out of one evidence payload, whatever shape that kind stores.
   *
   * The kinds do not share a schema, and assuming they did produced a coverage report that
   * called `silence-timing` and `acoustic-loudness` absent while their rows sat in the
   * database: the first keeps its spans under `silences` with camelCase bounds rather than
   * `lines`/`entries`/`scenes` with snake_case ones, and the second stores no spans at all -
   * it stores one decibel reading per window, so the covered length is the array length times
   * the window. A status tool that reports computed evidence as missing is worse than no
   * status tool, because the caller then pays to compute it again.
   *
   * @param kind - which evidence kind this payload belongs to.
   * @param payload - the stored record.
   * @returns The covered span, or null for a kind whose payload cannot be interpreted.
   */
  private coverageOfKind(kind: string, payload: Data): { fromSeconds: number, toSeconds: number, count: number } | null {
    // 每个窗口一个读数的类型：覆盖长度 = 读数个数 × 窗口长度。
    if (kind === EVIDENCE_ACOUSTIC) {
      const levels = Array.isArray(payload.levelsDbfs) ? payload.levelsDbfs : []
      const windowUs = Number(payload.windowUs)
      if (levels.length === 0 || !Number.isFinite(windowUs)) return null
      const declared = Number(payload.duration_us)
      const measured = (levels.length * windowUs) / 1e6
      // 读数有时比声明的总长略长（末窗取整），取小的那个。
      const toSeconds = Number.isFinite(declared) && declared > 0 ? Math.min(measured, declared / 1e6) : measured
      return { fromSeconds: 0, toSeconds, count: levels.length }
    }
    // 有显式区间的类型，两种字段命名各试一次。
    const items = [payload.lines, payload.entries, payload.scenes, payload.silences]
      .find(candidate => Array.isArray(candidate) && candidate.length > 0) as Data[] | undefined
    if (items === undefined) return null
    const starts: number[] = []
    const ends: number[] = []
    for (const item of items) {
      const start = Number(item.start_us ?? item.startUs)
      const end = Number(item.end_us ?? item.endUs)
      if (Number.isFinite(start)) starts.push(start)
      if (Number.isFinite(end)) ends.push(end)
    }
    if (starts.length === 0 || ends.length === 0) return null
    return {
      fromSeconds: Math.min(...starts) / 1e6,
      toSeconds: Math.max(...ends) / 1e6,
      count: items.length,
    }
  }

  /**
   * Where an audio track stops, in seconds, or `Infinity` when it never does.
   *
   * A stream can be present in the header and still hold nothing in the requested range.
   * The measured asset declares 2584.1s of container and video while its audio stream ends
   * at 1644.989s, so anything read past that point has no audio at all. Two paths need to
   * know this before asking ffmpeg for audio, and both fail the same way when they do not:
   * the AAC encoder gets zero samples, prints `Qavg: nan` or `Input buffer exhausted`, and
   * ffmpeg exits 69 with `Conversion failed!`.
   *
   * Answered from the stream's declared duration rather than by counting packets: seeking
   * to a timestamp and counting what comes back returned a stray packet for an empty range
   * and would have chosen the failing branch.
   *
   * Assumes one audio stream, which is what a proxy and an export both need; a second track
   * would not change whether there is audio to read.
   *
   * @param path - local media to inspect.
   * @param signal - cancellation for the probe.
   * @returns The declared end of the first audio stream, or `Infinity` when it is unknown.
   */
  private async audioEndSeconds(path: string, signal: AbortSignal): Promise<number> {
    try {
      const { stdout } = await this.run('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=duration', '-of', 'csv=p=0', path], signal)
      const declared = Number(stdout.trim().split('\n')[0])
      return Number.isFinite(declared) ? declared : Infinity
    } catch (error) {
      // 探测失败不该让渲染停下：当成「音频一直都在」，让 ffmpeg 自己去面对。
      console.warn(`video-workspace: 读取音频流时长失败，按「有音频」处理（${error instanceof Error ? error.message : String(error)}）`)
      return Infinity
    }
  }

  private async prepare(path: string, signal: AbortSignal, trim?: { startSeconds: number, endSeconds: number, fps: number }): Promise<string> {
    return this.stages.timed('生成代理视频', async () => {
      await mkdir(join(this.config.dataDir, 'tmp'), { recursive: true })
      const key = await this.hashFile(path)
      const tag = trim === undefined ? `proxy-${key}` : `proxy-${key}-${Math.round(trim.startSeconds * 1000)}-${Math.round(trim.endSeconds * 1000)}-${trim.fps}`
      const file = join(this.config.dataDir, 'tmp', `${tag}.mp4`)
      if (existsSync(file)) { this.stages.skipped('生成代理视频 · 复用缓存', '同一素材（同一区间）的代理已存在'); return file }
      const partial = `${file}.part`
      const rate = trim === undefined ? 1 : trim.fps
      // 截取区间的代理读的是这一小段，所以帧率可以调高：同样的输入体积换取更细的时间分辨。
      const seek = trim === undefined ? [] : ['-ss', String(trim.startSeconds), '-to', String(trim.endSeconds)]
      // 这一段没有音频时就不要输出音频。
      //
      // 实测那条 43 分钟素材：容器与视频流都是 2584.1s，音频流只到 1644.989s。
      // 窗口开到 1800s 起时，整个窗口里一帧音频都没有，AAC 编码器于是输出
      // `Qavg: nan`，ffmpeg 以 69 退出（Conversion failed!），整窗拿不到代理视频；
      // 前两窗落在有声区间所以正常。受控对照（同一文件、只改一个参数）：
      //   -c:a aac（现状）     退出码 69
      //   -an                  退出码 0，视频 784s 完整
      //   -c:a aac -shortest   退出码 69，且输出被截到 774s
      //   -c:a aac -af apad    退出码 69
      // 所以既不能靠 `-shortest`（它截短窗口），也不能靠补静音；
      // 只有「这一段没有音频就不输出音频」成立，判据必须落在区间上而不是文件头。
      // 顺带覆盖真的没有音轨的素材（默片、屏幕录制），它们原本会以同样方式失败。
      const hasAudio = trim === undefined
        ? (await this.run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path], signal)).stdout.trim() !== ''
        : trim.startSeconds < await this.audioEndSeconds(path, signal)
      const audio = hasAudio ? ['-c:a', 'aac', '-b:a', '64k'] : ['-an']
      await this.run('ffmpeg',['-nostdin','-y',...seek,'-i',path,'-vf',`${this.proxyScaleFilter()},fps=${rate}`,'-c:v','libx264','-preset','veryfast','-crf','25',...audio,'-f','mp4',partial],signal)
      await rename(partial, file)
      return file
    })
  }
  /** Delete cached proxies, which are rebuildable from the assets they came from. */
  private async clearProxies(): Promise<void> { const dir = join(this.config.dataDir, 'tmp'); let names: string[] = []; try { names = await readdir(dir) } catch { return } await Promise.all(names.filter(name => name.startsWith('proxy-')).map(name => rm(join(dir, name), { force: true }))) }
  /**
   * Fetch a signed URL, with a deadline.
   *
   * Every OSS call needs its own timeout: without one, an endpoint that accepts the
   * connection and then stops responding stalls the tool call — and `restore` runs
   * during plugin startup, so a stalled bucket would hang the whole boot.
   */
  private async fetchSigned(url: string, init: RequestInit = {}): Promise<Response> { const timeout = AbortSignal.timeout(this.config.requestTimeoutMs ?? 120_000); const signal = init.signal === undefined || init.signal === null ? timeout : AbortSignal.any([init.signal as AbortSignal, timeout]); return fetch(url, { ...init, signal }) }
  private async materialize(ref: string, signal: AbortSignal): Promise<{ path: string,cleanup: () => Promise<void> }> { if (!ref.startsWith('oss://')) return { path: ref, cleanup: async () => undefined }; const key = ref.slice('oss://'.length); const path = join(this.config.dataDir,'tmp',`${randomUUID()}-${basename(key)}`); await mkdir(dirname(path),{recursive:true}); const response = await this.fetchSigned(this.signedUrl(key), { signal }); if (!response.ok) throw new Error(`OSS download failed: ${response.status}`); await this.writeStreamTo(response, path); return { path, cleanup: () => rm(path, { force: true }) } }
  /**
   * Write a response body to disk a chunk at a time.
   *
   * Buffering the whole body would put an entire video in the heap, which is the same
   * failure the import size bound exists to prevent.
   */
  /**
   * Write a response body to a file, refusing a short download.
   *
   * A body that ends early is the dangerous case: the write succeeds, the file looks
   * normal, and the failure surfaces much later as an unreadable video ("moov atom not
   * found"), far from the network condition that caused it. Comparing the bytes received
   * against the length the server declared turns that into a failure here, while the
   * cause is still visible.
   *
   * @param response - the open response whose body is being saved.
   * @param path - destination file; removed when the download is short.
   */
  private async writeStreamTo(response: Response, path: string): Promise<void> {
    if (response.body === null) throw new Error('OSS download returned no body')
    const declaredRaw = response.headers.get('content-length')
    const declared = declaredRaw === null ? undefined : Number(declaredRaw)
    const reader = response.body.getReader()
    const out = createWriteStream(path)
    let received = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (chunk.value !== undefined) {
          received += chunk.value.length
          const ok = out.write(chunk.value)
          if (!ok) await new Promise<void>(resolve => out.once('drain', () => resolve()))
        }
      }
      await new Promise<void>((resolve, reject) => { out.end((error?: Error | null) => { if (error) reject(error); else resolve() }) })
      if (declared !== undefined && Number.isFinite(declared) && received !== declared) {
        await rm(path, { force: true })
        throw new Error(`下载不完整：服务器声明 ${declared} 字节，实收 ${received} 字节。文件已删除，请重试；反复出现就检查到 OSS 的网络。`)
      }
    } catch (error) { out.destroy(); await rm(path, { force: true }); throw error }
  }
  private credentials(): { id: string,secret: string } { const id = process.env[this.config.ossAccessKeyIdEnv]; const secret = process.env[this.config.ossAccessKeySecretEnv]; if (!id || !secret) throw new Error('OSS credentials are not configured'); return { id,secret } }
  private objectUrl(key: string): string { return `https://${this.config.ossBucket}.${this.config.ossEndpoint.replace(/^https?:\/\//,'')}/${key.split('/').map(encodeURIComponent).join('/')}` }
  private signature(method: string,key: string,expires: string,contentType = ''): string { return createHmac('sha1',this.credentials().secret).update(`${method}\n\n${contentType}\n${expires}\n/${this.config.ossBucket}/${key}`).digest('base64') }
  /**
   * A time-limited URL for one object, signed for the method that will use it.
   *
   * The method is part of the signature: a URL signed as GET and then used for HEAD is
   * rejected with 403, which looks like a permissions problem rather than a mismatch.
   *
   * @param key - the object key, without the `oss://` scheme.
   * @param method - the HTTP method the URL will be used with.
   * @returns The signed URL.
   */
  private signedUrl(key: string, method = 'GET'): string { const expires = String(Math.floor(Date.now() / 1000) + this.config.signedUrlSeconds); return `${this.objectUrl(key)}?OSSAccessKeyId=${encodeURIComponent(this.credentials().id)}&Expires=${expires}&Signature=${encodeURIComponent(this.signature(method, key, expires))}` }
    /** Stream a file to OSS instead of holding it in memory. */
  /**
   * Stream a file to OSS instead of holding it in memory.
   *
   * The body must be a web `ReadableStream`: the global `fetch` rejects a Node
   * `ReadStream` outright ("The string argument must be of type string or an instance
   * of Buffer or ArrayBuffer"). `duplex: 'half'` is the Node extension that permits a
   * streaming request body at all.
   */
  private async uploadFile(path: string, key: string, contentType: string): Promise<string> { const date = new Date().toUTCString(); const credentials = this.credentials(); const body = Readable.toWeb(createReadStream(path)) as unknown as BodyInit; const response = await this.fetchSigned(this.objectUrl(key),{method:'PUT',...{ duplex: 'half' } as Record<string, unknown>,headers:{Date:date,'Content-Length':String((await stat(path)).size),'Content-Type':contentType,Authorization:`OSS ${credentials.id}:${this.signature('PUT',key,date,contentType)}`},body}); if (!response.ok) { const detail = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 500); throw new Error(`OSS upload failed: ${response.status}${detail === '' ? '' : ` ${detail}`}`) } return this.signedUrl(key) }
  /** SHA-256 of a file, computed in chunks so the file never sits in the heap. */
  private async hashFile(path: string): Promise<string> { const hash = createHash('sha256'); await pipeline(createReadStream(path), hash); return hash.digest('hex') }
  /**
   * Distance from a timestamp back to the keyframe a stream copy would have to start at.
   *
   * Zero means the timestamp is itself a keyframe, so copying is exact. Reading keyframe
   * positions is far cheaper than decoding, which is why the check is affordable on
   * every render.
   */
  private async keyframeGap(path: string, atSeconds: number, signal: AbortSignal): Promise<number> { const { stdout } = await this.run('ffprobe',['-v','error','-select_streams','v','-skip_frame','nokey','-read_intervals',`${Math.max(0, atSeconds - 30)}%${atSeconds + 1}`,'-show_entries','frame=pts_time','-of','csv=p=0',path],signal); const times = stdout.split('\n').map(line => Number(line.trim().split(',')[0])).filter(value => Number.isFinite(value)); const before = times.filter(time => time <= atSeconds); if (before.length === 0) return 0; return Math.max(0, atSeconds - Math.max(...before)) }
  private async uploadBytes(data: Buffer, key: string, contentType: string): Promise<string> { const date = new Date().toUTCString(); const credentials = this.credentials(); const response = await this.fetchSigned(this.objectUrl(key),{method:'PUT',headers:{Date:date,'Content-Type':contentType,Authorization:`OSS ${credentials.id}:${this.signature('PUT',key,date,contentType)}`},body:data as unknown as BodyInit}); if (!response.ok) { const detail = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 500); throw new Error(`OSS upload failed: ${response.status}${detail === '' ? '' : ` ${detail}`}`) } return this.signedUrl(key) }
  /**
   * Ask the model about the uploaded video and return the JSON object it produced.
   *
   * Three failures are handled here rather than surfaced raw, because all three are
   * routine against a hosted model and none of them is the caller's fault:
   * a reply cut off at the output ceiling, a reply that is not valid JSON, and a
   * request refused for rate limiting. Each retry restates the task, so the model sees
   * its own bad answer and has the chance to correct it.
   */
  private async ask(url: string, prompt: string, signal: AbortSignal, require?: {
    /**
     * Return a complaint when the parsed answer does not fulfil the task, or null when it does.
     *
     * Structural JSON validity is not the same as having done the work. A reply of
     * `{"lines":[]}` parses perfectly and is also a claim that a 43-minute video with
     * audible narration contains no speech; accepted silently it produces downstream
     * behaviour that is worse than an outright failure, because every later step
     * believes the evidence was gathered. The complaint text is fed back to the model
     * as the reason for the retry, so it should name what was wrong.
     */
    validate?: (answer: Data) => string | null
    /** What the model spent on reasoning this call, for the complaint when validation fails. */
    reasoningTokens?: () => number
    /**
     * Close or lower the reasoning channel for this call.
     *
     * Extraction tasks set this; the understanding pass leaves it undefined. See
     * `Config.extractionThinking` for why.
     */
    thinking?: 'off' | 'low'
    /**
     * Which model to ask, when the task is not the one `Config.model` is for.
     *
     * Scene description needs sight but not hearing, and checking a single boundary is a
     * smaller question than either, so each names its own model rather than everything
     * paying for the one that also listens.
     */
    model?: string
  }): Promise<Data> {
    // 本次工具的用量从这里开始记，避免和上一次调用混在一起。
    this.usage = []
    this.stages.reset()
    const content: Data[] = [{ type: 'video_url', video_url: { url } }, { type: 'text', text: prompt }]
    // 调用方没指定时用部署配置；两者都没有就不改请求体。
    const thinking = require?.thinking ?? this.config.extractionThinking
    const model = require?.model ?? this.config.model
    let lastProblem = ''
    for (let attempt = 1; attempt <= Math.max(1, this.config.modelAttempts ?? 3); attempt++) {
      const reply = await this.callModel(content, signal, thinking, model)
      const text = reply.text
      const found = text === undefined ? undefined : firstJsonObject(text)
      if (found !== undefined) {
        try {
          const answer = JSON.parse(found) as Data
          const complaint = require?.validate?.(answer) ?? null
          if (complaint === null) return answer
          // 报了问题还要说清代价：模型不知道自己刚才烧掉了多少推理预算。
          const spent = require?.reasoningTokens?.() ?? 0
          lastProblem = spent > 0 ? `${complaint}（上一次回复用了 ${spent} 推理 tokens）` : complaint
        } catch (error) {
          lastProblem = `解析失败：${error instanceof Error ? error.message : String(error)}`
        }
      } else {
        lastProblem = text === undefined || text.trim() === '' ? '回复为空' : '回复里找不到完整 JSON 对象'
      }
      console.warn(`video-workspace: 第 ${attempt}/${this.config.modelAttempts ?? 3} 次模型回复不可用（${lastProblem}），重试并要求只输出 JSON`)
      // 重试不再把上一次的回复回灌进对话。
      //
      // 这里原本 push 一条 assistant 消息带上模型的上一次回答，端点以
      //   400 Missing required parameter: 'messages.[0].content[2].type'
      // 整个拒绝 —— 它不接受 assistant 回复以裸字符串的形式放回 content 数组，
      // 于是守卫挡住了坏结果，补救动作自己却崩掉，报出来的错误还与真正的原因无关。
      // 实测连续两次踩到：一次是回复为空，一次是回复里 JSON 语法错。
      //
      // 改成把「原任务 + 这次哪里不对」合成一条新的 user 消息：请求体只剩
      // video_url 与 text 两种 part，不可能再出现形状问题；坏回复本来也没有保留价值，
      // 而任务说明保留下来才不会让模型丢掉上下文。
      content.length = 0
      content.push({ type: 'video_url', video_url: { url } })
      content.push({
        type: 'text',
        text: `${prompt}\n\n上一次的输出不能用：${lastProblem}。请只输出一个完整的 JSON 对象，`
          + '不要任何解释、不要 Markdown 代码块。字段与结构必须与要求一致。',
      })
    }
    throw new Error(`模型连续 ${this.config.modelAttempts ?? 3} 次没有给出可用的 JSON（最后的问题：${lastProblem}）。可以把指令说得更具体，或缩小分析范围。`)
  }

  /**
   * One model request, with retries for rate limiting and transient server errors.
   *
   * The deadline covers the whole attempt including its backoff, so a request refused
   * repeatedly still ends inside the configured budget instead of running past it.
   */
  private async callModel(content: Data[], signal: AbortSignal, thinking?: 'off' | 'low', model?: string): Promise<{ text: string | undefined, reasoning: string | undefined }> {
    const key = process.env[this.config.apiKeyEnv]
    if (!key) throw new Error(`model API key is missing: ${this.config.apiKeyEnv}`)
    const body: Data = { model: model ?? this.config.model, temperature: 0, max_tokens: this.config.maxOutputTokens ?? 32_768, messages: [{ role: 'user', content }] }
    if (this.config.reasoningEffort !== undefined && this.config.reasoningEffort !== '') body.reasoning_effort = this.config.reasoningEffort
    // 提取任务的思考通道：关掉，或者压到最低。
    //
    // 实测该端点的行为：不传参数时模型会思考（一次「照抄一句话」也用了 159 推理
    // tokens）；`enable_thinking: false` 与 `thinking: {type:'disabled'}` 都被接受，
    // 推理量归零且答案不变；`reasoning_effort: 'low'` 仍会用掉几十个。
    // 两个都发，是因为不同兼容端点认的字段名不同，实测这个端点两个都认。
    if (thinking === 'off') {
      body.enable_thinking = false
      body.thinking = { type: 'disabled' }
    } else if (thinking === 'low') {
      body.reasoning_effort = 'low'
    }
    const deadline = Date.now() + (this.config.modelTimeoutMs ?? 1_800_000)
    const started = Date.now()
    const attempts = Math.max(1, this.config.modelAttempts ?? 3)
    let lastError = ''
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      let response: Response
      try {
        response = await fetch(`${this.config.modelBaseUrl.replace(/\/$/,'')}/chat/completions`, {
          method: 'POST',
          signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        // 调用方主动取消要立刻结束，不要拿退避时间对抗用户的取消。
        if (signal.aborted) throw error
        lastError = `${error instanceof Error ? error.message : String(error)}`
        if (attempt < attempts) { await this.pause(Math.min(2 ** attempt * 1000, 15_000), signal); continue }
        throw new Error(`Omni 请求失败（已试 ${attempt} 次）：${lastError}`)
      }
      if (response.ok) {
        const parsed = await response.json() as {
          choices?: Array<{ message?: { content?: string, reasoning_content?: string }, finish_reason?: string }>
          usage?: { completion_tokens?: number, completion_tokens_details?: { reasoning_tokens?: number, text_tokens?: number } }
        }
        const choice = parsed.choices?.[0]
        const details = parsed.usage?.completion_tokens_details
        const reasoningTokens = details?.reasoning_tokens ?? 0
        // 截断必须显式报出来：被切掉的 JSON 看起来就像「模型没按要求回答」。
        if (choice?.finish_reason === 'length') throw new Error(`Omni 的输出达到上限被截断（max_tokens=${body.max_tokens as number}，其中推理 ${reasoningTokens} tokens）。请把指令拆小，或调高 maxOutputTokens。`)
        const reasoning = choice?.message?.reasoning_content
        const trimmed = typeof reasoning === 'string' ? reasoning.trim() : ''
        // 覆盖而非追加：重试时调用方只为最终那次回答付费。
        this.usage = [{
          provider: 'bailian',
          model: String(this.config.model),
          ms: Date.now() - started,
          text_tokens: details?.text_tokens ?? Math.max(0, (parsed.usage?.completion_tokens ?? 0) - reasoningTokens),
          reasoning_tokens: reasoningTokens,
          reasoning_chars: trimmed.length,
          reasoning_head: trimmed.slice(0, 600),
        }]
        if (trimmed !== '') console.info(`video-workspace: 模型思考（${reasoningTokens} 推理 tokens）\n${trimmed}`)
        return { text: choice?.message?.content, reasoning }
      }
      const detail = (await response.text()).slice(0, 200).replace(/\s+/g, ' ')
      lastError = `HTTP ${response.status} ${detail}`
      const transient = response.status === 429 || response.status >= 500
      if (!transient) throw new Error(`Omni request failed: ${response.status} ${detail}`)
      if (attempt < attempts) { await this.pause(Math.min(2 ** attempt * 1000, 15_000), signal); continue }
    }
    throw new Error(`Omni request failed after ${attempts} attempts: ${lastError}`)
  }

  /** The model usage of the invocation that just finished, or an empty list. */
  lastUsage(): ModelUsage[] { return this.usage }
  /**
   * Loudness evidence: a decibel value for each second of the asset.
   *
   * The audio is decoded to raw PCM and measured here rather than read from ffmpeg's
   * own filters, because the per-window reporting those filters offer differs between
   * builds. Decoding at 8 kHz mono is enough for loudness and keeps a five-minute asset
   * under five megabytes.
   */
  async acousticEvidence(projectId: string, assetId: string, signal: AbortSignal): Promise<Data> {
    const cached = await this.cachedEvidence(assetId, EVIDENCE_ACOUSTIC)
    if (cached !== undefined) return cached
    const asset = await this.asset(projectId, assetId)
    this.stages.reset()
    const source = await this.stages.timed('准备素材', () => this.materialize(asset.path, signal))
    try {
      const raw = join(this.config.dataDir, 'tmp', `${randomUUID()}.raw`)
      await mkdir(dirname(raw), { recursive: true })
      // -map a:0 明确只要音轨；没有音轨的视频会让 ffmpeg 报错，这里转成可读原因。
      await this.stages.timed('解码音频', async () => {
        await this.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source.path, '-vn', '-map', 'a:0', '-ac', '1', '-ar', String(this.config.acousticSampleRate ?? 8000), '-f', 's16le', raw], signal)
      })
      try {
        const pcm = await readFile(raw)
        const sampleRate = this.config.acousticSampleRate ?? 8000
        const windowUs = (this.config.acousticWindowMs ?? 1000) * 1000
        const levels = curveFromPcm(pcm, windowUs, sampleRate)
        if (levels.length === 0) throw new Error('解码后没有可测量的音频样本（素材可能没有音轨，或短于一个测量窗口）')
        const curve = summarize(levels, windowUs, this.config.acousticPeakLimit ?? 20)
        const duration = await this.durationOf(assetId)
        const record = { ...curve, loud_spans: loudSpans(curve), duration_us: duration ?? levels.length * windowUs, sample_rate: sampleRate }
        await this.saveEvidence(projectId, assetId, EVIDENCE_ACOUSTIC, record, duration ?? levels.length * windowUs)
        return { asset_id: assetId, cached: false, ...record, stages: this.stages.snapshot() }
      } finally { await rm(raw, { force: true }) }
    } finally { await source.cleanup() }
  }

  /**
   * Shot evidence: where the camera cuts, how long shots run, and which passages are
   * cut fastest.
   *
   * ffmpeg's scene score is the fraction of the frame that changed, so a cut is a spike.
   * The threshold is applied by the filter and the resulting timestamps are filtered
   * again here to drop cuts too close together to be separate shots.
   */
  async shotEvidence(projectId: string, assetId: string, signal: AbortSignal): Promise<Data> {
    const cached = await this.cachedEvidence(assetId, EVIDENCE_SHOTS)
    if (cached !== undefined) return cached
    const asset = await this.asset(projectId, assetId)
    this.stages.reset()
    const source = await this.stages.timed('准备素材', () => this.materialize(asset.path, signal))
    try {
      const threshold = this.config.shotSceneThreshold ?? 0.3
      const { stdout, stderr } = await this.stages.timed('分析镜头切点', () => this.runCapture('ffmpeg', ['-nostdin', '-hide_banner', '-i', source.path, '-filter:v', `select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-'], signal))
      // showinfo 写到 stderr，不同构建也可能落到 stdout；两处都收。
      const cuts = parseSceneTimes(`${stdout}\n${stderr}`)
      const duration = (await this.durationOf(assetId)) ?? 0
      const shots = buildShots(cuts, duration, (this.config.shotMinSeconds ?? 0.4) * 1_000_000)
      const summary = summarizeShots(shots, duration, (this.config.shotPacingWindowSeconds ?? 30) * 1_000_000, this.config.shotBusyLimit ?? 8)
      const record = { ...summary, scene_threshold: threshold, duration_us: duration, cut_count: Math.max(0, shots.length - 1) }
      await this.saveEvidence(projectId, assetId, EVIDENCE_SHOTS, record, duration)
      return { asset_id: assetId, cached: false, ...record, stages: this.stages.snapshot() }
    } finally { await source.cleanup() }
  }

  /**
   * Timing evidence: the pauses, and the intervals that remain once they are removed.
   *
   * `kept_intervals` is the answer to "去掉所有停顿" — the caller builds a timeline from
   * it directly instead of removing spans one at a time and merging the overlaps.
   */
  async timingEvidence(projectId: string, assetId: string, signal: AbortSignal): Promise<Data> {
    const cached = await this.cachedEvidence(assetId, EVIDENCE_TIMING)
    if (cached !== undefined) return cached
    const asset = await this.asset(projectId, assetId)
    this.stages.reset()
    const source = await this.stages.timed('准备素材', () => this.materialize(asset.path, signal))
    try {
      const minSeconds = this.config.silenceMinSeconds ?? 0.4
      // The threshold follows this asset's own loudness floor rather than a fixed level.
      // A fixed level deletes real content: quiet speech sits below any constant that is
      // high enough to catch pauses in a loud recording, so the whole passage reads as
      // silence and "remove the pauses" removes the material instead.
      const acoustic = await this.acousticEvidence(projectId, assetId, signal) as { floorDbfs?: number, peakDbfs?: number }
      const margin = this.config.silenceMarginDb ?? 10
      const rawThreshold = (acoustic.floorDbfs ?? -60) + margin
      // Never let the threshold reach the peak: that would mark the whole track silent.
      const ceiling = (acoustic.peakDbfs ?? 0) - 6
      const noiseDb = Math.round(Math.min(rawThreshold, ceiling) * 10) / 10
      const captured = await this.stages.timed('检测静音段', () => this.runCapture('ffmpeg', ['-nostdin', '-hide_banner', '-i', source.path, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`, '-vn', '-f', 'null', '-'], signal))
      const duration = (await this.durationOf(assetId)) ?? 0
      const silences: SilenceSpan[] = buildSilences(parseSilences(`${captured.stderr}\n${captured.stdout}`), duration, minSeconds)
      const kept = subtractSpans(duration, silences, (this.config.minKeepSeconds ?? 0.3) * 1_000_000)
      const record = { silences, silence_count: silences.length, silenced_us: silences.reduce((sum, span) => sum + (span.endUs - span.startUs), 0), kept_intervals: kept, kept_count: kept.length, min_keep_seconds: this.config.minKeepSeconds ?? 0.3, noise_db: noiseDb, duration_us: duration }
      await this.saveEvidence(projectId, assetId, EVIDENCE_TIMING, record, duration)
      return { asset_id: assetId, cached: false, ...record, stages: this.stages.snapshot() }
    } finally { await source.cleanup() }
  }

  /**
   * The local copy of an exported object, when the deployment keeps one.
   *
   * The path mirrors the OSS key under the data directory, which is where a local export
   * writes before uploading. Absent means the object exists only in the bucket.
   *
   * @param key - the object key, without the `oss://` scheme.
   * @returns The absolute path when a file is there, otherwise `undefined`.
   */
  private async localOutputPath(key: string): Promise<string | undefined> {
    const candidate = join(this.config.dataDir, 'oss-output', key)
    return existsSync(candidate) ? candidate : undefined
  }

  /** Read stored evidence without computing it, or `undefined` when absent. */
  private async cachedEvidence(assetId: string, kind: string, expectedProviderVersion?: string): Promise<Data | undefined> {
    const row = (await this.open()).prepare('SELECT payload, provider_version FROM evidence WHERE asset_id=? AND kind=?').get(assetId, kind) as { payload: string, provider_version: string } | undefined
    if (row === undefined) return undefined
    // 产出方式的版本变了，旧记录就不能再用。
    //
    // 缓存原本只按 (asset, kind) 命中，于是改进提取方式后，已经被算过一遍的素材
    // 会永远返回旧结果 —— 修复对存量素材等于没有生效，而这恰恰是最需要它的地方
    // （一条 43 分钟的视频只会被提取一次，之后再也不会重算）。
    // provider_version 随项目清单往返 OSS，所以判断在本地也能做。
    if (expectedProviderVersion !== undefined && row.provider_version !== expectedProviderVersion) return undefined
    return { asset_id: assetId, cached: true, ...(JSON.parse(row.payload) as Data) }
  }

  /** Store one evidence row and re-upload the project manifest so OSS carries it too. */
  private async saveEvidence(projectId: string, assetId: string, kind: string, payload: Data, durationUs: number, providerVersion?: string): Promise<void> {
    const db = await this.open()
    db.prepare('INSERT OR REPLACE INTO evidence (asset_id,kind,duration_us,payload,provider,provider_version,created_at) VALUES (?,?,?,?,?,?,?)').run(assetId, kind, Math.round(durationUs), JSON.stringify(payload), kind === EVIDENCE_ACOUSTIC ? 'ffmpeg' : 'ffmpeg', providerVersion ?? EVIDENCE_PROVIDER_VERSION, Date.now())
    await this.manifest(projectId)
  }

  /** Run a command and capture both streams; ffmpeg reports filter output on stderr. */
  private async runCapture(file: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string, stderr: string }> {
    try {
      const { stdout, stderr } = await execFile(file, args, { signal, maxBuffer: 64 * 1024 * 1024 })
      return { stdout: String(stdout), stderr: String(stderr) }
    } catch (error) {
      // ffmpeg 用非零退出码报告"没有匹配的帧"之类的正常情况，但输出仍有效；
      // 只有在拿不到任何输出时才当作失败。
      const failed = error as { stdout?: string, stderr?: string, message?: string }
      if (typeof failed.stdout === 'string' || typeof failed.stderr === 'string') return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
      throw error
    }
  }

  /** The stage timings of the invocation that just finished. */
  /** The stage timings of the invocation that just finished. */
  lastStages(): StageTiming[] { return this.stages.snapshot() }
  /** Wait before the next attempt, unless the caller cancels first. */
  private async pause(ms: number, signal: AbortSignal): Promise<void> { await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms); const onAbort = (): void => { clearTimeout(timer); reject(new Error('已取消')) }; signal.addEventListener('abort', onAbort, { once: true }) }) }
  /** Serialise manifest uploads per project so an older snapshot cannot land last. */
  private async manifest(projectId: string): Promise<void> {
    const previous = this.manifestWrites.get(projectId) ?? Promise.resolve()
    const next = previous.then(() => this.uploadManifest(projectId), () => this.uploadManifest(projectId))
    this.manifestWrites.set(projectId, next.catch(() => undefined))
    return next
  }

  private async uploadManifest(projectId: string): Promise<void> { const db = await this.open(); const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as Data | undefined; if (!project) return; const assets = db.prepare('SELECT * FROM assets WHERE project_id=?').all(projectId); const timelines = db.prepare('SELECT * FROM timelines WHERE project_id=?').all(projectId); const jobs = db.prepare('SELECT j.* FROM jobs j JOIN timelines t ON t.id=j.timeline_id WHERE t.project_id=?').all(projectId); const analyses = db.prepare('SELECT a.id asset_id,an.instruction,an.data,an.created_at FROM assets a JOIN analyses an ON an.asset_id=a.id WHERE a.project_id=?').all(projectId); const evidence = db.prepare('SELECT e.* FROM evidence e JOIN assets a ON a.id=e.asset_id WHERE a.project_id=?').all(projectId); const segments = db.prepare('SELECT s.timeline_id, s.ordinal, s.asset_id, s.start_us, s.end_us, s.speed, s.muted FROM timeline_segments s JOIN timelines t ON t.id=s.timeline_id WHERE t.project_id=? ORDER BY s.timeline_id, s.ordinal').all(projectId); const proposals = db.prepare('SELECT * FROM proposals WHERE project_id=?').all(projectId); const prefix = this.config.ossProjectPrefix.replace(/\/$/,''); const key = `${prefix}/${projectId}/manifest.json`; await this.uploadBytes(Buffer.from(JSON.stringify({ version: 5, project, assets, timelines, jobs, analyses, evidence, segments, proposals }, null, 2)), key, 'application/json'); const ids = (db.prepare('SELECT id FROM projects ORDER BY id').all() as Array<{ id: string }>).map(row => row.id); await this.uploadBytes(Buffer.from(JSON.stringify({ version: 5, projects: ids }, null, 2)), `${prefix}/index.json`, 'application/json') }
  /**
   * Rebuild the local index from the OSS manifest, which owns the data.
   *
   * Rows are admitted one at a time and checked against the schema's relations,
   * because a manifest written by an older build can still carry a cross-project
   * timeline or a range past the end of its asset — and a rejected row must skip
   * itself, not abort the whole restore.
   */
  private async restore(): Promise<void> {
    const db = this.db
    if (!db || (db.prepare('SELECT count(*) count FROM projects').get() as { count: number }).count > 0) return
    const prefix = this.config.ossProjectPrefix.replace(/\/$/,'')
    let skipped = 0
    try {
      const indexResponse = await fetch(this.signedUrl(`${prefix}/index.json`))
      if (!indexResponse.ok) return
      const index = await indexResponse.json() as { projects?: string[] }
      for (const id of index.projects ?? []) {
        const response = await fetch(this.signedUrl(`${prefix}/${id}/manifest.json`))
        if (!response.ok) continue
        const manifest = await response.json() as {
          project: { id: string, name: string }
          assets?: Array<{ id: string, project_id: string, path: string, meta: string }>
          timelines?: Array<{ id: string, name?: string | null, project_id: string, asset_id: string, start_us: number, end_us: number, revision: number }>
          jobs?: Array<{ id: string, timeline_id: string, status: string, output?: string | null, detail?: string | null }>
          analyses?: Array<{ asset_id: string, instruction?: string, data: string, created_at?: number }>
          evidence?: Array<{ asset_id: string, kind: string, duration_us: number, payload: string, provider: string, provider_version: string, created_at: number }>
          segments?: Array<{ timeline_id: string, ordinal: number, asset_id: string, start_us: number, end_us: number, speed: number, muted: number }>
          proposals?: Array<{ id: string, project_id: string, timeline_id: string | null, status: string, revision: number, items: string, notes: string | null, created_at: number, updated_at: number }>
        }
        db.prepare('INSERT OR IGNORE INTO projects (id,name) VALUES (?,?)').run(manifest.project.id, manifest.project.name)
        const duration = new Map<string, number>()
        for (const row of manifest.assets ?? []) {
          db.prepare('INSERT OR IGNORE INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run(row.id, row.project_id, row.path, row.meta)
          const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) as { duration_us?: number } : (row.meta as unknown as { duration_us?: number })
          if (typeof meta?.duration_us === 'number') duration.set(row.id, meta.duration_us)
        }
        for (const row of manifest.timelines ?? []) {
          const owner = db.prepare('SELECT project_id FROM assets WHERE id=?').get(row.asset_id) as { project_id: string } | undefined
          if (!owner || owner.project_id !== row.project_id || row.start_us >= row.end_us) { skipped++; continue }
          const limit = duration.get(row.asset_id)
          const end = typeof limit === 'number' && limit > 0 ? Math.min(row.end_us, limit) : row.end_us
          if (row.start_us >= end) { skipped++; continue }
          // 清单里的 name 是后来才有的字段，旧清单没有它，缺就用 null。
          db.prepare('INSERT OR IGNORE INTO timelines (id,name,project_id,asset_id,start_us,end_us,revision) VALUES (?,?,?,?,?,?,?)').run(row.id, row.name ?? null, row.project_id, row.asset_id, row.start_us, end, row.revision)
        }
        for (const row of manifest.jobs ?? []) {
          if (!db.prepare('SELECT 1 FROM timelines WHERE id=?').get(row.timeline_id)) { skipped++; continue }
          db.prepare('INSERT OR IGNORE INTO jobs (id,timeline_id,status,output,detail) VALUES (?,?,?,?,?)').run(row.id, row.timeline_id, row.status, row.output ?? null, row.detail ?? null)
        }
        for (const row of manifest.analyses ?? []) {
          if (!db.prepare('SELECT 1 FROM assets WHERE id=?').get(row.asset_id)) { skipped++; continue }
          // 老清单里的分析没有 instruction 字段，只有嵌在 data 里的那一份；
          // 从这里补齐，多份分析才能各归各位而不是互相覆盖。
          let instruction = row.instruction
          if (instruction === undefined || instruction === '') {
            try {
              const parsed = JSON.parse(row.data) as { instruction?: unknown }
              instruction = typeof parsed.instruction === 'string' && parsed.instruction !== '' ? parsed.instruction : DEFAULT_INSTRUCTION
            } catch { instruction = DEFAULT_INSTRUCTION }
          }
          db.prepare('INSERT OR IGNORE INTO analyses (asset_id,instruction,data,created_at) VALUES (?,?,?,?)').run(row.asset_id, instruction, this.normalizeStoredAnalysis(row.data), row.created_at ?? Date.now())
        }
        for (const row of manifest.segments ?? []) {
          if (!db.prepare('SELECT 1 FROM timelines WHERE id=?').get(row.timeline_id)) { skipped++; continue }
          db.prepare('INSERT OR IGNORE INTO timeline_segments (timeline_id,ordinal,asset_id,start_us,end_us,speed,muted) VALUES (?,?,?,?,?,?,?)').run(row.timeline_id, row.ordinal, row.asset_id, row.start_us, row.end_us, row.speed, row.muted)
        }
        for (const row of manifest.proposals ?? []) {
          // 方案是未确认的计划，必须一起恢复：丢了它用户就没法回头确认自己看过的方案。
          if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(row.project_id)) { skipped++; continue }
          db.prepare('INSERT OR IGNORE INTO proposals (id,project_id,timeline_id,status,revision,items,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(row.id, row.project_id, row.timeline_id, row.status, row.revision, row.items, row.notes, row.created_at, row.updated_at)
        }
        for (const row of manifest.evidence ?? []) {
          // 证据是对素材的派生，重算即可；恢复只把已有的搬回来，不校验内容。
          if (!db.prepare('SELECT 1 FROM assets WHERE id=?').get(row.asset_id)) { skipped++; continue }
          db.prepare('INSERT OR IGNORE INTO evidence (asset_id,kind,duration_us,payload,provider,provider_version,created_at) VALUES (?,?,?,?,?,?,?)').run(row.asset_id, row.kind, row.duration_us, row.payload, row.provider, row.provider_version, row.created_at)
        }
      }
      if (skipped > 0) console.warn(`video-workspace: OSS 恢复时跳过了 ${skipped} 行不满足约束的数据`)
    } catch (error) { /* 恢复失败不阻止本地启动，但必须说出来：配错凭据或 bucket 时，用户看到的会是「项目全没了」。 */ console.warn(`video-workspace: OSS 项目恢复失败，本次只使用本地数据: ${error instanceof Error ? error.message : String(error)}`) }
  }
  /**
   * Close the index and let the OSS manifest stand alone.
   *
   * The plugin owns one long-lived connection, so the host needs a way to release
   * it; without this the SQLite file stays locked and its WAL sidecar keeps growing
   * for the life of the process.
   */
  async dispose(): Promise<void> {
    try { this.db?.close() } catch { /* 已经关过或从未打开；关闭失败没有可恢复的动作 */ }
    this.db = undefined
    this.dbPending = undefined
    // 代理视频是可重建的缓存；进程结束时清掉，免得缓存目录随使用无限增长。
    await this.clearProxies().catch(() => undefined)
  }
  private async run(file: string,args: string[],signal?: AbortSignal): Promise<{ stdout: string }> { const { stdout } = await execFile(file,args,{signal,maxBuffer:16 * 1024 * 1024}); return { stdout } }
}

/**
 * Format a microsecond position as an SRT or WebVTT timecode.
 *
 * @param us - position in microseconds.
 * @param useDot - WebVTT wants a dot before milliseconds; SRT wants a comma.
 * @returns The timecode for that position.
 */
function timecode(us: number, useDot: boolean): string {
  const total = Math.max(0, Math.round(us / 1000))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  const sep = useDot ? '.' : ','
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${sep}${String(millis).padStart(3, '0')}`
}

/**
 * Render cues as SRT.
 *
 * @param cues - timed lines, already in film coordinates and time order.
 * @returns The subtitle file's text.
 */
function renderSrt(cues: Array<{ start_us: number, end_us: number, text: string }>): string {
  return cues.map((cue, index) => `${index + 1}\n${timecode(cue.start_us, false)} --> ${timecode(cue.end_us, false)}\n${cue.text}\n`).join('\n')
}

/**
 * Render cues as WebVTT.
 *
 * @param cues - timed lines, already in film coordinates and time order.
 * @returns The subtitle file's text.
 */
function renderVtt(cues: Array<{ start_us: number, end_us: number, text: string }>): string {
  return `WEBVTT\n\n${cues.map(cue => `${timecode(cue.start_us, true)} --> ${timecode(cue.end_us, true)}\n${cue.text}\n`).join('\n')}`
}

/**
 * Round to four decimal places.
 *
 * Normalised axis positions are rounded for payload size, but two decimals quantises a
 * ten-minute asset to six-second steps — visible as stair-stepping once the panel scales
 * that position to a few hundred pixels.
 *
 * @param value - number to round.
 * @returns The value at four decimal places.
 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
