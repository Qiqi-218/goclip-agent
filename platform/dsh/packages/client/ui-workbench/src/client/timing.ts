/**
 * The three time coordinates the timeline works in, and the conversions between them.
 *
 * A clip lives in two different times at once, and the timeline editor only knows one of them:
 *
 * | Name | Meaning | Who uses it |
 * | --- | --- | --- |
 * | source time | where the clip sits in the recording (0 → 2584s) | `start_us` / `end_us` |
 * | output time | where the clip sits in the finished film (0 → 86s) | the editor's own axis |
 * | clip-local | source time measured from this clip's own start | `trimSegment`'s `delta_us` |
 *
 * Mixing them is not a cosmetic error. Subtracting an output position from a source position
 * produced a "move the right edge by −264 seconds" instruction during verification — a number
 * that cannot be carried out, from a drag that moved the edge by 80 pixels.
 *
 * One invariant ties the two: **a clip occupies output time equal to the source time it draws
 * divided by its playback rate.** So an editor movement of Δt seconds is a source movement of
 * `Δt × speed` seconds, and that factor is the whole reason this module exists rather than each
 * caller doing the arithmetic where it happens to be needed.
 */

/** A clip's position in source time, in microseconds, plus how it plays. */
export interface ClipSpan {
  /** Start in asset microseconds. */
  readonly start_us: number
  /** End in asset microseconds. */
  readonly end_us: number
  /** Playback rate; a value other than 1 changes how long the clip occupies on output. */
  readonly speed: number
  /** Whether the clip's audio is dropped. */
  readonly muted: boolean
  /** What a person called this clip, or null when nobody named it. */
  readonly name: string | null
}

/**
 * Read a clip's playback rate, treating a zero as "no change".
 *
 * A stored zero would otherwise divide into the output length and make a clip occupy infinite
 * time. The column is a number rather than an enum, so the guard belongs here where every
 * conversion passes through it.
 *
 * @param speed - the stored playback rate.
 * @returns A rate that is safe to divide by.
 */
export function rateOf(speed: number): number {
  return speed === 0 ? 1 : speed
}

/**
 * How long a clip occupies the finished film, in seconds.
 * @param clip - the clip's source span and playback rate.
 * @returns Output seconds, after the playback rate is applied.
 */
export function outputSecondsOf(clip: ClipSpan): number {
  return (clip.end_us - clip.start_us) / 1e6 / rateOf(clip.speed)
}

/**
 * Where every clip sits on the recording's own axis.
 *
 * **The timeline's axis is the recording, not the film.** Each clip is drawn at the stretch of the
 * source it actually uses, so a click anywhere on the axis names a moment of the video the player
 * is showing — the ruler, the clips and the playhead all mean the same thing. The gaps between
 * clips are the parts of the recording this cut leaves out, which is information an editor wants
 * and cannot get from a packed film axis.
 *
 * An earlier version packed the clips end to end on the film's axis. That put two time systems on
 * one screen: clicking the axis at 40 seconds moved the player to 40 seconds of the recording,
 * which is a different moment entirely — the reported error. Dropping the second axis removes the
 * class of mistake rather than this instance of it.
 *
 * @param clips - the clips in output order.
 * @returns Each clip's position in recording seconds, aligned with the input order.
 */
export function layoutOnSourceAxis(clips: readonly ClipSpan[]): { readonly start: number, readonly end: number }[] {
  return clips.map(clip => ({ start: clip.start_us / 1e6, end: clip.end_us / 1e6 }))
}

/**
 * How long the finished film runs, with the playback rate applied.
 * @param clips - the clips in output order.
 * @returns Output seconds.
 */
export function filmSecondsOf(clips: readonly ClipSpan[]): number {
  return clips.reduce((sum, clip) => sum + outputSecondsOf(clip), 0)
}

/**
 * Where every clip sits on the output axis, laid end to end.
 *
 * Still needed for the film's own clock — the exported length, and the subtitle cue times a burn
 * writes — but no longer for the editor's axis.
 *
 * @param clips - the clips in output order.
 * @returns Each clip's output start and end in seconds, aligned with the input order.
 */
export function layoutOnOutputAxis(clips: readonly ClipSpan[]): { readonly start: number, readonly end: number }[] {
  let cursor = 0
  return clips.map(clip => {
    const length = outputSecondsOf(clip)
    const span = { start: cursor, end: cursor + length }
    cursor += length
    return span
  })
}

/**
 * Read an edge drag's new length as a movement in recording time.
 *
 * On the recording's axis a drag of a second is a second of footage, whatever the clip's playback
 * rate: the ruler the person is reading is the recording. That is the opposite of the film axis,
 * where a second of film is `speed` seconds of recording and the conversion had to multiply.
 *
 * @param before - the clip's length on the axis before the edit, in seconds.
 * @param after - the clip's length on the axis after the edit, in seconds.
 * @returns The recording-time movement in microseconds, or null when the edit is below one frame.
 */
export function trimDeltaFromAxis(before: number, after: number): number | null {
  const delta = after - before
  // 小于一帧（按 30fps 取 1/30 秒）就不算一次编辑；否则每次点击都会产生一次空调用。
  if (Math.abs(delta) < 1 / 30) return null
  return Math.round(delta * 1e6)
}
