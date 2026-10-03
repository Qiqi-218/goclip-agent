/** Print one event type's records from a multi-frame zstd session log. */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode every frame of a session log.
 * @param path - log path.
 * @returns the concatenated text plus frame statistics.
 */
function readLog(path) {
  const buffer = readFileSync(path)
  const offsets = []
  let at = buffer.indexOf(MAGIC, 0)
  while (at !== -1) { offsets.push(at); at = buffer.indexOf(MAGIC, at + 4) }
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const slice = buffer.subarray(offsets[index], offsets[index + 1] ?? buffer.length)
    try { parts.push(zstdDecompressSync(slice).toString('utf8')) } catch { /* frame boundary noise */ }
  }
  return { text: parts.join(''), frames: offsets.length }
}

const path = process.argv[2]
const type = process.argv[3]
const nameFilter = process.argv[4]
const limit = Number(process.argv[5] ?? 3000)

const { text, frames } = readLog(path)
const lines = text.split('\n').filter(line => line.length > 0)
let shown = 0
for (const line of lines) {
  let event
  try { event = JSON.parse(line) } catch { continue }
  if (event.type !== type) continue
  const blob = JSON.stringify(event)
  if (nameFilter !== undefined && !blob.includes(nameFilter)) continue
  shown += 1
  console.log(`\n===== ${type} seq=${event.seq} (${shown}) =====`)
  console.log(JSON.stringify(event, null, 1).slice(0, limit))
}
console.log(`\nframes=${frames} lines=${lines.length} matched=${shown}`)
