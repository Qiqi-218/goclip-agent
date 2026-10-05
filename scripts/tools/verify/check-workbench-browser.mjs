/**
 * 实机确认工作台：开页面、切到工作台、截图、并把 DOM 事实读回来。
 *
 * 单测证明不了「在真浏览器里真的画出来了」—— 令牌、模块加载、路由可达、
 * 布局是否给到了高度，任何一项出问题都会得到一个空白工作台，而单测全绿。
 * 所以这里读的是渲染后的 DOM 与一张截图。
 *
 * 用法: node cdp_workbench_check.mjs <workbenchUrl> <screenshotPath>
 */
import { writeFileSync } from 'node:fs'

const URL_ = process.argv[2]
const SHOT = process.argv[3]

const version = await (await fetch('http://127.0.0.1:9222/json/version')).json()
const ws = new WebSocket(version.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
})
ws.addEventListener('message', event => {
  const msg = JSON.parse(event.data)
  if (msg.id === undefined) return
  const entry = pending.get(msg.id)
  if (entry === undefined) return
  pending.delete(msg.id)
  if (msg.error !== undefined) entry.reject(new Error(JSON.stringify(msg.error)))
  else entry.resolve(msg.result)
})
await new Promise(resolve => ws.addEventListener('open', resolve))

// 用一个新标签页，避免复用 about:blank 的历史。
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}

await send('Page.navigate', { url: URL_ }, sessionId)
// 等页面把客户端插件装载完并渲染出工作台按钮。
await new Promise(resolve => setTimeout(resolve, 9000))

const beforeClick = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('[class*="panellist"] *, [role="tab"], button')]
  const labels = buttons.map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean)
  return { workbenchEntry: labels.filter(l => l.includes('工作台') || l.includes('Workbench')) }
})()`)
console.log('侧栏里的工作台入口:', JSON.stringify(beforeClick.workbenchEntry))

// 点它 —— 走用户真正走的那条路，而不是直接改状态。
const clicked = await evaluate(`(() => {
  const all = [...document.querySelectorAll('button, [role="tab"], [role="button"], a')]
  const target = all.find(b => ((b.getAttribute('aria-label') || b.textContent || '').trim().includes('工作台')))
  if (!target) return 'not-found'
  target.click()
  return 'clicked'
})()`)
console.log('点击结果:', clicked)
await new Promise(resolve => setTimeout(resolve, 4000))

const facts = await evaluate(`(() => {
  const wb = document.querySelector('[data-workbench]')
  const areas = [...document.querySelectorAll('[data-area]')].map(c => c.getAttribute('data-area'))
  const heads = [...document.querySelectorAll('[data-workbench] h2')].map(h => h.textContent)
  const video = document.querySelector('video')
  // 时间线现在是第三方编辑器（react-timeline-editor），片段由它渲染。
  // 这里读的是我们交给它的片段与它自己的刻度，而不是我们手绘的元素。
  const clips = document.querySelectorAll('[data-clip-render]').length
  const empty = document.querySelector('[data-workbench-empty]')
  const rect = wb ? wb.getBoundingClientRect() : null
  return {
    workbenchPresent: wb !== null,
    box: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
    areas,
    headings: heads,
    videoSrc: video ? video.getAttribute('src') : null,
    videoReadyState: video ? video.readyState : null,
    videoDuration: video && Number.isFinite(video.duration) ? Math.round(video.duration) : null,
    clipCount: clips,
    timelineEditorPresent: document.querySelector('.timeline-editor') !== null,
    zoomPresent: document.querySelector('[data-zoom-range]') !== null,
    emptyNotice: empty ? empty.textContent.slice(0, 40) : null,
    playerError: document.querySelector('[data-player-error]') ? true : false,
  }
})()`)
console.log('渲染后的事实:')
console.log(JSON.stringify(facts, null, 2))

// 点刻度区，看播放器是否真的移动 —— 这是分镜脚本的核心交互之一。
const seekResult = await evaluate(`(async () => {
  const vp = document.querySelector('[data-timeline-viewport]')
  const first = document.querySelector('[data-clip-render]')
  if (!vp || !first) return { skipped: 'timeline-not-rendered' }
  const vpBox = vp.getBoundingClientRect()
  const clipBox = first.getBoundingClientRect()
  // 刻度区在轨道上方；点到轨道上不会触发跳转。
  const x = Math.round(vpBox.x + 400)
  const y = Math.round((vpBox.y + clipBox.top) / 2)
  const video = document.querySelector('video')
  const before = video.currentTime
  for (const type of ['mousedown', 'mouseup', 'click']) {
    document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
  }
  await new Promise(r => setTimeout(r, 2500))
  return { before, after: Math.round(video.currentTime * 100) / 100, moved: Math.abs(video.currentTime - before) > 1 }
})()`)
console.log('点刻度区后的播放头:', JSON.stringify(seekResult))

const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
console.log('截图已写入:', SHOT)

ws.close()
process.exit(0)
