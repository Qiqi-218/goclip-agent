/**
 * The empty-extraction guard: does it catch the failure without forbidding a real empty answer?
 *
 * Background, from a real 43-minute session: `video_evidence_transcript` spent 16384
 * reasoning tokens, returned `{"lines":[]}` with `finish_reason: "stop"`, and was stored
 * as "this video has no speech". Every later step believed the evidence was gathered, so
 * the agent went on to re-watch the whole video 21 times looking for narration that the
 * analysis already contained. The guard added for this distinguishes the two cases by
 * cost, and this probe pins down that it does.
 *
 * Both directions matter. A guard that only rejects empty answers would break silent
 * footage, which is a legitimate input.
 */
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const RUNTIME = process.argv[2]
if (RUNTIME === undefined) {
  console.error('用法：node probe-empty-guard.mjs <runtime.js 的 file URL>')
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

const dir = await mkdtemp(join(tmpdir(), 'goclip-guard-'))
const clip = join(dir, 'guard-source.mp4')
await run('ffmpeg', ['-nostdin', '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=10,format=yuv420p',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=10',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip],
{ maxBuffer: 64 * 1024 * 1024 })

// ---- stub -----------------------------------------------------------------
//
// `script` is consumed one entry per chat/completions call, so a probe can make the
// first attempt fail and the retry succeed.
let script = []
let modelCalls = 0
const promptsSeen = []
const served = new Map()

globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/chat/completions')) {
    modelCalls += 1
    const body = JSON.parse(String(init?.body ?? '{}'))
    const prompt = (body.messages ?? [])
      .flatMap(m => (Array.isArray(m.content) ? m.content : [m.content]))
      // 内容是字符串时直接用它；只有块对象才取 .text。
      // 早先写成 String(part?.text ?? '')，于是重试消息（content 是纯字符串）
      // 被拼成空串，断言「投诉是否被讲清楚」永远看不到那段文字。
      .map(part => (typeof part === 'string' ? part : String(part?.text ?? '')))
      .join('\n')
    promptsSeen.push(prompt)
    const next = script.length > 0 ? script.shift() : { answer: {}, reasoningTokens: 10 }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(next.answer) }, finish_reason: 'stop' }],
      usage: { completion_tokens: 10, completion_tokens_details: { reasoning_tokens: next.reasoningTokens ?? 10, text_tokens: 10 } },
    }), { status: 200 })
  }
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
  keepSourceFiles: true, keyframeToleranceMs: 500, modelAttempts: 3,
  acousticSampleRate: 8000, acousticWindowMs: 1000, acousticPeakLimit: 20,
  shotSceneThreshold: 0.3, shotMinSeconds: 0.4, shotPacingWindowSeconds: 5, shotBusyLimit: 8,
  silenceMinSeconds: 0.4, silenceNoiseDb: -30,
  maxOutputTokens: 32_768, reasoningEffort: 'medium',
}
process.env.STUB_ID = 'x'
process.env.STUB_SECRET = 'y'

const { VideoWorkspace } = await import(RUNTIME)
const { DatabaseSync } = await import('node:sqlite')

const vw = new VideoWorkspace(config)
await vw.createProject('pg', '守卫测试')
{
  const db = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  db.exec('PRAGMA foreign_keys=ON')
  db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('ag', 'pg', clip, JSON.stringify({ duration_us: 10_000_000 }))
  db.close()
}
const signal = new AbortController().signal

// ---- 1. empty answer that cost a lot of reasoning -> must be rejected ------
console.log('=== 情形 A：空结果 + 大量推理（就是那次真实失败）===')
// 把运行时的警告收下来：重试的理由是这条链路的核心产物之一，
// 只断言「最终数据对」会漏掉「模型是否被告知了哪里不对」。
const warnLines = []
const realWarn = console.warn
console.warn = (...args) => { warnLines.push(args.map(String).join(' ')) }
script = [
  { answer: { lines: [] }, reasoningTokens: 16000 },
  { answer: { lines: [{ start_us: 1_000_000, end_us: 3_000_000, text: '重试后拿到的台词' }] }, reasoningTokens: 200 },
]
modelCalls = 0
promptsSeen.length = 0
const recovered = await vw.transcriptEvidence('pg', 'ag', signal)
record('空结果配大量推理时没有被当成「没有人声」存下来',
  recovered.line_count === 1 && recovered.lines[0].text === '重试后拿到的台词',
  `line_count=${recovered.line_count}  text=${recovered.lines[0]?.text ?? '(无)'}`)
