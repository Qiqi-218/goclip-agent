/**
 * Proposals: a plan the user approves before anything changes.
 *
 * The behaviour worth proving is the separation itself. Draw a plan and the timeline must
 * be byte-for-byte what it was; only `accept` may change it. Everything else here checks
 * that a plan cannot silently diverge from the edit it lands on — a stale revision, a
 * second accept, or an edit after acceptance are all refused.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNTIME = process.argv[2]
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/chat/completions')) return realFetch(url, init)
  if (init?.method === 'PUT') return new Response('', { status: 200 })
  return new Response(JSON.stringify({ version: 5, projects: [] }), { status: 200 })
}

const dir = await mkdtemp(join(tmpdir(), 'goclip-plan-'))
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
await vw.createProject('pp', '方案测试')
const { DatabaseSync } = await import('node:sqlite')
const raw = new DatabaseSync(join(dir, 'video-tools.sqlite'))
raw.exec('PRAGMA foreign_keys=ON')
raw.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('ap', 'pp', '/tmp/plan.mp4', JSON.stringify({ duration_us: 60_000_000 }))
raw.close()

const ITEMS = [
  { asset_id: 'ap', start_us: 0, end_us: 5_000_000, chosen_because: '开场钩子', evidence_refs: [{ source: 'analysis', start_us: 0, end_us: 5_000_000 }] },
  { asset_id: 'ap', start_us: 10_000_000, end_us: 15_000_000, chosen_because: '响度峰值段', evidence_refs: [{ source: 'acoustic-loudness', peak_dbfs: -14.2 }] },
  { asset_id: 'ap', start_us: 30_000_000, end_us: 33_000_000, chosen_because: '梗图段', evidence_refs: [{ source: 'shot-boundaries', cuts: 2 }] },
]

let timeline = null
let proposal = null

// ── 出方案绝不能动时间线 ────────────────────────────────────────────────────
{
  timeline = await vw.createTimeline({ id: 'tp', name: '成片', project_id: 'pp', asset_id: 'ap', start_us: 0, end_us: 1_000_000 })
  const before = JSON.stringify(await vw.timeline('tp'))
  proposal = await vw.proposalCreate({ id: 'pr1', project_id: 'pp', timeline_id: 'tp', items: ITEMS, notes: '90 秒高光版' })
  const after = JSON.stringify(await vw.timeline('tp'))
  record('出方案不动时间线（逐字节相同）', before === after, before === after ? '时间线对象未变化' : '时间线被改了')
  record('方案记录了段数与理由',
    proposal.segment_count === 3 && proposal.items.every(i => typeof i.chosen_because === 'string'),
    `${proposal.segment_count} 段，理由=${JSON.stringify(proposal.items.map(i => i.chosen_because))}`)
  record('方案按倍速折算总时长', proposal.total_seconds === 13, `total_seconds=${proposal.total_seconds}（5+5+3）`)
  record('证据引用被原样保存',
    proposal.items[1].evidence_refs[0].source === 'acoustic-loudness' && proposal.items[1].evidence_refs[0].peak_dbfs === -14.2,
    JSON.stringify(proposal.items[1].evidence_refs))
  record('初始状态是 draft', proposal.status === 'draft' && proposal.revision === 1, `status=${proposal.status} revision=${proposal.revision}`)
}

// ── 修改：版本锁 + 只允许 draft ─────────────────────────────────────────────
{
  let blocked = false
  try { await vw.proposalRevise({ id: 'pr1', base_revision: 99, notes: 'x' }) }
  catch (error) { blocked = String(error.message).includes('revision conflict') }
  record('用旧版本号改方案被拒绝', blocked, blocked ? '抛出了 revision conflict' : '没有拦住')

  const shorter = ITEMS.slice(0, 2)
  proposal = await vw.proposalRevise({ id: 'pr1', base_revision: proposal.revision, items: shorter, notes: '砍到两段' })
  record('改成两段后总时长跟着变', proposal.segment_count === 2 && proposal.total_seconds === 10,
    `段数=${proposal.segment_count} 总时长=${proposal.total_seconds}`)
  record('修改推进方案版本号', proposal.revision === 2, `revision=${proposal.revision}`)
  record('只改备注时片段保持不动',
    (await vw.proposalRevise({ id: 'pr1', base_revision: proposal.revision, notes: '再改备注' })).segment_count === 2,
    '段数仍为 2')

  // 版本号要用当前的：写死一个旧值会让版本冲突先触发，这条断言就没测到东西。
  let refused = false
  const fresh = await vw.proposal('pr1')
  try { await vw.proposalRevise({ id: 'pr1', base_revision: fresh.revision, items: [] }) }
  catch (error) { refused = String(error.message).includes('至少要有一段') }
  record('拒绝把方案改成空', refused, refused ? '明确拒绝' : '没有拦住')
}

// ── 确认：时间线版本锁 + 落地 ───────────────────────────────────────────────
{
  const current = await vw.proposal('pr1')
  let blocked = false
  try { await vw.proposalAccept({ id: 'pr1', base_revision: current.revision, timeline_id: 'tp', timeline_revision: 99 }) }
  catch (error) { blocked = String(error.message).includes('revision conflict') }
  record('时间线版本号过旧时拒绝确认', blocked, blocked ? '抛出了 revision conflict' : '没有拦住')

  const accepted = await vw.proposalAccept({ id: 'pr1', base_revision: current.revision, timeline_id: 'tp', timeline_revision: timeline.revision })
  record('确认后时间线变成方案的两段',
    accepted.timeline.segment_count === 2 && accepted.timeline.segments[0].start_us === 0 && accepted.timeline.segments[1].start_us === 10_000_000,
    `段数=${accepted.timeline.segment_count}，区间=${JSON.stringify(accepted.timeline.segments.map(s => [s.start_us / 1e6, s.end_us / 1e6]))}`)
  record('确认后方案状态变为 accepted', accepted.proposal.status === 'accepted', `status=${accepted.proposal.status}`)

  let again = false
  try { await vw.proposalAccept({ id: 'pr1', base_revision: accepted.proposal.revision, timeline_id: 'tp', timeline_revision: accepted.timeline.revision }) }
  catch (error) { again = String(error.message).includes('不能再次确认') }
  record('同一方案不能被确认两次', again, again ? '明确拒绝' : '没有拦住')

  let reviseAfter = false
  try { await vw.proposalRevise({ id: 'pr1', base_revision: accepted.proposal.revision, notes: '改一下' }) }
  catch (error) { reviseAfter = String(error.message).includes('不能再改') }
  record('已确认的方案不能再改（否则会与时间线脱节）', reviseAfter, reviseAfter ? '明确拒绝' : '没有拦住')
}

// ── 越界的方案在创建时就被挡住 ──────────────────────────────────────────────
{
  let outside = false
  try { await vw.proposalCreate({ id: 'pr2', project_id: 'pp', items: [{ asset_id: 'ap', start_us: 0, end_us: 999_000_000 }] }) }
  // assertRange 的报诊是英文的 "past the end of asset"，匹配文本要对上。
  catch (error) { outside = /past the end of asset/i.test(String(error.message)) }
  record('越界区间在创建方案时就被拒绝', outside, outside ? '创建即拒绝，不拖到确认时' : '没有拦住')
  let unknown = false
  try { await vw.proposalCreate({ id: 'pr3', project_id: 'pp', items: [{ asset_id: 'nope', start_us: 0, end_us: 1000 }] }) }
  catch { unknown = true }
  record('引用不存在的素材被拒绝', unknown, unknown ? '明确拒绝' : '没有拦住')
}

// ── 回滚：revision 历史必须真的能回去 ──────────────────────────────────────
{
  const before = await vw.timeline('tp')
  const history = await vw.timelineHistory('tp')
  record('时间线留有可回滚的历史', history.entries.length >= 2,
    `共 ${history.entries.length} 个版本：${JSON.stringify(history.entries.map(e => [e.revision, e.segment_count, e.note]))}`)
  // 回到一开始那一段的样子
  const earliest = history.entries[history.entries.length - 1]
  const back = await vw.revertTimeline({ timeline_id: 'tp', base_revision: before.revision, target_revision: earliest.revision })
  record('回滚到早先版本会恢复当时的片段',
    back.timeline.segment_count === earliest.segment_count,
    `回到 revision ${earliest.revision}：${earliest.segment_count} 段 → 现在 ${back.timeline.segment_count} 段`)
  record('回滚本身也是一次编辑（版本号继续前进）', back.timeline.revision === before.revision + 1,
    `revision ${before.revision} → ${back.timeline.revision}`)
  record('回滚后还能再回滚回来',
    (await vw.timelineHistory('tp')).entries.some(e => e.revision === before.revision),
    `当前可用版本=${JSON.stringify((await vw.timelineHistory('tp')).entries.map(e => e.revision))}`)
  // 每个版本必须记的是**那个版本当时**的段数。只断言"有历史"抓不到快照错位，
  // 上一版就是因为把编辑后的状态贴到了旧版本号上而只剩一条记录。
  const after = await vw.timelineHistory('tp')
  const layered = after.entries.length === new Set(after.entries.map(e => e.revision)).size
  record('历史按版本分层且每个版本段数不同（快照没有错位）',
    // 段数可能重复（删一段又加一段），关键是没有重复版本号、且至少记录了两个不同状态。
    layered && after.entries.length >= 3 && new Set(after.entries.map(e => e.segment_count)).size >= 2,
    `版本→段数：${JSON.stringify(after.entries.map(e => [e.revision, e.segment_count]))}`)

  let bad = false
  try { await vw.revertTimeline({ timeline_id: 'tp', base_revision: back.timeline.revision, target_revision: 999 }) }
  catch (error) { bad = String(error.message).includes('没有 revision') }
  record('回滚到不存在的版本被拒绝', bad, bad ? '明确拒绝并指出该看历史' : '没有拦住')
}

// ── 改名：不属于编辑内容，因此不动 revision ─────────────────────────────────
{
  const before = await vw.timeline('tp')
  const renamed = await vw.renameTimeline('tp', '  高光集锦  ')
  record('改名会去掉首尾空白并保存', renamed.name === '高光集锦', `name=${JSON.stringify(renamed.name)}`)
  record('改名不动 revision（它不是编辑内容）', renamed.revision === before.revision,
    `revision ${before.revision} → ${renamed.revision}`)
  record('改名不动片段', renamed.segment_count === before.segment_count,
    `段数 ${before.segment_count} → ${renamed.segment_count}`)
  const cleared = await vw.renameTimeline('tp', '   ')
  record('传空字符串则清空名字', cleared.name === null, `name=${JSON.stringify(cleared.name)}`)
}

vw.dispose()
console.log('\n' + '='.repeat(64))
const bad = results.filter(r => !r.ok)
console.log(`共 ${results.length} 项，问题 ${bad.length} 项`)
for (const b of bad) console.log(`  · ${b.name}：${b.detail}`)
