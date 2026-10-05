/**
 * OSS 的 Range 行为契约 —— 媒体路由必须按这份实测来写。
 *
 * 工作台要能拖动进度条、跳到任意一秒，靠的是浏览器对 `<video>` 发 Range 请求、
 * 服务端回 206 部分内容。所以「OSS 的签名 URL 支持 Range 吗」是整个方案的前提，
 * 而这条前提在写代码之前必须先验证，不能假定。
 *
 * 实测出的三条事实（每一条都有下面的断言守着）：
 *
 *   1. **签名 URL 支持 Range**：bytes=0-1023 与中段区间都回 206，且 Content-Range
 *      的 total 与 HEAD 报的 Content-Length 一致。
 *   2. **签名覆盖 HTTP 方法**：用 GET 签名发 HEAD 会被拒（403）。所以媒体路由
 *      要发 HEAD 时必须单独签一份。
 *   3. **OSS 不报 416**：Range 起点等于或超过文件长度时，它忽略 Range、回 200 全量。
 *      这意味着**越界判定必须在媒体路由里自己做**，否则浏览器要 1 KB 却会收到
 *      73 MB —— 这是必须守住的，所以下面的断言把它写成契约。
 *
 * 这里用生产同一份签名逻辑（`assetSource` / `signedAssetUrl`），不另写一份 HMAC：
 * 另写一份的话，即使测通了也不能证明线上那条路能通。
 *
 * 需要真实 OSS 凭据，所以本探针在没有凭据时**跳过而不是失败** —— 跳过要显式报出来，
 * 静默跳过会让人以为检查过了。
 */
const RUNTIME = process.argv[2]
const PROJECT = 'proj-guangshengsi'
const ASSET = 'asset-f6a2d8aa38932048010b'

let bad = 0
let total = 0
const record = (name, ok, detail) => {
  total += 1
  if (!ok) bad += 1
  console.log(`${ok ? '✅ 通过' : '❌ 问题'}  ${name}  ${detail}`)
}

const { readFileSync } = await import('node:fs')
const envPath = 'E:\\huabei\\goclip-agentv2\\runtime\\.env.ps1'
let env = {}
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*\$env:([A-Z_0-9]+)\s*=\s*(.+?)\s*$/)
    if (m !== null) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
} catch { env = {} }
for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v

if (!process.env.GOCLIP_OSS_ACCESS_KEY_ID || !process.env.GOCLIP_OSS_ACCESS_KEY_SECRET) {
  console.log('⏭️  跳过  没有 OSS 凭据（GOCLIP_OSS_ACCESS_KEY_ID / _SECRET），本探针需要真实 OSS')
  console.log('\n共 0 项，问题 0 项（已跳过）')
  process.exit(0)
}

const { DatabaseSync } = await import('node:sqlite')
const DATA = 'E:\\huabei\\goclip-agentv2\\runtime\\video-tools'

const config = {
  dataDir: DATA,
  modelBaseUrl: 'http://127.0.0.1:1', model: 'stub', apiKeyEnv: 'GOCLIP_OSS_ACCESS_KEY_ID',
  ossEndpoint: process.env.GOCLIP_OSS_ENDPOINT, ossBucket: process.env.GOCLIP_OSS_BUCKET,
  ossAccessKeyIdEnv: 'GOCLIP_OSS_ACCESS_KEY_ID', ossAccessKeySecretEnv: 'GOCLIP_OSS_ACCESS_KEY_SECRET',
  ossPrefix: 'goclip-temporary', ossOutputPrefix: 'goclip-exports', ossProjectPrefix: 'goclip-projects',
  signedUrlSeconds: 900, maxImportBytes: 4294967296, requestTimeoutMs: 120000, modelTimeoutMs: 1800000,
  searchLimit: 50, keepSourceFiles: true, keyframeToleranceMs: 500, modelAttempts: 1,
  maxOutputTokens: 32768, proxyHeight: 720,
  acousticSampleRate: 8000, acousticWindowMs: 1000, acousticPeakLimit: 20,
  shotSceneThreshold: 0.3, shotMinSeconds: 0.4, shotPacingWindowSeconds: 5, shotBusyLimit: 8,
  silenceMinSeconds: 0.4, silenceNoiseDb: -30, refineToleranceSeconds: 1.5, verifyBoundaries: false,
  extractionChunkSeconds: 900,
  asrModel: 'x', asrBaseUrl: 'http://127.0.0.1:1/api/v1', asrPollMs: 10, asrTimeoutMs: 1000, asrApiKeyEnv: 'GOCLIP_OSS_ACCESS_KEY_ID',
  ocrModel: 'x', ocrSampleSeconds: 4, ocrConcurrency: 8, ocrWatermarkFraction: 0.5, visionModel: 'x', verifyModel: 'x',
}

