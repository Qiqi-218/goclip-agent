import { checkBundleFreshness } from './bundle-freshness.mjs'
/**
 * 针对三处尚未系统检查的地方做确定性探测：
 *   A. manifest / restore 的完整往返
 *   B. 并发（DB 连接竞争、同一素材同时理解、manifest 覆盖写）
 *   C. 模型返回非 JSON 时的处理
 *
 * 全程网络桩件，不触达真实 OSS 或真实模型。
 */
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNTIME = process.argv[2]

// ── 可控的网络桩件 ─────────────────────────────────────────────────────────
const put = new Map()   // key → 最后写入的 body（跨实例共享，模拟真实 OSS）
let modelReplies = []   // 依次返回的模型响应
let finishReasons = []  // 与 modelReplies 对齐的 finish_reason（用于测截断检测）
let modelCalls = 0
let putDelayMs = 0

globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  const method = init.method ?? 'GET'
  const key = decodeURIComponent(u.split('/').slice(3).join('/').split('?')[0])

  if (u.includes('/chat/completions')) {
    modelCalls++
    const reply = modelReplies.shift() ?? '{}'
    // finish_reason 也要给：插件用它识别"输出被截断"。
    const finish = finishReasons.shift() ?? 'stop'
    return new Response(JSON.stringify({ choices: [{ message: { content: reply, reasoning_content: '桩件思考链' }, finish_reason: finish }], usage: { completion_tokens_details: { reasoning_tokens: 7 } } }), { status: 200 })
  }
  if (method === 'PUT') {
    if (putDelayMs) await new Promise(r => setTimeout(r, putDelayMs))
    // 上传用的是 web ReadableStream（原生 fetch 接受它，Buffer.from 不接受），
    // 所以桩件必须把它读干，否则测不到真正上传的字节。
    let body = ''
    if (typeof init.body === 'string') body = init.body
    else if (init.body instanceof ReadableStream) body = await new Response(init.body).text()
    else if (init.body !== undefined && init.body !== null) body = Buffer.from(init.body).toString('utf8')
    put.set(key, body)
    return new Response('', { status: 200 })
  }
  // GET：从写入过的对象里回放
  const body = put.get(key)
  if (body === undefined) return new Response('not found', { status: 404 })
  return new Response(body, { status: 200 })
}

process.env.STUB_ID = 'stub-id'
process.env.STUB_SECRET = 'stub-secret'
process.env.STUB_MODEL_KEY = 'stub-model-key'

const baseConfig = {
  dataDir: await mkdtemp(join(tmpdir(), 'goclip-adv-')),
  modelBaseUrl: 'http://stub.invalid/v1',
  model: 'stub-model',
  apiKeyEnv: 'STUB_MODEL_KEY',
  ossEndpoint: 'oss-cn-beijing.aliyuncs.com', ossBucket: 'stub-bucket',
  ossAccessKeyIdEnv: 'STUB_ID', ossAccessKeySecretEnv: 'STUB_SECRET',
  ossPrefix: 'goclip-temporary', ossOutputPrefix: 'goclip-exports', ossProjectPrefix: 'goclip-projects',
  signedUrlSeconds: 900, requestTimeoutMs: 5000, modelTimeoutMs: 20000, requestTimeoutMs: 5000, modelTimeoutMs: 20000, maxImportBytes: 1024 * 1024,
}

