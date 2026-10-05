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
 * Where every clip sits on the output axis, laid end to end.
 *
 * The editor's axis is the film, not the recording. Drawing source positions on it would
 * scatter ten clips across 2584 seconds when the film is 86 seconds long — which is exactly
 * what an earlier version of this surface did, and why every clip collapsed into a hairline
 * at the right edge.
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
 * Translate an editor edit into a source-time movement.
 *
 * Both times are given so a caller cannot accidentally pass one where the other belongs: the
 * function's whole job is to relate them, so it asks for both explicitly rather than taking a
 * difference that is only meaningful in one of them.
 *
 * @param clip - the clip as it stands, in source time.
 * @param outputBefore - the clip's output length before the edit, in seconds.
 * @param outputAfter - the clip's output length after the edit, in seconds.
 * @returns The source-time movement in microseconds, or null when the edit is below one frame.
 */
export function trimDeltaFromOutput(clip: ClipSpan, outputBefore: number, outputAfter: number): number | null {
  const deltaOutput = outputAfter - outputBefore
  // 小于一帧（按 30fps 取 1/30 秒）就不算一次编辑；否则每次点击都会产生一次空调用。
  if (Math.abs(deltaOutput) < 1 / 30) return null
  // 成片位移换算回素材位移要乘倍率：2 倍速下成片里 1 秒是素材里 2 秒。
  return Math.round(deltaOutput * rateOf(clip.speed) * 1e6)
}