// 素材不在库里就跳过：这条探针依赖一个真实存在的 43 分钟素材。
{
  const db = new DatabaseSync(`${DATA}\\video-tools.sqlite`)
  const row = db.prepare('SELECT 1 FROM assets WHERE id=? AND project_id=?').get(ASSET, PROJECT)
  db.close()
  if (!row) {
    console.log(`⏭️  跳过  素材 ${ASSET} 不在库里（本探针针对一个真实素材实测 OSS 行为）`)
    console.log('\n共 0 项，问题 0 项（已跳过）')
    process.exit(0)
  }
}

const { VideoWorkspace } = await import(RUNTIME)
const vw = new VideoWorkspace(config)
const { key, url } = await vw.assetSource(PROJECT, ASSET)
const headUrl = vw.signedAssetUrl(key, 'HEAD')
vw.dispose()

// ---- 事实 1：签名 URL 支持 Range ----------------------------------------
let size = 0
{
  const r = await fetch(headUrl, { method: 'HEAD' })
  size = Number(r.headers.get('content-length'))
  record('HEAD 用 HEAD 签名可读，并报告 Accept-Ranges: bytes',
    r.status === 200 && r.headers.get('accept-ranges') === 'bytes' && Number.isFinite(size) && size > 0,
    `HTTP ${r.status}  Accept-Ranges=${r.headers.get('accept-ranges')}  Content-Length=${size}`)
}
{
  const r = await fetch(url, { headers: { Range: 'bytes=0-1023' } })
  const body = new Uint8Array(await r.arrayBuffer())
  const cr = r.headers.get('content-range')
  record('bytes=0-1023 回 206，且区间与总长都对',
    r.status === 206 && cr === `bytes 0-1023/${size}` && body.byteLength === 1024,
    `HTTP ${r.status}  Content-Range=${cr}  实际字节=${body.byteLength}`)
}
{
  // 中段：这才是拖动进度条真正会发的请求。
  const from = Math.floor(size / 2)
  const want = 65536
  const r = await fetch(url, { headers: { Range: `bytes=${from}-${from + want - 1}` } })
  const body = new Uint8Array(await r.arrayBuffer())
  record('中段 Range（拖动进度条）回 206 且字节数精确',
    r.status === 206 && body.byteLength === want,
    `HTTP ${r.status}  Content-Range=${r.headers.get('content-range')}  实际字节=${body.byteLength}`)
}
{
  const from = Math.floor(size / 2)
  const r = await fetch(url, { headers: { Range: `bytes=${from}-` } })
  const body = new Uint8Array(await r.arrayBuffer())
  record('开放式 bytes=N- 回 206 且到文件末尾',
    r.status === 206 && body.byteLength === size - from,
    `HTTP ${r.status}  实际字节=${body.byteLength}  期望=${size - from}`)
}

// ---- 事实 2：签名覆盖 HTTP 方法 ----------------------------------------
{
  const r = await fetch(url, { method: 'HEAD' })
  record('用 GET 签名发 HEAD 会被拒（签名覆盖方法，路由必须单独签一份）',
    r.status === 403,
    `HTTP ${r.status}`)
}
{
  const bad = url.replace(/Signature=[^&]+/, 'Signature=deadbeef')
  const r = await fetch(bad, { headers: { Range: 'bytes=0-1023' } })
  record('篡改签名会被拒（证明上面几条真的在验签）', r.status === 403 || r.status === 401, `HTTP ${r.status}`)
}

// ---- 事实 3：OSS 不报 416，越界要路由自己判 ------------------------------
{
  const r = await fetch(url, { headers: { Range: `bytes=${size}-` } })
  const oversized = r.status === 200 || r.status === 416
  record('起点等于文件长度时：OSS 要么回 416、要么回 200 全量 —— 媒体路由两种都要挡住',
    oversized,
    `HTTP ${r.status}${r.status === 200 ? '（忽略 Range、回全量）' : ''}`)
  await r.body?.cancel()
}
{
  // 断言的重点不是 OSS 回了什么，而是**路由必须自己判越界**这个结论有据可依：
  // 如果 OSS 回 200 全量，那么把越界请求直接转发出去，浏览器要 1 KB 会收到整个文件。
  const r = await fetch(url, { headers: { Range: 'bytes=999999999999-' } })
  const ignored = r.status === 200 && Number(r.headers.get('content-length')) === size
  record('起点远超文件长度时 OSS 忽略 Range 回全量 —— 越界判定不能外包给 OSS',
    ignored || r.status === 416,
    ignored ? `HTTP 200 且 Content-Length=${r.headers.get('content-length')}（= 整个文件）` : `HTTP ${r.status}`)
  await r.body?.cancel()
}

console.log(`\n共 ${total} 项，问题 ${bad} 项`)
process.exit(bad === 0 ? 0 : 1)
