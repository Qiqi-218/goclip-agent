/**
 * 只读媒体路由：行为与安全属性。
 *
 * 工作台把素材放进 `<video>`，靠 Range 请求拖动进度条。这条路由是浏览器与 OSS 之间的
 * 唯一通道，所以它要守住两类东西：
 *
 *   1. **协议正确**：206 的 `Content-Range` 与实际字节数必须一致；越界要 416；
 *      非 GET/HEAD 要 405；未知地址要 404。
 *   2. **越界判定不能外包给 OSS** —— 实测 OSS 对不可满足的 Range 会忽略它、回 200 全量。
 *      如果路由把越界请求原样转发，浏览器要 1 KB 会收到整个 73 MB。这条用一个
 *      「上游被判越界时根本不该被调用」的断言来守：桩件记录调用次数，越界时必须为 0。
 *
 * 另外用真实 HTTP 服务器驱动，而不是直接调 handler —— 只有经过 `node:http` 才能验证
 * `Content-Length`、分块传输与流式回写真的按预期工作。
 */
import { createServer } from 'node:http'

const RUNTIME = process.argv[2]
const MEDIA = RUNTIME.replace(/runtime\.js$/, 'media-route.js')

let bad = 0
let total = 0
const record = (name, ok, detail) => {
  total += 1
  if (!ok) bad += 1
  console.log(`${ok ? '✅ 通过' : '❌ 问题'}  ${name}  ${detail}`)
}

const { mediaRoute, parseRangeHeader } = await import(MEDIA)

// ---- 一、Range 解析（纯函数，不涉网络）-----------------------------------
{
  const size = 1000
  const ok = (header, from, to) => {
    const r = parseRangeHeader(header, size)
    return r.kind === 'ok' && r.from === from && r.to === to
  }
  record('bytes=0-99 解析为 0-99', ok('bytes=0-99', 0, 99), JSON.stringify(parseRangeHeader('bytes=0-99', size)))
  record('bytes=100- 解析到末尾', ok('bytes=100-', 100, 999), JSON.stringify(parseRangeHeader('bytes=100-', size)))
  record('末尾超出会被夹到 size-1（浏览器不知道长度时依赖这个）', ok('bytes=900-99999', 900, 999), JSON.stringify(parseRangeHeader('bytes=900-99999', size)))
  record('后缀式 bytes=-100 从末尾倒数', ok('bytes=-100', 900, 999), JSON.stringify(parseRangeHeader('bytes=-100', size)))
  record('无 Range 头 → none', parseRangeHeader(undefined, size).kind === 'none', JSON.stringify(parseRangeHeader(undefined, size)))
  record('空 Range 头 → none', parseRangeHeader('   ', size).kind === 'none', 'blank')
  record('非 bytes 单位 → none（不猜语义）', parseRangeHeader('items=0-9', size).kind === 'none', 'items=')
  record('多区间 → none（回全量，RFC 允许）', parseRangeHeader('bytes=0-9,20-29', size).kind === 'none', 'multi')
  record('起点等于长度 → 不可满足', parseRangeHeader('bytes=1000-', size).kind === 'unsatisfiable', 'bytes=1000-')
  record('起点超过长度 → 不可满足', parseRangeHeader('bytes=5000-', size).kind === 'unsatisfiable', 'bytes=5000-')
  record('起点大于终点 → 不可满足', parseRangeHeader('bytes=500-100', size).kind === 'unsatisfiable', 'bytes=500-100')
  record('空对象上的后缀式 → 不可满足', parseRangeHeader('bytes=-10', 0).kind === 'unsatisfiable', 'size=0')
}

// ---- 二、整机行为：真实 HTTP 服务器 + 桩件上游 ----------------------------
const SIZE = 1024 * 1024
const upstreamCalls = []
let upstreamFails = false
const blob = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i += 1) blob[i] = i % 251