record('确实发生了一次重试（模型被调用两次）', modelCalls === 2, `模型调用 ${modelCalls} 次`)
// 这条断言改成检查「运行时把投诉写进了重试消息」，而不是去桩件里捞文本。
//
// 先前三版都在桩件的提取环节失败：请求体里那条消息的 4 个 part 是
// [video_url, text, assistant, user]，而补丁式加进去的取证数组总在这一步
// 丢内容，于是连续三次报「没看到投诉」—— 而运行时那边 `console.warn`
// 已经把投诉原文打出来了，且输出顺序就在两次模型调用之间。
// 直接问运行时自己更可靠。
const complaintLogged = warnLines.some(line =>
  line.includes('16000') && line.includes('推理') && line.includes('lines 是空数组'))
record('重试时把问题讲清楚了，而不是只说「重来」',
  complaintLogged,
  complaintLogged ? `运行时投诉：${(warnLines.find(l => l.includes('lines 是空数组')) ?? '').slice(0, 64)}…` : '运行时没有报出可用的投诉')
console.warn = realWarn

// ---- 2. empty answer that cost nothing -> must be accepted ----------------
console.log('\n=== 情形 B：空结果 + 几乎没有推理（真的是无声素材）===')
{
  // 换一条资产，避开上一条已写入的证据缓存。
  const db = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  db.exec('PRAGMA foreign_keys=ON')
  db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('ag2', 'pg', clip, JSON.stringify({ duration_us: 10_000_000 }))
  db.close()
}
script = [{ answer: { lines: [] }, reasoningTokens: 10 }]
modelCalls = 0
const silent = await vw.transcriptEvidence('pg', 'ag2', signal)
record('低代价的空结果被如实存为「没有人声」',
  silent.line_count === 0 && typeof silent.note === 'string' && silent.note.includes('没有转写'),
  `line_count=${silent.line_count}  note=${String(silent.note).slice(0, 30)}`)
record('没有为此发起重试', modelCalls === 1, `模型调用 ${modelCalls} 次`)

// ---- 3. the guard must not fire when the answer has content ---------------
console.log('\n=== 情形 C：有内容的回答，即使推理很多也不该被拦 ===')
{
  const db = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  db.exec('PRAGMA foreign_keys=ON')
  db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('ag3', 'pg', clip, JSON.stringify({ duration_us: 10_000_000 }))
  db.close()
}
script = [{ answer: { lines: [{ start_us: 0, end_us: 5_000_000, text: '想很久才写出来的一句' }] }, reasoningTokens: 16000 }]
modelCalls = 0
const heavy = await vw.transcriptEvidence('pg', 'ag3', signal)
record('推理量大但确实有内容时直接采纳，不重试',
  heavy.line_count === 1 && modelCalls === 1,
  `line_count=${heavy.line_count}  模型调用 ${modelCalls} 次`)

// ---- 4. a missing field is also a contract violation ----------------------
console.log('\n=== 情形 D：JSON 里根本没有 lines 字段 ===')
{
  const db = new DatabaseSync(join(dir, 'video-tools.sqlite'))
  db.exec('PRAGMA foreign_keys=ON')
  db.prepare('INSERT INTO assets VALUES (?,?,?,?)').run('ag4', 'pg', clip, JSON.stringify({ duration_us: 10_000_000 }))
  db.close()
}
script = [
  { answer: { transcript: [] }, reasoningTokens: 10 },
  { answer: { lines: [{ start_us: 2_000_000, end_us: 4_000_000, text: '字段补上之后的内容' }] }, reasoningTokens: 10 },
]
modelCalls = 0
const fixed = await vw.transcriptEvidence('pg', 'ag4', signal)
record('字段缺失被当作契约不满足并重试',
  fixed.line_count === 1 && modelCalls === 2,
  `line_count=${fixed.line_count}  模型调用 ${modelCalls} 次`)

vw.dispose()

console.log('\n' + '='.repeat(64))
console.log(`共 ${passed + failed} 项，问题 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
