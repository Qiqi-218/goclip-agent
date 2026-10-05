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
 * Cut every span of one evidence track down to the parts the cut actually uses.
 *
 * On the recording's axis a mark's position **is** its recording time, so nothing is remapped:
 * what this does is keep the marks that fall inside a used stretch and split the ones that straddle
 * a boundary. A span the cut never uses is dropped — drawing it would say the film contains
 * something it does not.
 *
 * This used to remap onto the film's axis, which is what made a mark's position depend on how many
 * clips preceded it. Removing that remapping is what lets the lane, the ruler and the player all
 * name the same moment.
 *
 * @param clips - the clips in output order.
 * @param spans - the measured spans, in recording time.
 * @returns One entry per used piece, in recording order.
 */
export function toUsedSpans<T extends SourceSpan>(clips: readonly ClipSpan[], spans: readonly T[]): FilmSpan<T>[] {
  const used = clips
    .filter(clip => clip.end_us > clip.start_us)
    .map(clip => ({ start_us: clip.start_us, end_us: clip.end_us }))
    .sort((left, right) => left.start_us - right.start_us)
  const placed: FilmSpan<T>[] = []
  for (const span of spans) {
    for (const clip of used) {
      const from = Math.max(span.start_us, clip.start_us)
      const to = Math.min(span.end_us, clip.end_us)
      // 只有真正落在取用区间里的部分才画；其余部分在成片里没有位置。
      if (to <= from) continue
      placed.push({ start: from / 1e6, end: to / 1e6, sourceStartUs: from, sourceEndUs: to, value: span })
    }
  }
  return placed.sort((left, right) => left.start - right.start)
}

/**
 * Reduce a loudness reading track to one peak per bucket of recording time.
 *
 * Readings arrive one per window of the recording; drawn at the recording's scale there can be far
 * more of them than pixels. Taking the **peak** of each bucket rather than the mean keeps a
 * momentary loudness rise visible, which is the reason to look at the track at all.
 *
 * Buckets cover the whole recording rather than just the used stretches: the curve is a property
 * of the material, and clipping it to the cut would make two different cuts look like they had
 * different audio.
 *
 * @param levels - one reading per window, in recording order.
 * @param windowUs - length of one window in microseconds.
 * @param buckets - how many columns the axis may be reduced to.
 * @returns One peak per bucket, positioned as a share of the recording.
 */
export function loudnessColumns(
  levels: readonly number[],
  windowUs: number,
  buckets: number,
): { readonly at: number, readonly db: number }[] {
  if (levels.length === 0 || windowUs <= 0 || buckets <= 0) return []
  const totalSeconds = (levels.length * windowUs) / 1e6
  if (totalSeconds <= 0) return []

  const peaks = new Array<number>(buckets).fill(Number.NEGATIVE_INFINITY)
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index]
    if (level === undefined || !Number.isFinite(level)) continue
    // 读数本身就带位置：第 N 个窗口覆盖第 N 段素材时间。在素材轴上不再需要查「它落在哪一段里」，
    // 于是这一段也不再有「某个时刻没有位置」这种情况 —— 每个读数都有位置，因为它就是素材的一部分。
    const atSeconds = (index * windowUs) / 1e6
    const bucket = Math.min(buckets - 1, Math.max(0, Math.floor((atSeconds / totalSeconds) * buckets)))
    if (level > (peaks[bucket] as number)) peaks[bucket] = level
  }
  return peaks.flatMap((db, index) => Number.isFinite(db)
    ? [{ at: (index + 0.5) / buckets, db }]
    : [])
}