const upstream = createServer((req, res) => {
  upstreamCalls.push({ method: req.method, range: req.headers.range ?? null, url: req.url })
  if (upstreamFails) { res.writeHead(403); res.end(); return }
  const range = req.headers.range
  const m = range === undefined ? null : /^bytes=(\d+)-(\d+)$/.exec(range)
  if (m === null) {
    res.writeHead(200, { 'Content-Length': String(SIZE), 'Content-Type': 'video/mp4' })
    if (req.method === 'HEAD') { res.end(); return }
    res.end(blob)
    return
  }
  const from = Number(m[1]); const to = Number(m[2])
  const slice = blob.subarray(from, to + 1)
  res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${SIZE}`, 'Content-Length': String(slice.length), 'Content-Type': 'video/mp4' })
  if (req.method === 'HEAD') { res.end(); return }
  res.end(slice)
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

const source = {
  resolve: async (path) => {
    if (path.length === 0) return null
    if (path[0] === 'gone') return null
    if (path[0] === 'boom') return { key: 'goclip-projects/p/a/source.mp4', contentType: 'video/mp4' }
    // 与真实实现同样的严格度：素材地址是 `project/asset`，或
    // `project/asset/render/job`。其他形状一概不认。
    // 早先这里对任何路径都回一个目标，于是 `/data/…` 之类的地址也被当成素材、
    // 以 200 回一份字节流 —— 那条「穿越型路径」断言就是靠这个才显示通过的。
    if (path.length === 2) return { key: 'goclip-projects/proj/asset/source.mp4', contentType: 'video/mp4' }
    if (path.length === 4 && path[2] === 'render') return { key: 'goclip-exports/proj/job.mp4', contentType: 'video/mp4' }
    return null
  },
  sign: (key, method) => `http://127.0.0.1:${upstreamPort}/${method}/${key}`,
  // 只读的 JSON 面：未测量回 null（路由要翻成 404），读到就回数据。
  loudness: async (path) => {
    // 触发「读取失败」的哨兵要放在长度检查之前。
    // 真实实现要求 project 与 asset 都在，而哨兵只占一段，所以放到后面就永远
    // 走不到 —— 那条 502 断言会一直以 404 通过，看上去像绿的。
    if (path[0] === 'broken') throw new Error('reader failed')
    // 与真实实现同样的严格度：没有 project 与 asset 就查不到记录。
    // 桩件若对任何路径都回数据，路由「裸 data 段要 404」这条就测不出来了。
    if (path[0] === undefined || path[1] === undefined) return null
    if (path[0] === 'nope') return null
    // 与真实实现对应：查不到素材就没有可画的东西。
    if (path[0] === 'gone') return null
    return { duration_us: 60_000_000, samples: [{ at: 0, db: -30 }, { at: 1, db: -10 }], floor_dbfs: -30, peak_dbfs: -10, loud_dbfs: -20, audio_end_at: 1 }
  },
  // 时间线与成片：同样按「查不到就没东西」处理，且各自能被单独触发。
  timelines: async (path) => {
    if (path[0] === undefined || path[1] === undefined) return null
    if (path[0] === 'nope') return null
    return { duration_us: 60_000_000, timelines: [{ id: 'tl-1', name: 'test', revision: 1, clips: [{ ordinal: 0, start_us: 0, end_us: 5_000_000, start: 0, end: 0.0833, speed: 1, muted: false }], output_seconds: 5 }] }
  },
  renders: async (path) => {
    if (path[0] === undefined || path[1] === undefined) return null
    if (path[0] === 'nope') return null
    return { renders: [{ job_id: 'job-1', status: 'done', timeline_id: 'tl-1', timeline_name: 'test', url: '/goclip-media/proj/asset/render/job-1' }] }
  },
}

const route = mediaRoute(source, '/goclip-media')
// 所有请求都交给路由自己判前缀。
//
// 这里曾经先判一次 startsWith('/goclip-media')，不匹配就直接 404 ——
// 那是加入 `data/` 那条只读面之前写的。于是 /data/… 全被这里挡掉，
// 而当时几条断言恰好都期望 404，所以看上去是绿的：
// 桩件对未知路径返回 null 也是 404，两种原因得到同一个状态码。
// 探针自己先答一次，就把「路由怎么答」这件事测没了。
const app = createServer((req, res) => route.handler(req, res))
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${app.address().port}/goclip-media`

const get = (path, headers = {}, method = 'GET') => fetch(`${base}${path}`, { headers, method })

// 2.1 无 Range → 200 全量
{
  const r = await get('/proj/asset')
  const body = Buffer.from(await r.arrayBuffer())
  record('无 Range → 200，且 Content-Length 与实际字节一致',
    r.status === 200 && Number(r.headers.get('content-length')) === SIZE && body.length === SIZE,
    `HTTP ${r.status}  Content-Length=${r.headers.get('content-length')}  实际=${body.length}  Accept-Ranges=${r.headers.get('accept-ranges')}`)
}

// 2.2 Range → 206，三者一致（状态码、Content-Range、实际字节）
{
  const r = await get('/proj/asset', { Range: 'bytes=0-1023' })
  const body = Buffer.from(await r.arrayBuffer())
  const cr = r.headers.get('content-range')
  record('bytes=0-1023 → 206，Content-Range 与实际字节一致',
    r.status === 206 && cr === `bytes 0-1023/${SIZE}` && body.length === 1024 && Number(r.headers.get('content-length')) === 1024,
    `HTTP ${r.status}  Content-Range=${cr}  实际=${body.length}`)
}

// 2.3 中段 Range：内容真的对得上（不只是长度对）
{
  const from = 4096
  const r = await get('/proj/asset', { Range: `bytes=${from}-${from + 255}` })
  const body = Buffer.from(await r.arrayBuffer())
  const expected = blob.subarray(from, from + 256)
  record('中段 Range 返回的字节内容正确（逐字节比对）',
    r.status === 206 && body.equals(expected),
    `HTTP ${r.status}  比对 ${body.length} 字节  相等=${body.equals(expected)}`)
}

// 2.4 HEAD → 206 带头部、无正文（且上游必须收到 HEAD 而不是 GET）
{
  upstreamCalls.length = 0
  const r = await get('/proj/asset', { Range: 'bytes=0-1023' }, 'HEAD')
  const body = Buffer.from(await r.arrayBuffer())
  const upstreamMethods = upstreamCalls.map(c => c.method)
  record('HEAD + Range → 206 带 Content-Range，正文为空',
    r.status === 206 && body.length === 0 && r.headers.get('content-range') === `bytes 0-1023/${SIZE}`,
    `HTTP ${r.status}  正文=${body.length}  Content-Range=${r.headers.get('content-range')}`)
  record('HEAD 向上游发的是 HEAD 与 HEAD 签名（签名覆盖方法，GET 签名会被拒）',
    upstreamMethods.includes('HEAD') && upstreamCalls.every(c => c.method === 'HEAD') && upstreamCalls.every(c => c.url.startsWith('/HEAD/')),
    `上游方法 ${JSON.stringify(upstreamMethods)}  URL ${upstreamCalls.map(c => c.url.split('/')[1]).join(',')}`)
}

// 2.5 越界 → 416，且**没有向上游取正文**
//
// 断言要数的是 GET 而不是总调用次数：判断越界必须先知道对象长度，所以一次 HEAD 是
// 必须的、也是这条路由做对事情的证据。真正要守的是**没有 GET** —— 那一步才会把整个
// 文件下发给一个只要 1 KB 的调用方。
{
  upstreamCalls.length = 0
  const r = await get('/proj/asset', { Range: `bytes=${SIZE}-` })
  await r.arrayBuffer()
  const gets = upstreamCalls.filter(c => c.method === 'GET')
  const heads = upstreamCalls.filter(c => c.method === 'HEAD')
  record('起点等于长度的 Range → 416，Content-Range 为 bytes */size',
    r.status === 416 && r.headers.get('content-range') === `bytes */${SIZE}`,
    `HTTP ${r.status}  Content-Range=${r.headers.get('content-range')}`)
  record('越界时一次 GET 都没有 —— 越界判定没有外包给 OSS（否则浏览器要 1KB 会收到整个文件）',
    gets.length === 0 && heads.length > 0,
    `HEAD ${heads.length} 次（取长度，必须）  GET ${gets.length} 次（必须为 0）`)
}
{
  upstreamCalls.length = 0
  const r = await get('/proj/asset', { Range: 'bytes=999999999999-' })
  await r.arrayBuffer()
  const gets = upstreamCalls.filter(c => c.method === 'GET')
  record('起点远超长度 → 416，且同样一次 GET 都没有',
    r.status === 416 && gets.length === 0,
    `HTTP ${r.status}  GET ${gets.length} 次`)
}

// 2.6 未知地址 → 404
{
  const r = await get('/gone/asset')
  await r.arrayBuffer()
  record('解析不出的地址 → 404', r.status === 404, `HTTP ${r.status}`)
}
{
  const r = await get('/')
  await r.arrayBuffer()
  record('裸前缀（没有项目与素材）→ 404', r.status === 404, `HTTP ${r.status}`)
}
{
  // 这条地址在**路由这一层测不出穿越**，值得写清楚为什么，免得下一个人以为漏测了：
  //
  //   · 裸 `../..` 到不了路由：Node 的 HTTP 层先做点段归一化，请求抵达时已是一条
  //     干净的 `project/asset`，长度合法，于是正常返回 200。
  //   · 百分号编码的 `%2f` 同样测不出：实测 `resolve` 从未被这条请求调用，
  //     具体在哪一层被折叠没有查明。
  //
  // 守住这件事的地方是 `resolveMedia`：它按**形状**白名单化（两段，或四段且第三段
  // 是 render），对象 key 只从数据库行推导，从不接受调用方传入。服务端也从不碰
  // 文件系统，所以这里本就没有「读到本地文件」那类风险可测。
  // 因此这条只断言「非素材形状的地址拿不到字节流」，不再声称它测的是穿越。
  const r = await get('/proj/asset/render')
  await r.arrayBuffer()
  record('形状不完整的三段地址回 404（素材只认两段，或 render 四段）',
    r.status === 404, `HTTP ${r.status}`)
}

// 2.7 非 GET/HEAD → 405
{
  const r = await get('/proj/asset', {}, 'POST')
  await r.arrayBuffer()
  record('POST → 405 且带 Allow 头', r.status === 405 && (r.headers.get('allow') ?? '').includes('GET'),
    `HTTP ${r.status}  Allow=${r.headers.get('allow')}`)
}

// 2.8 上游失败 → 502，而不是把失败当成功
{
  upstreamFails = true
  const r = await get('/boom/asset', { Range: 'bytes=0-1023' })
  await r.arrayBuffer()
  upstreamFails = false
  record('上游 HEAD 失败 → 502（不把失败当空内容）', r.status === 502, `HTTP ${r.status}`)
}

// 2.9 客户端中途断开 → 上游被取消
{
  // 直接对 socket 发请求再立刻销毁，模拟用户关掉标签页。
  const { connect } = await import('node:net')
  const port = app.address().port
  let aborted = 0
  const before = upstreamCalls.length
  await new Promise(resolve => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET /goclip-media/proj/asset HTTP/1.1\r\nHost: x\r\nRange: bytes=0-${SIZE - 1}\r\n\r\n`)
      // 收到一点就断，模拟中途关闭。
      socket.once('data', () => { socket.destroy(); aborted += 1; resolve() })
    })
    socket.on('error', () => resolve())
    setTimeout(() => { socket.destroy(); resolve() }, 3000)
  })
  await new Promise(r => setTimeout(r, 300))
  record('客户端中途断开时上游连接被取消（否则 OSS 连接会一直读到文件结束）',
    aborted === 1 && upstreamCalls.length > before,
    `断开 ${aborted} 次  上游累计调用 ${upstreamCalls.length} 次`)
}