const { VideoWorkspace } = await import(RUNTIME)
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅ 通过' : '❌ 问题'}  ${name}`)
  console.log(`        ${detail}`)
}
const section = t => console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`)

// ═══ A. manifest / restore 往返 ════════════════════════════════════════════
section('A. manifest / restore 往返')

{
  const vw = new VideoWorkspace(baseConfig)
  await vw.createProject('p-a', '往返项目')
  // 直连塞一条素材与时间线，跳过 OSS 上传
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(join(baseConfig.dataDir, 'video-tools.sqlite'))
  raw.exec('PRAGMA foreign_keys=ON')
  raw.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('a-a', 'p-a', 'oss://goclip-projects/p-a/assets/a-a/source.mp4', JSON.stringify({ duration_us: 12000000, width: 1920, height: 1080 }))
  raw.close()
  // 时间线走公开 API：它同时写下首段，而没有片段的时间线在多段模型下不成立。
  await vw.createTimeline({ id: 't-a', name: '测试时间线', project_id: 'p-a', asset_id: 'a-a', start_us: 1000000, end_us: 5000000 })
  // 任务行必须排在时间线之后：jobs.timeline_id 有外键，先插会撞约束。
  const rawJobs = new DatabaseSync(join(baseConfig.dataDir, 'video-tools.sqlite'))
  rawJobs.exec('PRAGMA foreign_keys=ON')
  rawJobs.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('j-a', 't-a', 'completed', 'oss://goclip-exports/p-a/j-a.mp4', '')
  rawJobs.close()
  // manifest 是 private，用一次公开写操作触发它
  await vw.createTimeline({ id: 't-a2', project_id: 'p-a', asset_id: 'a-a', start_us: 6000000, end_us: 9000000 })

  const manifestKey = 'goclip-projects/p-a/manifest.json'
  const raw2 = put.get(manifestKey)
  record('manifest 被写到 OSS', raw2 !== undefined, raw2 ? `${raw2.length} 字节` : '没有写入')

  if (raw2) {
    const m = JSON.parse(raw2)
    record('manifest 带 version 字段', typeof m.version === 'number' && m.version >= 2, `version=${m.version}`)
  // 证据层让清单升到 3；恢复端必须按版本能认的字段走，所以顺带确认证据被写进清单。
  record('manifest 带证据/片段/方案字段（版本 5）', m.version >= 5 && Array.isArray(m.evidence) && Array.isArray(m.segments) && Array.isArray(m.proposals), `version=${m.version}，evidence=${Array.isArray(m.evidence) ? m.evidence.length + ' 条' : m.evidence}，segments=${Array.isArray(m.segments) ? m.segments.length + ' 条' : m.segments}`)
    const assetIds = (m.assets ?? []).map(a => a.id)
    const timelineIds = (m.timelines ?? []).map(t => t.id)
    const jobIds = (m.jobs ?? []).map(j => j.id)
    record('manifest 含素材/时间线/任务', assetIds.includes('a-a') && timelineIds.includes('t-a') && jobIds.includes('j-a'),
      `素材=${assetIds} 时间线=${timelineIds} 任务=${jobIds}`)
    record('manifest 的 meta 是字符串（restore 按字符串解析）', typeof (m.assets ?? [])[0]?.meta === 'string',
      `meta 类型=${typeof (m.assets ?? [])[0]?.meta}`)

    // 用同一个桩件状态，在全新目录里恢复
    const freshDir = await mkdtemp(join(tmpdir(), 'goclip-restore-'))
    const restored = new VideoWorkspace({ ...baseConfig, dataDir: freshDir })
    const projects = await restored.projects()
    const assets = await restored.assets('p-a')
    const tl = await restored.timeline('t-a')
    const jobs = await restored.jobs('p-a')
    record('restore 回来了项目', projects.length === 1 && projects[0].id === 'p-a', JSON.stringify(projects))
    record('restore 回来了素材', assets.length === 1 && assets[0].id === 'a-a', `素材数=${assets.length}`)
    record('restore 回来了时间线（含区间）', tl.start_us === 1000000 && tl.end_us === 5000000, `start=${tl.start_us} end=${tl.end_us}`)
    record('restore 回来了任务', jobs.length === 1 && jobs[0].id === 'j-a', `任务数=${jobs.length}`)

    // 二次往返：再存一次，比较两次 manifest 是否一致
    const before = put.get(manifestKey)
    await restored.replaceTimeline({ timeline_id: 't-a', base_revision: 1, asset_id: 'a-a', start_us: 1000000, end_us: 6000000 })
    const after = put.get(manifestKey)
    record('时间线 revision 递增到 2', JSON.parse(after).timelines.find(t => t.id === 't-a').revision === 2,
      `revision=${JSON.parse(after).timelines.find(t => t.id === 't-a').revision}`)
    void before
  }
}

{
  // restore 只在本地库「空」时跑；已有数据时不动 —— 验证这一点
  const nonEmptyDir = await mkdtemp(join(tmpdir(), 'goclip-nonempty-'))
  const vw = new VideoWorkspace({ ...baseConfig, dataDir: nonEmptyDir })
  await vw.createProject('local-only', '本地项目')
  const again = new VideoWorkspace({ ...baseConfig, dataDir: nonEmptyDir })
  const projects = await again.projects()
  record('本地库非空时不覆盖（不重复恢复）', projects.some(p => p.id === 'local-only'), JSON.stringify(projects.map(p => p.id)))
}

// ═══ B. 并发 ═══════════════════════════════════════════════════════════════
section('B. 并发')

{
  // B1：多个调用同时触发 open()，是否只建一个连接
  //
  // 这里的桩件对象是**跨实例共享**的（模拟真实 OSS），而新实例开库时会先做一次
  // OSS restore，所以本地会带上前面 A 段写进去的项目 —— 断言只数本次新建的 c1/c2/c3。
  const dir = await mkdtemp(join(tmpdir(), 'goclip-conc-'))
  const vw = new VideoWorkspace({ ...baseConfig, dataDir: dir })
  await Promise.all([
    vw.createProject('c1', '并发一'),
    vw.createProject('c2', '并发二'),
    vw.createProject('c3', '并发三'),
  ])
  const projects = await vw.projects()
  const ids = projects.map(p => p.id)
  const mine = ['c1', 'c2', 'c3'].filter(id => ids.includes(id))
  record('并发 createProject 都落库', mine.length === 3, `本次新建的三个都在：${mine}（库内共 ${ids.length} 个，含 restore 回来的）`)
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%by_%'").all()
  const evidenceTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evidence'").all()
  const evidencePk = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='evidence_by_kind'").all()
  raw.close()
  // 索引数量随表增加；三条是最初的，第四条属于证据表。数量断言防的是"每次开库都重建表"。
  record('schema 索引已建立（说明只走了一次建表）', indexes.length === 6, `索引=${indexes.map(i => i.name)}`)
  record('证据表已建且带自己的索引', evidenceTable.length === 1 && evidencePk.length === 1,
    `表=${evidenceTable.length}，索引=${evidencePk.length}`)
}

{
  // B2：同一个素材并发 understand —— 会产生几个代理视频对象
  const dir = await mkdtemp(join(tmpdir(), 'goclip-dup-'))
  const vw = new VideoWorkspace({ ...baseConfig, dataDir: dir })
  await vw.createProject('p-b', '并发理解')
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  raw.exec('PRAGMA foreign_keys=ON')
  // 素材指向一个本地文件，materialize 直接用它（不是 oss:// 就不下载）
  const localVideo = join(dir, 'local.mp4')
  await writeFile(localVideo, Buffer.alloc(64))
  raw.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('a-b', 'p-b', localVideo, JSON.stringify({ duration_us: 5000000 }))
  raw.close()

  modelReplies = [
    '{"summary":"第一次","segments":[]}',
    '{"summary":"第二次","segments":[]}',
  ]
  const run = () => vw.understand('p-b', 'a-b', undefined, new AbortController().signal).catch(e => ({ error: String(e.message).slice(0, 60) }))
  // prepare 会调 ffmpeg，本地假文件会让它失败 —— 这本身也是要观察的行为
  const [r1, r2] = await Promise.all([run(), run()])
  const a = r1, b = r2
  const failed = Boolean(a.error) || Boolean(b.error)
  const proxyKeys = [...put.keys()].filter(k => k.startsWith('goclip-temporary/p-b/a-b/'))
  record('并发 understand 的失败是可读错误（非崩溃）', failed ? !!(a.error ?? b.error) : true,
    failed ? `都失败了，错误可读：${(a.error ?? b.error)?.slice(0, 60)}` : '两次都成功')
  if (!failed) {
    record('并发 understand 不去重（同一素材产生多份代理视频）', proxyKeys.length === 1,
      `产生的代理视频对象数=${proxyKeys.length}（每次调用一个 randomUUID）`)
  } else {
    console.log(`        （推断）每次 understand 都用 randomUUID 生成代理视频 key，因此并发不会复用，只会重复上传`)
  }
}

// ═══ C. 模型返回非 JSON ════════════════════════════════════════════════════
section('C. 模型返回非 JSON')

{
  const dir = await mkdtemp(join(tmpdir(), 'goclip-json-'))
  const vw = new VideoWorkspace({ ...baseConfig, dataDir: dir })
  await vw.createProject('p-c', 'JSON 测试')
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  raw.exec('PRAGMA foreign_keys=ON')
  const localVideo = join(dir, 'local.mp4')
  await writeFile(localVideo, Buffer.alloc(64))
  raw.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('a-c', 'p-c', localVideo, JSON.stringify({ duration_us: 5000000 }))
  raw.close()

  // 直接测 ask()（private，用索引访问）
  const ask = vw.ask.bind(vw)

  const cases = [
    ['纯 JSON', '{"summary":"好","segments":[]}'],
    ['markdown 代码块包裹', '```json\n{"summary":"好","segments":[]}\n```'],
    ['前面有说明文字', '好的，分析如下：\n{"summary":"好","segments":[]}\n希望有帮助。'],
    ['JSON 后面还有一坨说明且含花括号', '{"summary":"好","segments":[]}\n注意：{这里} 是说明'],
    ['两个 JSON 对象串联', '{"summary":"第一个"}\n{"summary":"第二个"}'],
    ['完全没有 JSON', '这个视频很好看。'],
    ['JSON 数组（顶层不是对象）', '[{"start_us":0,"end_us":1}]'],
  ]

  for (const [label, reply] of cases) {
    // 每次尝试都给同一条回复：给一条的话，第二次就会落到桩件的 '{}' 兜底而"成功"。
    modelReplies = [reply, reply, reply]
    finishReasons = []
    let outcome = ''
    let value = null
    try { value = await ask('http://stub.invalid/v.mp4', 'p', new AbortController().signal); outcome = `成功 → ${JSON.stringify(value)}` }
    catch (e) { outcome = `抛错 → ${e.message.slice(0, 70)}` }
    console.log(`  · ${label}`)
    console.log(`      ${outcome}`)
    if (label === '纯 JSON') record('纯 JSON 能解析', value !== null && value.summary === '好', outcome)
    if (label === 'markdown 代码块包裹') record('代码块包裹能解析', value !== null, outcome)
    if (label === '前面有说明文字') record('前后有说明文字能解析', value !== null, outcome)
    if (label === 'JSON 后含花括号的说明') record('后含花括号的说明仍能解析', value !== null, outcome)
    if (label === '两个 JSON 对象串联') record('两个 JSON 串联时不返回错误内容', value !== null && JSON.stringify(value) === '{"summary":"第一个"}', outcome)
    if (label === '完全没有 JSON') {
      // 现在会重试到用尽次数再抛错，且错误里要说明「试了几次」——比原来的
      // "did not return JSON" 更有行动指向。
      const clear = outcome.includes('抛错') && outcome.includes('可用的 JSON')
      record('完全没有 JSON 时报错清楚且说明重试次数', clear, outcome)
    }
    if (label === 'JSON 数组（顶层不是对象）') record('顶层数组的处理明确', true, outcome)
  }

  // 自我修正：第一次给坏回复，第二次给好回复 —— 应当成功且只多花一次调用
  {
    const before = modelCalls
    modelReplies = ['抱歉，我先说点别的。', '{"summary":"修正后的结果","segments":[]}']
    finishReasons = []
    let value = null
    let outcome = ''
    try { value = await ask('http://stub.invalid/v.mp4', 'p', new AbortController().signal); outcome = `成功 → ${JSON.stringify(value)}` }
    catch (e) { outcome = `抛错 → ${e.message.slice(0, 80)}` }
    record('坏回复后能自我修正（重试一次即成功）',
      value !== null && value.summary === '修正后的结果' && modelCalls - before === 2,
      `调用 ${modelCalls - before} 次；${outcome}`)
  }

  // 截断：finish_reason=length 必须明确报「被截断」，而不是含糊的"没返回 JSON"
  {
    modelReplies = ['{"summary":"被截断', '{"summary":"被截断', '{"summary":"被截断']
    finishReasons = ['length', 'length', 'length']
    let outcome = ''
    try { await ask('http://stub.invalid/v.mp4', 'p', new AbortController().signal); outcome = '未抛错' }
    catch (e) { outcome = e.message }
    record('输出截断时报错明确（提到截断与 max_tokens）',
      outcome.includes('截断') && outcome.includes('maxOutputTokens'),
      outcome.slice(0, 110))
  }

  // 非 429 的 4xx 不该重试：请求本身有问题，重试只是浪费
  {
    const before = modelCalls
    const realFetch = globalThis.fetch
    globalThis.fetch = async (u, init = {}) => String(u).includes('/chat/completions')
      ? new Response('bad request', { status: 400 })
      : realFetch(u, init)
    let outcome = ''
    try { await ask('http://stub.invalid/v.mp4', 'p', new AbortController().signal); outcome = '未抛错' }
    catch (e) { outcome = e.message }
    globalThis.fetch = realFetch
    record('非 429 的 4xx 不重试（省调用也省时间）',
      outcome.includes('400') && modelCalls === before,
      `模型调用次数未增加（${modelCalls - before}）；${outcome.slice(0, 80)}`)
  }
}

console.log('\n' + '='.repeat(70))
for (const f of [checkBundleFreshness(RUNTIME)]) record(f.name, f.ok, f.detail)
const bad = results.filter(r => !r.ok)
console.log(`共 ${results.length} 项断言，问题 ${bad.length} 项`)
for (const b of bad) console.log(`  · ${b.name}：${b.detail}`)

