/**
 * Sentence-level narrowing inside the local search.
 *
 * `video_find` used to answer with the whole analysis segment, which in a real session
 * ran 35-160 seconds wide. The caller needed one sentence, could not get it locally, and
 * escalated to re-analysing the entire video 21 times (838 s). The analysis already held
 * the narration, so the missing piece was grain, not content.
 *
 * This pins down that the search now narrows to the containing sentence, and — just as
 * important — that it declines instead of guessing when the sentence cannot be located.
 */
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const RUNTIME = process.argv[2]
if (RUNTIME === undefined) {
  console.error('用法：node probe-sentence-span.mjs <runtime.js 的 file URL>')
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

const dir = await mkdtemp(join(tmpdir(), 'goclip-span-'))
const clip = join(dir, 'span-source.mp4')
await run('ffmpeg', ['-nostdin', '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=100,format=yuv420p',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=100',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip],
{ maxBuffer: 64 * 1024 * 1024 })

globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/index.json')) return new Response(JSON.stringify({ version: 5, projects: [] }), { status: 200 })
  if (init?.method === 'PUT') return new Response('', { status: 200 })
  return new Response('stub', { status: 200 })
}

const config = {
  dataDir: dir,
  modelBaseUrl: 'http://stub.invalid/v1', model: 'stub', apiKeyEnv: 'STUB_ID',
  ossEndpoint: 'e', ossBucket: 'b', ossAccessKeyIdEnv: 'STUB_ID', ossAccessKeySecretEnv: 'STUB_SECRET',
  ossPrefix: 't', ossOutputPrefix: 'o', ossProjectPrefix: 'p', signedUrlSeconds: 900,
  maxImportBytes: 1 << 30, requestTimeoutMs: 5000, modelTimeoutMs: 20000, searchLimit: 50,
  keepSourceFiles: true, keyframeToleranceMs: 500, modelAttempts: 1,
  acousticSampleRate: 8000, acousticWindowMs: 1000, acousticPeakLimit: 20,
  shotSceneThreshold: 0.3, shotMinSeconds: 0.4, shotPacingWindowSeconds: 5, shotBusyLimit: 8,
  silenceMinSeconds: 0.4, silenceNoiseDb: -30, refineToleranceSeconds: 1.5, verifyBoundaries: false,
}
process.env.STUB_ID = 'x'
process.env.STUB_SECRET = 'y'

const { VideoWorkspace } = await import(RUNTIME)
const { DatabaseSync } = await import('node:sqlite')

const vw = new VideoWorkspace(config)
await vw.createProject('ps', '句级区间')
{
  const db = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  db.exec('PRAGMA foreign_keys=ON')
  db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('as1', 'ps', clip, JSON.stringify({ duration_us: 100_000_000 }))
  // 一段 100 秒、段内 8 句 —— 与真实分析一致的形状。
  //
  // 早先只写了 4 句，于是目标句自己就占 42% 的字数，收窄后仍有 42.6 秒，
  // 断言看着像失败、其实是素材不像真的。真实数据是 168 句分布在 28 段里
  // （每段 6 句，句宽中位数 13.2 秒），所以这里按 8 句构造。
  const segment = {
    start_us: 0, end_us: 100_000_000,
    visual: '讲解者站在塔前',
    audio: '开场先介绍这座塔的位置。然后说明它为什么这么出名。接着讲了一段修缮的历史。'
      + '与其强请画毁不如售画修庙，这是当年卖壁画时给出的理由。随后提到那批壁画如今的下落。'
      + '又说回塔本身的琉璃装饰。最后总结这一段历史的意义。',
    tags: ['塔'], is_highlight: false, highlight_reason: null, confidence: 0.9,
  }
  // 表结构是 (asset_id, instruction, data, created_at)，created_at 非空。
  db.prepare('INSERT INTO analyses (asset_id,instruction,data,created_at) VALUES (?,?,?,?)')
    .run('as1', '讲塔', JSON.stringify({ segments: [segment] }), Date.now())
  db.close()
}

console.log('=== 段落本身有 100 秒宽，目标句只在其中 ===')
const hit = await vw.findSpans('ps', 'as1', { text: '售画修庙' })
record('检索仍然命中这一段', hit.matches.length === 1, `match_count=${hit.match_count}`)
const m = hit.matches[0]
const width = (m.end_us - m.start_us) / 1e6
record('返回的区间被收窄到句子级，而不是整段 100 秒',
  width < 40,
  `返回 ${(m.start_us / 1e6).toFixed(1)}s–${(m.end_us / 1e6).toFixed(1)}s（宽 ${width.toFixed(1)}s，原段 100s）`)
record('收窄后的区间仍包含目标句所在的位置（按字数比例的第三句）',
  m.start_us > 30_000_000 && m.end_us < 80_000_000,
  `${(m.start_us / 1e6).toFixed(1)}s–${(m.end_us / 1e6).toFixed(1)}s`)

console.log('\n=== 定位不到时必须退回整段，而不是猜一个区间 ===')
const miss = await vw.findSpans('ps', 'as1', { text: '这句话根本不在转述里' })
record('查不到时不返回任何区间', miss.matches.length === 0, `match_count=${miss.match_count}`)

const whole = await vw.findSpans('ps', 'as1', { min_seconds: 1 })
record('没有给出文字条件时不做收窄，区间保持整段',
  whole.matches.length === 1 && (whole.matches[0].end_us - whole.matches[0].start_us) === 100_000_000,
  `宽 ${((whole.matches[0].end_us - whole.matches[0].start_us) / 1e6).toFixed(0)}s`)

console.log('\n=== 收窄结果必须是可用的区间 ===')
const ordered = hit.matches.every(x => x.start_us < x.end_us && x.start_us >= 0 && x.end_us <= 100_000_000)
record('区间非空且落在素材范围内', ordered,
  hit.matches.map(x => `${(x.start_us / 1e6).toFixed(1)}-${(x.end_us / 1e6).toFixed(1)}s`).join(', '))
record('收窄后仍然带回证据引用（能解释为什么选中）',
  Array.isArray(m.evidence_refs) && m.evidence_refs.length > 0,
  `evidence_refs ${m.evidence_refs?.length ?? 0} 条`)

vw.dispose()

console.log('\n' + '='.repeat(64))
console.log(`共 ${passed + failed} 项，问题 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