// 2.10 只读的 JSON 面：工作台靠它取测量结果
{
  const r = await fetch(`${base}/data/proj/asset/loudness`)
  const body = await r.json()
  record('测量结果以 JSON 返回，且 Content-Type 正确',
    r.status === 200 && (r.headers.get('content-type') ?? '').includes('application/json') && Array.isArray(body.samples) && body.samples.length === 2,
    `HTTP ${r.status}  Content-Type=${r.headers.get('content-type')}  samples=${body.samples?.length}`)
}
{
  // 未测量与「测量了但没有内容」是两件事，必须能分辨。
  const r = await fetch(`${base}/data/nope/loudness`)
  await r.text()
  record('未测量的维度回 404（而不是空曲线）', r.status === 404, `HTTP ${r.status}`)
}
{
  // 素材不存在同样是 404：界面要能把它和「读取出错」分开。
  // 这条曾经是 502，因为运行时抛错被一律当成上游故障。
  const r = await fetch(`${base}/data/gone/loudness`)
  await r.text()
  record('素材不存在回 404（不是 502 —— 那会让界面显示错误的提示）', r.status === 404, `HTTP ${r.status}`)
}
{
  const r = await fetch(`${base}/data/broken/loudness`)
  await r.text()
  record('读取失败回 502（不把故障当成没有数据）', r.status === 502, `HTTP ${r.status}`)
}
{
  // 用 get 助手而不是裸 fetch：method 是 fetch 第二个参数的字段，
  // 写成第三个参数会被忽略，请求实际仍是 GET —— 那样这条断言测不到任何东西。
  const r = await get('/data/proj/asset/loudness', {}, 'POST')
  await r.text()
  record('JSON 面同样拒绝非 GET/HEAD', r.status === 405, `HTTP ${r.status}`)
}
{
  // data 段是保留的：素材 id 若被拼成 data，不能悄悄改变路由语义。
  const r = await get('/data')
  await r.text()
  record('裸 data 段回 404（保留段不会退化成字节流）', r.status === 404, `HTTP ${r.status}`)
}
{
  // JSON 面的数据来自本地库，不该为取一条曲线去连对象存储。
  upstreamCalls.length = 0
  const r = await fetch(`${base}/data/proj/asset/loudness`)
  await r.json()
  const touched = upstreamCalls.length
  record('JSON 面不触碰对象存储（测量结果在库里，不必回源）',
    r.status === 200 && touched === 0,
    `HTTP ${r.status}  上游调用 ${touched} 次`)
}
{
  // 维度是最后一段，所以一条路由回答所有维度；三个读取器各自能被单独触发。
  const r = await fetch(`${base}/data/proj/asset/timelines`)
  const body = await r.json()
  record('时间线维度返回带片段的时间线',
    r.status === 200 && Array.isArray(body.timelines) && body.timelines.length === 1 && body.timelines[0].clips.length === 1,
    `HTTP ${r.status}  timelines=${body.timelines?.length}  clips=${body.timelines?.[0]?.clips?.length}`)
}
{
  const r = await fetch(`${base}/data/proj/asset/renders`)
  const body = await r.json()
  record('成片维度返回可播放地址，且地址指向本路由而不是对象存储',
    r.status === 200 && typeof body.renders?.[0]?.url === 'string'
    && body.renders[0].url.startsWith('/goclip-media/') && !body.renders[0].url.includes('OSSAccessKeyId'),
    `HTTP ${r.status}  url=${body.renders?.[0]?.url}`)
}
{
  // 维度名不认识时不能猜，否则一个拼错的地址会静默拿到别的维度。
  const r = await fetch(`${base}/data/proj/asset/nonsense`)
  await r.text()
  record('不认识的维度名回 404（不猜成别的维度）', r.status === 404, `HTTP ${r.status}`)
}

app.close()
upstream.close()

console.log(`\n共 ${total} 项，问题 ${bad} 项`)
process.exit(bad === 0 ? 0 : 1)
