/**
 * Map evidence from the recording's clock onto the film's clock.
 *
 * Every measured dimension is timed against the **recording** (0 → 2584s). The editor's axis is the
 * **film** (0 → 86s), because that is what the person is looking at. So a mark at 296.6s in the
 * recording belongs at 11.72s in the film — and if the cut draws that stretch twice, it belongs at
 * two places at once.
 *
 * That last part is why a span is **split at clip boundaries** rather than converted by offset.
 * A stretch of recording can appear in more than one clip, or in a clip that draws it backwards
 * relative to another; converting whole would move such a mark to a single wrong place instead of
 * showing it twice, and it would put the parts that fall outside every clip somewhere they do not
 * belong at all. Splitting keeps the invariant the lanes exist for: a mark appears exactly where
 * the film uses that moment of the recording, and nowhere else.
 *
 * The clip time base is used for placement, so a clip at 2× shows its evidence compressed into
 * half the film time — which is what the person watches.
 */
import type { ClipSpan } from './timing.ts'
import { rateOf } from './timing.ts'

/** Every evidence lane, in the order they stack above the film time. */
export const EVIDENCE_LANES = ['transcript', 'screenText', 'shots', 'silences', 'loudness', 'chapters', 'highlights'] as const

/** One evidence lane's key. */
export type EvidenceLaneKey = typeof EVIDENCE_LANES[number]

/** Which evidence lanes are drawn. The clip lane is always drawn. */
export type EvidenceVisibility = Readonly<Record<EvidenceLaneKey, boolean>>

/**
 * Read an evidence lane's key back out of an action id.
 *
 * The clip lane and the evidence lanes share one editor, so a renderer has to tell which kind of
 * action it was handed before deciding how to draw it. Lane ids are minted as `lane-<key>`, which
 * no clip id can collide with.
 *
 * The key is narrowed against the lane list rather than trusted as a string: an action id is
 * editor-supplied data crossing back into this package, and renderers switch on the result.
 *
 * @param id - the action id the editor reported.
 * @returns The lane key, or null when the id names a clip or nothing at all.
 */
export function laneOfAction(id: string): EvidenceLaneKey | null {
  if (!id.startsWith('lane-')) return null
  const key = id.slice('lane-'.length)
  return (EVIDENCE_LANES as readonly string[]).includes(key) ? key as EvidenceLaneKey : null
}

/** One stretch of time in the recording, with whatever was measured over it. */
export interface SourceSpan {
  /** Start in asset microseconds. */
  readonly start_us: number
  /** End in asset microseconds. */
  readonly end_us: number
}

/** Where a source span lands on the film, and how much of it fits there. */
export interface FilmSpan<T> {
  /** Start on the film axis, in seconds. */
  readonly start: number
  /** End on the film axis, in seconds. */
  readonly end: number
  /** The part of the original span this piece covers, in asset microseconds. */
  readonly sourceStartUs: number
  /** End of the covered part, in asset microseconds. */
  readonly sourceEndUs: number
  /** The original value, so a renderer can read its own fields. */
  readonly value: T
}

/**
 * Lay one clip's start on the film axis.
 * @param clips - the clips in output order.
 * @returns Each clip's film start in seconds, aligned with the input order.
 */
function filmStarts(clips: readonly ClipSpan[]): number[] {
  const starts: number[] = []
  let cursor = 0
  for (const clip of clips) {
    starts.push(cursor)
    cursor += (clip.end_us - clip.start_us) / 1e6 / rateOf(clip.speed)
  }
  return starts
}

/**
 * Convert one source-time mark to a position on the film axis.
 *
 * @param clips - the clips in output order.
 * @param atUs - the moment in the recording, in microseconds.
 * @returns The film position in seconds, or null when the cut does not use that moment.
 */
export function filmPositionOf(clips: readonly ClipSpan[], atUs: number): number | null {
  const starts = filmStarts(clips)
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index] as ClipSpan
    if (atUs < clip.start_us || atUs > clip.end_us) continue
    const rate = rateOf(clip.speed)
    return (starts[index] as number) + (atUs - clip.start_us) / 1e6 / rate
  }
  return null
}

/**
 * Place every span of one evidence track onto the film axis.
 *
 * @param clips - the clips in output order.
 * @param spans - the measured spans, in recording time.
 * @returns One entry per piece that the cut actually uses, in film order.
 */
export function toFilmSpans<T extends SourceSpan>(clips: readonly ClipSpan[], spans: readonly T[]): FilmSpan<T>[] {
  const starts = filmStarts(clips)
  const placed: FilmSpan<T>[] = []
  for (const span of spans) {
    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index] as ClipSpan
      const from = Math.max(span.start_us, clip.start_us)
      const to = Math.min(span.end_us, clip.end_us)
      // 只有真正落在这一段取用区间里的部分才画；其余部分在这一段上没有位置。
      if (to <= from) continue
      const rate = rateOf(clip.speed)
      const filmStart = (starts[index] as number) + (from - clip.start_us) / 1e6 / rate
      const filmEnd = (starts[index] as number) + (to - clip.start_us) / 1e6 / rate
      placed.push({ start: filmStart, end: filmEnd, sourceStartUs: from, sourceEndUs: to, value: span })
    }
  }
  return placed.sort((left, right) => left.start - right.start)
}

/**
 * Reduce a loudness reading track to one peak per bucket of film time.
 *
 * Readings arrive one per window of the recording; drawn at the film's scale there can be far more
 * of them than pixels. Taking the **peak** of each bucket rather than the mean keeps a momentary
 * loudness rise visible, which is the reason to look at the track at all.
 *
 * @param clips - the clips in output order.
 * @param levels - one reading per window, in recording order.
 * @param windowUs - length of one window in microseconds.
 * @param buckets - how many columns the film may be reduced to.
 * @returns One peak per bucket, in film order.
 */
export function loudnessColumns(
  clips: readonly ClipSpan[],
  levels: readonly number[],
  windowUs: number,
  buckets: number,
): { readonly at: number, readonly db: number }[] {
  if (levels.length === 0 || windowUs <= 0 || buckets <= 0) return []
  const starts = filmStarts(clips)
  if (starts.length === 0) return []
  const last = clips[clips.length - 1] as ClipSpan
  const filmSeconds = (starts[starts.length - 1] as number) + (last.end_us - last.start_us) / 1e6 / rateOf(last.speed)
  if (filmSeconds <= 0) return []

  const peaks = new Array<number>(buckets).fill(Number.NEGATIVE_INFINITY)
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index]
    if (level === undefined || !Number.isFinite(level)) continue
    const atUs = index * windowUs
    const filmAt = filmPositionOf(clips, atUs)
    // 没被任何一段取用的时刻没有位置可画 —— 跳过，而不是塞到端点。
    if (filmAt === null) continue
    const bucket = Math.min(buckets - 1, Math.max(0, Math.floor((filmAt / filmSeconds) * buckets)))
    if (level > (peaks[bucket] as number)) peaks[bucket] = level
  }
  return peaks.flatMap((db, index) => Number.isFinite(db)
    ? [{ at: (index + 0.5) / buckets, db }]
    : [])
}
