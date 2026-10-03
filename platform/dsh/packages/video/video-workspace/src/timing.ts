/**
 * Silence detection, from ffmpeg's `silencedetect`.
 *
 * This is the evidence behind "去掉所有停顿": a pause is measurable, and removing one
 * means finding the span between the end of speech and the start of the next. It is
 * also a cheap proxy for sentence boundaries, which helps place cuts without a
 * transcript.
 */

/** One stretch of near-silence. */
export interface SilenceSpan {
  startUs: number
  endUs: number
  seconds: number
}

/**
 * Parse `silencedetect` output into spans.
 *
 * ffmpeg prints a start line and later an end line, and its final span may never be
 * closed when the recording ends in silence; that open span is closed at the asset's
 * end by the caller, which is why an unmatched start is preserved rather than dropped.
 *
 * @param stderr - combined ffmpeg output carrying `silence_start` / `silence_end` lines.
 * @returns Markers in output order, each holding whichever bound that line reported.
 */
export function parseSilences(stderr: string): Array<{ startUs?: number, endUs?: number }> {
  const events: Array<{ startUs?: number, endUs?: number }> = []
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?[0-9.]+)/.exec(line)
    if (start !== null) {
      const seconds = Number(start[1])
      if (Number.isFinite(seconds)) events.push({ startUs: Math.max(0, Math.round(seconds * 1_000_000)) })
      continue
    }
    const end = /silence_end:\s*(-?[0-9.]+)/.exec(line)
    if (end !== null) {
      const seconds = Number(end[1])
      if (Number.isFinite(seconds)) events.push({ endUs: Math.max(0, Math.round(seconds * 1_000_000)) })
    }
  }
  return events
}

/**
 * Pair the start and end events into spans.
 *
 * @param events - parsed `silence_start` and `silence_end` markers, in output order.
 * @param durationUs - asset length, used to close a span the recording ended inside.
 * @param minSeconds - shortest pause worth reporting; shorter ones are natural speech.
 * @returns Pauses in time order, each at least `minSeconds` long.
 */
export function buildSilences(events: Array<{ startUs?: number, endUs?: number }>, durationUs: number, minSeconds: number): SilenceSpan[] {
  const spans: SilenceSpan[] = []
  let open: number | undefined
  for (const event of events) {
    if (event.startUs !== undefined) { open = event.startUs; continue }
    if (event.endUs === undefined) continue
    const startUs = open ?? 0
    open = undefined
    if (event.endUs > startUs) spans.push({ startUs, endUs: event.endUs, seconds: round((event.endUs - startUs) / 1_000_000) })
  }
  if (open !== undefined && durationUs > open) spans.push({ startUs: open, endUs: durationUs, seconds: round((durationUs - open) / 1_000_000) })
  return spans.filter(span => span.seconds >= minSeconds).sort((a, b) => a.startUs - b.startUs)
}

/**
 * The intervals left after removing the given spans from `[0, durationUs)`.
 *
 * Returned as intervals rather than as a trimmed list because callers need to build
 * timelines from them, and merging the removals first is what keeps two adjacent
 * pauses from producing a zero-length interval between them.
 *
 * @param durationUs - asset length; the intervals returned cover exactly this span.
 * @param spans - spans to remove, in any order and possibly overlapping.
 * @param minKeepUs - shortest fragment worth returning.
 * @returns The remaining intervals, in time order, with none shorter than `minKeepUs`.
 */
export function subtractSpans(durationUs: number, spans: Array<{ startUs: number, endUs: number }>, minKeepUs = 0): Array<{ startUs: number, endUs: number }> {
  const ordered = [...spans].sort((a, b) => a.startUs - b.startUs)
  const merged: Array<{ startUs: number, endUs: number }> = []
  for (const span of ordered) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.startUs <= last.endUs) { last.endUs = Math.max(last.endUs, span.endUs); continue }
    merged.push({ startUs: Math.max(0, span.startUs), endUs: Math.min(durationUs, span.endUs) })
  }
  const kept: Array<{ startUs: number, endUs: number }> = []
  let cursor = 0
  for (const span of merged) {
    if (span.startUs > cursor) kept.push({ startUs: cursor, endUs: span.startUs })
    cursor = Math.max(cursor, span.endUs)
  }
  if (cursor < durationUs) kept.push({ startUs: cursor, endUs: durationUs })
  // Two pauses that nearly touch leave a sliver of sound between them. A sliver is not a
  // clip: it renders as a flash and adds a splice point for nothing, so it is dropped and
  // reported as removed rather than returned as something the caller should cut.
  return kept.filter(interval => interval.endUs - interval.startUs >= minKeepUs)
}

/** Round to two decimals: silence boundaries are not worth more precision. */
function round(value: number): number { return Math.round(value * 100) / 100 }
