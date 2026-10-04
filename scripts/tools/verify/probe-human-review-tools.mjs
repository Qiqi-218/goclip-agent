/**
 * The human-review tools must not read as model-readable.
 *
 * A real session called `video_evidence_clip` 25 times (70 s) while preparing material
 * that the model cannot perceive: every one of the 74 tool results in that session was a
 * text block, with no image or video part. The calls were not useless to the user — the
 * signed links are for a person to open — but each one consumed the agent's own budget,
 * and the tool's wording invited exactly that misreading.
 *
 * DSH itself can carry image blocks (`read_image` returns one); this plugin's render
 * produces text only, so the blindness is a property of these tools and has to be stated
 * where the model reads it: in the tool description and in the returned fields.
 *
 * Both directions are asserted. Silence about the limitation is the bug; forbidding the
 * call would be a different bug, because producing a link for the user is the tool's job.
 */
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const RUNTIME = process.argv[2]
if (RUNTIME === undefined) {
  console.error('用法：node probe-human-review-tools.mjs <runtime.js 的 file URL>')
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

const dir = await mkdtemp(join(tmpdir(), 'goclip-review-'))
const clip = join(dir, 'review-source.mp4')
await run('ffmpeg', ['-nostdin', '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=20,format=yuv420p',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=20',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip],
{ maxBuffer: 64 * 1024 * 1024 })

const served = new Map()
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/index.json')) return new Response(JSON.stringify({ version: 5, projects: [] }), { status: 200 })
  if (init?.method === 'PUT') {
    const key = decodeURIComponent(target.split('?')[0].split('/').slice(3).join('/'))
    served.set(key, 'stub')
    return new Response('', { status: 200 })
  }
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
  // 上限设成 5 秒：素材本身只有 20 秒，用默认的 60 秒上限永远触发不到截断分支，
  // 那条断言就会变成"测了个不会发生的情况"。要测截断就得让它真的发生。
  excerptMaxSeconds: 5,
}
process.env.STUB_ID = 'x'
process.env.STUB_SECRET = 'y'

const { VideoWorkspace } = await import(RUNTIME)
const { DatabaseSync } = await import('node:sqlite')

const vw = new VideoWorkspace(config)
await vw.createProject('pr', '供人核对')
{
  const db = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  db.exec('PRAGMA foreign_keys=ON')
  db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('ar', 'pr', clip, JSON.stringify({ duration_us: 20_000_000 }))
  db.close()
}

const clipResult = await vw.evidenceClip({ project_id: 'pr', asset_id: 'ar', start_us: 2_000_000, end_us: 6_000_000, filename: 'check.mp4' })

console.log('=== 返回值必须自陈「模型读不到」===')
record('返回值标明该产物只供人核对',
  clipResult.for_human_review === true,
  `for_human_review=${String(clipResult.for_human_review)}`)
record('返回值标明模型无法读取其内容',
  clipResult.readable_by_model === false,
  `readable_by_model=${String(clipResult.readable_by_model)}`)
record('note 里直接说明「看不到也听不到」，而不是留给模型自己推断',
  typeof clipResult.note === 'string'
  && clipResult.note.includes('看不到')
  && clipResult.note.includes('不要为了'),
  String(clipResult.note).slice(0, 76) + '…')

console.log('\n=== 但这个工具仍然要能用：给用户准备材料是它的职责 ===')
record('片段仍然真的被切出来并上传',
  typeof clipResult.oss_url === 'string' && clipResult.oss_url.startsWith('http')
  && clipResult.seconds === 4 && clipResult.bytes > 0,
  `${clipResult.seconds}s / ${clipResult.kilobytes} KB`)
record('片段区间与请求一致', clipResult.start_us === 2_000_000 && clipResult.end_us === 6_000_000,
  `${clipResult.start_us / 1e6}s–${clipResult.end_us / 1e6}s`)
record('上传确实发生了（不是只造了个链接）',
  served.size > 0 && String(clipResult.oss_key).startsWith('o/'),
  `对象存储里 ${served.size} 个对象，key=${clipResult.oss_key.slice(0, 40)}`)

console.log('\n=== 截断时的说明同样要保留「给人看」的定性 ===')
const long = await vw.evidenceClip({ project_id: 'pr', asset_id: 'ar', start_us: 0, end_us: 20_000_000, filename: 'long.mp4' })
record('超过上限时仍被截断并说明',
  long.clamped_to_max_seconds !== null,
  `clamped=${long.clamped_to_max_seconds}s`)
record('截断说明里也没有丢失「链接是给用户的」这一定性',
  typeof long.note === 'string' && long.note.includes('用户'),
  String(long.note).slice(0, 70) + '…')

vw.dispose()

console.log('\n' + '='.repeat(64))
console.log(`共 ${passed + failed} 项，问题 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
