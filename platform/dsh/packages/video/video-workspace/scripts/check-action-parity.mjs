/**
 * Fail when the plugin and the video-agent service disagree about the action
 * set.
 *
 * The bundle declares tool schemas statically while the service validates them
 * at dispatch, so the two lists can drift silently in either direction: a tool
 * the service cannot answer, or a service action no tool reaches. The service
 * side already refuses to change without this passing; this is the half that
 * reads the built artifact.
 *
 * Run with: node scripts/check-action-parity.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Where the service declares its action names. An override keeps this check
// usable when the service lives outside the default checkout layout.
const SERVICE_ACTIONS_FILE = process.env.VIDEO_AGENT_SERVICE_GO
  ?? fileURLToPath(new URL('../../../../../../apps/video-agent/internal/agent/service.go', import.meta.url))
const BUNDLE = fileURLToPath(new URL('../lib/index.js', import.meta.url))

// Every action the service's dispatch answers, read off its own switch.
const source = readFileSync(SERVICE_ACTIONS_FILE, 'utf8')
const actions = new Set()
for (const match of source.matchAll(/case "([a-z_]+)":/g)) actions.add(match[1])
if (actions.size === 0) {
  console.error('no actions found in the service dispatch; the pattern has drifted')
  process.exit(1)
}

// Every tool the bundle registers, read by registering onto a stub registry.
const registered = new Set()
const ctx = { tools: { register(definition) { registered.add(definition.name); return () => {} } } }
const mod = await import(pathToFileURL(BUNDLE).href)
mod.apply(ctx, { endpoint: 'http://127.0.0.1:1', timeoutMs: 1000, framePreviewScale: 0 })

const covered = new Set()
for (const name of registered) {
  if (!name.startsWith('video_')) continue
  covered.add(name.slice('video_'.length))
}

const missingTools = [...actions].filter(a => !covered.has(a)).sort()
const orphanTools = [...covered].filter(a => !actions.has(a)).sort()

console.log(`service actions : ${actions.size}`)
console.log(`registered tools: ${registered.size}`)
console.log(`covered actions : ${covered.size}`)

if (missingTools.length > 0 || orphanTools.length > 0) {
  if (missingTools.length > 0) console.error(`\nservice actions with no tool: ${missingTools.join(', ')}`)
  if (orphanTools.length > 0) console.error(`\ntools with no service action: ${orphanTools.join(', ')}`)
  process.exit(1)
}
console.log('\nparity holds: every service action has exactly one tool')
