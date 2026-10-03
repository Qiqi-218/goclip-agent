/**
 * Read a multi-frame zstd session log.
 *
 * Node's zstdDecompressSync decodes only the first frame, and a `session.v4.jsonl.zstd`
 * log is written as one frame per append. This walks the frames so the whole log is readable.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Byte offsets of every zstd frame in the file. */
function frameOffsets(buffer) {
  const offsets = []
  let at = buffer.indexOf(MAGIC, 0)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(MAGIC, at + 4)
  }
  return offsets
}

/**
 * Decode every frame of the file, in order.
 * @param path - the log path.
 * @returns the concatenated text.
 */
function readLog(path) {
  const buffer = readFileSync(path)
  const offsets = frameOffsets(buffer)
  const parts = []
  let failed = 0
  for (let index = 0; index < offsets.length; index += 1) {
    const slice = buffer.subarray(offsets[index], offsets[index + 1] ?? buffer.length)
    try {
      parts.push(zstdDecompressSync(slice).toString('utf8'))
    } catch {
      failed += 1
    }
  }
  return { text: parts.join(''), frames: offsets.length, failed }
}

const path = process.argv[2]
const needle = process.argv[3] ?? 'evidence_view'
const { text, frames, failed } = readLog(path)
console.log(`frames=${frames} failed=${failed} chars=${text.length} magic_hits=${(text.match(new RegExp(needle, 'g')) ?? []).length}`)

const lines = text.split('\n').filter(line => line.length > 0)
console.log(`lines=${lines.length}`)
for (const line of lines) {
  if (!line.includes(needle)) continue
  let event
  try { event = JSON.parse(line) } catch { console.log('  (unparsable line containing', needle, ')'); continue }
  const type = event.type ?? Object.keys(event).slice(0, 6).join(',')
  console.log(`\n=== ${type} ===`)
  console.log(JSON.stringify(event, null, 1).slice(0, Number(process.argv[4] ?? 2000)))
}
