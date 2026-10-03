/**
 * Pure derivation of the evidence panel's drawing model from the persisted
 * `tool/result` metadata.
 *
 * The payload arrives from a session log, so every field is unvalidated: a log
 * written by another build, or a hand-edited one, reaches here. Anything that
 * does not match the expected form is dropped rather than thrown on, and a
 * payload with no drawable dimension at all yields null so the caller falls back
 * to the generic Tool row.
 * @module
 */

/** One 0–1 position on the shared time axis, with the absolute time it came from. */
export interface EvidenceMark {
  /** Start on the shared axis. */
  readonly start: number
  /** End on the shared axis. */
  readonly end: number
  /** Absolute start in microseconds, for a jump back into the other tools. */
  readonly startUs: number
  /** Absolute end in microseconds. */
  readonly endUs: number
}

/** A mark that carries text: one transcript line, screen-text entry or scene. */
export interface EvidenceTextMark extends EvidenceMark {
  /** The recorded text. */
  readonly text: string
}

/** One year of the loudness curve: a positioned sample in dBFS. */
export interface LoudnessSample {
  /** Position on the shared axis. */
  readonly at: number
  /** Level in dBFS. */
  readonly db: number
}

/** The loudness curve and the range that gives it meaning. */
export interface LoudnessTrack {
  /** Quietest sample, in dBFS. */
  readonly floorDbfs: number | null
  /** Loudest sample, in dBFS. */
  readonly peakDbfs: number | null
  /** The "loud" threshold the producer used, in dBFS. */
  readonly loudDbfs: number | null
  /** Samples in axis order. */
  readonly samples: readonly LoudnessSample[]
}

/** One segment of a timeline drawn on the asset's own axis. */
export interface TimelineMark extends EvidenceMark {
  /** Position in the timeline. */
  readonly ordinal: number
  /** Whether this segment even belongs to the asset the axis describes. */
  readonly onThisAxis: boolean
  /** Playback speed. */
  readonly speed: number
  /** Whether the segment is muted. */
  readonly muted: boolean
}

/** A timeline's segments, when the call asked for one. */
export interface TimelineTrack {
  /** Revision the segments were read at. */
  readonly revision: number
  /** Segments in playback order. */
  readonly segments: readonly TimelineMark[]
}

/** The panel's complete drawing model. */
export interface EvidenceViewModel {
  /** Total length in microseconds; 0 when the producer did not record one. */
  readonly durationUs: number
  /** Loudness curve, absent when the asset has no acoustic evidence. */
  readonly loudness: LoudnessTrack | null
  /** Shot boundaries. */
  readonly shots: readonly EvidenceMark[]
  /** Silence spans. */
  readonly silences: readonly EvidenceMark[]
  /** Transcript lines. */
  readonly transcript: readonly EvidenceTextMark[]
  /** On-screen text entries. */
  readonly screenText: readonly EvidenceTextMark[]
  /** Scene descriptions. */
  readonly scenes: readonly EvidenceTextMark[]
  /** Chapter summaries. */
  readonly chapters: readonly EvidenceTextMark[]
  /** Interleaved timeline segments, when the call carried a timeline. */
  readonly timeline: TimelineTrack | null
  /**
   * Evidence kinds the producer reported as absent.
   *
   * Null, not empty, when the payload carries no report at all: the persisted
   * projection keeps only what a panel draws, so "the producer said nothing is
   * missing" and "the producer did not say" are different facts and the panel
   * must not show a completeness claim it cannot support.
   */
  readonly missing: readonly string[] | null
}

/** Whether a value is a usable finite number. */
function num(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Enter a record, or return null when the value is not a plain object. */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Read one span, declining when either position is unusable. */
function mark(value: unknown): EvidenceMark | null {
  const item = record(value)
  if (item === null || !num(item.start) || !num(item.end) || !num(item.start_us) || !num(item.end_us)) return null
  return { start: item.start, end: item.end, startUs: item.start_us, endUs: item.end_us }
}

/** Read one text-bearing span, declining when its text is absent. */
function textMark(value: unknown): EvidenceTextMark | null {
  const span = mark(value)
  if (span === null) return null
  const item = record(value)
  const text = typeof item?.text === 'string' ? item.text : typeof item?.description === 'string' ? item.description : ''
  return text === '' ? null : { ...span, text }
}

/** Map a list through a reader, dropping everything the reader declined. */
function mapped<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.map(read).filter((item): item is T => item !== null) : []
}

