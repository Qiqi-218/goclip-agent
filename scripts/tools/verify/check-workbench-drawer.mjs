/**
 * Verify the product-facing workbench flow in a real browser.
 *
 * Usage: node scripts/tools/verify/check-workbench-drawer.mjs <url> <screenshot>
 */
import { writeFileSync } from 'node:fs'

const url = process.argv[2]
const screenshotPath = process.argv[3]
if (url === undefined || screenshotPath === undefined) throw new Error('usage: ... <url> <screenshot>')

const version = await (await fetch('http://127.0.0.1:9222/json/version')).json()
const socket = new WebSocket(version.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
})
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id === undefined) return
  const request = pending.get(message.id)
  if (request === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) request.reject(new Error(JSON.stringify(message.error)))
  else request.resolve(message.result)
})
await new Promise(resolve => socket.addEventListener('open', resolve))

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

await send('Page.navigate', { url }, sessionId)
await new Promise(resolve => setTimeout(resolve, 9000))

const before = await evaluate(`(() => ({
  entry: [...document.querySelectorAll('button')].map(button => (button.getAttribute('aria-label') || button.textContent || '').trim()).find(label => label.includes('工作台') || label.includes('Workbench')) || null,
  oldTechnicalCopy: document.body.textContent.includes('project=项目&asset=素材') || document.body.textContent.includes('project=<id>&asset=<id>'),
}))()`)
console.log('入口与旧文案:', JSON.stringify(before))
if (before.entry === null) throw new Error('workbench launcher is not visible')
if (before.oldTechnicalCopy) throw new Error('technical URL guidance is still visible')

const click = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find(candidate => ((candidate.getAttribute('aria-label') || candidate.textContent || '').trim().includes('工作台')))
  if (!button) return 'not-found'
  button.click()
  return 'clicked'
})()`)
console.log('打开抽屉:', click)
await new Promise(resolve => setTimeout(resolve, 1200))

const facts = await evaluate(`(() => ({
  drawer: document.querySelector('[data-workbench-drawer]') !== null,
  home: document.querySelector('[data-workbench-home]') !== null,
  oldEmpty: document.querySelector('[data-workbench-empty]') !== null,
  projectCount: document.querySelectorAll('[data-workbench-home] .${'projectRow'}').length,
  dialogLabel: document.querySelector('[data-workbench-drawer]')?.getAttribute('aria-label') || null,
}))()`)
console.log('抽屉事实:', JSON.stringify(facts, null, 2))
if (!facts.drawer || !facts.home || facts.oldEmpty) throw new Error('workbench drawer did not render the project home')

const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'))
console.log('截图已写入:', screenshotPath)
socket.close()
