/**
 * Run the live import → ASR → search → edit → render path against isolated OSS prefixes.
 *
 * Usage: source runtime/.env && node scripts/tools/verify/e2e-live.mjs /path/to/video.mp4
 * This calls the configured ASR and OSS services and leaves remote objects under the
 * printed `goclip-e2e/<id>/` prefix for manual cleanup. The input file is never modified.
 */
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const { VideoWorkspace } = await import(pathToFileURL(resolve(root, 'platform/dsh/packages/video/video-workspace/lib/types/runtime.js')).href)

const required = [
  'AUTOCLIP_TEXT_BASE_URL', 'AUTOCLIP_TEXT_MODEL', 'AUTOCLIP_TEXT_API_KEY',
  'GOCLIP_OSS_ENDPOINT', 'GOCLIP_OSS_BUCKET', 'GOCLIP_OSS_ACCESS_KEY_ID', 'GOCLIP_OSS_ACCESS_KEY_SECRET',
]
for (const key of required) if (!process.env[key]) throw new Error(`missing required environment variable: ${key}`)

const input = process.argv[2]
if (!input) throw new Error('usage: node e2e-live.mjs /path/to/video.mp4')
const tempDir = await mkdtemp(join(tmpdir(), 'goclip-live-e2e-'))
const source = join(tempDir, 'source.mp4')
await copyFile(input, source)
const id = `e2e-${Date.now()}`
const prefix = `goclip-e2e/${id}`
const signal = AbortSignal.timeout(30 * 60 * 1000)
const workspace = new VideoWorkspace({
  dataDir: join(tempDir, 'data'),
  modelBaseUrl: process.env.AUTOCLIP_TEXT_BASE_URL,
  model: process.env.AUTOCLIP_TEXT_MODEL,
  apiKeyEnv: 'AUTOCLIP_TEXT_API_KEY',
  ossEndpoint: process.env.GOCLIP_OSS_ENDPOINT,
  ossBucket: process.env.GOCLIP_OSS_BUCKET,
  ossAccessKeyIdEnv: 'GOCLIP_OSS_ACCESS_KEY_ID',
  ossAccessKeySecretEnv: 'GOCLIP_OSS_ACCESS_KEY_SECRET',
  ossPrefix: `${prefix}/temp`,
  ossOutputPrefix: `${prefix}/exports`,
  ossProjectPrefix: `${prefix}/projects`,
  signedUrlSeconds: 900,
  maxImportBytes: 4 * 1024 ** 3,
  requestTimeoutMs: 120_000,
  ossAttempts: 3,
  ossRetryBaseMs: 1000,
  modelTimeoutMs: 30 * 60 * 1000,
  searchLimit: 50,
  keepSourceFiles: true,
  keyframeToleranceMs: 500,
  maxOutputSeconds: 300,
  maxOutputBytes: 150 * 1024 * 1024,
  maxOutputTokens: 32_768,
  reasoningEffort: 'medium',
  asrModel: 'qwen-audio-3.1-asr-flash-filetrans',
  asrBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  asrPollMs: 4000,
  asrTimeoutMs: 600_000,
  asrApiKeyEnv: 'AUTOCLIP_TEXT_API_KEY',
  modelAttempts: 3,
})

try {
  await workspace.createProject(id, 'E2E 临时项目')
  console.log(`project: ${id}`)
  console.log(`remote prefix: ${prefix}/`)

  const bytes = (await stat(source)).size
  const asset = await workspace.import(id, source)
  console.log(`import: PASS (${(asset.duration_us / 1e6).toFixed(2)}s, ${bytes} bytes)`)

  const transcript = await workspace.transcriptEvidence(id, asset.id, signal)
  const lines = transcript.lines ?? []
  console.log(`ASR: ${transcript.status ?? 'completed'} (${lines.length} timed lines)`)
  if (lines.length === 0) throw new Error(`ASR produced no lines: ${transcript.note ?? 'no detail'}`)

  const first = lines.find(line => Number.isFinite(line.start_us)
    && Number.isFinite(line.end_us)
    && line.end_us > line.start_us
    && String(line.text ?? '').trim())
  if (!first) throw new Error('ASR did not produce a usable timed line')
  const search = await workspace.findSpans(id, asset.id, { text: String(first.text), limit: 5 })
  console.log(`search: ${search.match_count > 0 ? 'PASS' : 'FAIL'} (${search.match_count} matches)`)
  if (search.match_count === 0) throw new Error('ASR phrase was not searchable')

  const startUs = Math.max(0, first.start_us - 1_000_000)
  const endUs = Math.min(asset.duration_us, Math.max(first.end_us + 1_000_000, startUs + 5_000_000))
  const timelineId = `tl-${id}`
  await workspace.createTimeline({
    id: timelineId,
    name: 'E2E 演示片段',
    project_id: id,
    asset_id: asset.id,
    start_us: startUs,
    end_us: endUs,
  })
  console.log(`timeline: PASS (${(startUs / 1e6).toFixed(2)}–${(endUs / 1e6).toFixed(2)}s)`)

  const render = await workspace.render(timelineId, 'e2e-demo.mp4', signal)
  console.log(`render: ${render.status} (${render.duration_seconds}s)`)
  if (render.status !== 'completed') throw new Error('render did not complete')
  const result = await workspace.validateRender(render.id, signal)
  console.log(`validation: ${result.within_limits && result.has_video_stream ? 'PASS' : 'FAIL'} (${result.actual_seconds}s, ${result.width}x${result.height}, ${result.bytes ?? 'unknown'} bytes)`)
  if (!result.within_limits || result.has_video_stream !== true) throw new Error('render validation failed')
  console.log(`output: ${render.output}`)
} finally {
  await workspace.dispose()
  await rm(tempDir, { recursive: true, force: true })
}