/** Read the loudness curve; absent or sampleless means the dimension is absent. */
function loudnessTrack(value: unknown): LoudnessTrack | null {
  const track = record(value)
  if (track === null) return null
  const samples = mapped(track.samples, (entry): LoudnessSample | null => {
    const sample = record(entry)
    return sample !== null && num(sample.at) && num(sample.db) ? { at: sample.at, db: sample.db } : null
  })
  if (samples.length === 0) return null
  return {
    floorDbfs: num(track.floor_dbfs) ? track.floor_dbfs : null,
    peakDbfs: num(track.peak_dbfs) ? track.peak_dbfs : null,
    loudDbfs: num(track.loud_dbfs) ? track.loud_dbfs : null,
    samples,
  }
}

/**
 * Read a timeline's segments.
 *
 * Whether a segment sits on the drawn axis is read from the producer's own
 * `on_this_axis`, never re-derived here: the projection that persists this
 * payload carries no asset id, and the producer is the one that knows which
 * asset the axis describes.
 */
function timelineTrack(value: unknown): TimelineTrack | null {
  const track = record(value)
  if (track === null) return null
  const segments = mapped(track.segments, (entry): TimelineMark | null => {
    const span = mark(entry)
    if (span === null) return null
    const segment = record(entry)
    if (segment === null) return null
    return {
      ...span,
      ordinal: num(segment.ordinal) ? segment.ordinal : 0,
      onThisAxis: segment.on_this_axis === true,
      speed: num(segment.speed) ? segment.speed : 1,
      muted: segment.muted === true,
    }
  })
  if (segments.length === 0) return null
  return { revision: num(track.revision) ? track.revision : 0, segments }
}

/**
 * Project the persisted result metadata onto the panel's model.
 *
 * @param meta - the `tool/result` metadata of unknown form.
 * @returns the drawing model, or null when nothing is drawable.
 */
export function evidenceViewModel(meta: unknown): EvidenceViewModel | null {
  const envelope = record(meta)
  const view = record(envelope?.evidence_view)
  if (view === null) return null
  const dimensions = record(view.dimensions)
  if (dimensions === null) return null
  const model: EvidenceViewModel = {
    durationUs: num(view.duration_us) ? view.duration_us : 0,
    loudness: loudnessTrack(dimensions.loudness),
    shots: mapped(dimensions.shots, mark),
    silences: mapped(dimensions.silences, mark),
    transcript: mapped(dimensions.transcript, textMark),
    screenText: mapped(dimensions.screen_text, textMark),
    scenes: mapped(dimensions.scenes, textMark),
    chapters: mapped(dimensions.chapters, textMark),
    timeline: timelineTrack(view.timeline),
    missing: Array.isArray(view.missing)
      ? view.missing.filter((kind): kind is string => typeof kind === 'string')
      : null,
  }
  return drawable(model) ? model : null
}

/** Whether the model has anything at all to draw. */
function drawable(model: EvidenceViewModel): boolean {
  return model.loudness !== null
    || model.shots.length > 0
    || model.silences.length > 0
    || model.transcript.length > 0
    || model.screenText.length > 0
    || model.scenes.length > 0
    || model.chapters.length > 0
}

/**
 * Whether an unknown value is a known evidence dimension identifier.
 *
 * The payload carries the producer's own identifiers, so a consumer that
 * switches on them has to narrow rather than trust the wire.
 * @param value - unvalidated dimension identifier.
 * @returns true for the six declared dimensions.
 */
export function isEvidenceDimension(value: string): value is EvidenceDimension {
  return (EVIDENCE_DIMENSIONS as readonly string[]).includes(value)
}

/** The six evidence dimensions, in the producer's declaration order. */
export const EVIDENCE_DIMENSIONS = [
  'acoustic-loudness',
  'shot-boundaries',
  'silence-timing',
  'transcript',
  'screen-text',
  'scene-description',
] as const

/** One declared evidence dimension identifier. */
export type EvidenceDimension = typeof EVIDENCE_DIMENSIONS[number]
