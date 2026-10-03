/**
 * Acoustic evidence: how loud each second of an asset is.
 *
 * Loudness is the one signal that makes "精彩" measurable rather than a matter of
 * opinion: laughter, applause, a music sting and a raised voice all show up as the
 * same physical event. It is computed locally by decoding the audio to raw PCM and
 * taking the RMS of each window, because no cloud API exposes a per-second loudness
 * curve and ffmpeg's own per-window reporting is unreliable across builds.
 *
 * Only the standard library and ffmpeg are involved, so this costs nothing to run and
 * needs no credentials.
 */

/** Loudness across one asset, plus the shape derived from it. */
export interface LoudnessCurve {
  /** Decibels relative to full scale for each window, in order from the start. */
  levelsDbfs: number[]
  /** Window length in microseconds; `levelsDbfs[i]` covers `[i*window, (i+1)*window)`. */
  windowUs: number
  /** Quietest window, which is the noise floor this recording actually has. */
  floorDbfs: number
  /** Loudest window. */
  peakDbfs: number
  /** Loudness a window must exceed to count as clearly louder than the rest. */
  loudDbfs: number
  /** Loudness below which a window counts as quiet. */
  quietDbfs: number
  /** Windows ranked loudest first, capped by the caller. */
  peaks: LoudnessPeak[]
}

/** One window that stands out from the recording's own floor. */
export interface LoudnessPeak {
  index: number
  startUs: number
  endUs: number
  dbfs: number
  /** How far above the floor, which is what makes a peak noticeable in context. */
  riseDb: number
}

/** Bytes per sample: the PCM we ask ffmpeg for is signed 16-bit. */
const BYTES_PER_SAMPLE = 2

/**
 * Decibels relative to full scale for one window of signed 16-bit samples.
 *
 * Digital silence would be negative infinity, so it is reported as a fixed floor
 * instead: a real recording never reaches it, and `-Infinity` cannot be serialized
 * into the JSON that carries the curve to the model.
 *
 * @param samples - one window of samples, normalized against the full 16-bit range.
 * @returns Loudness in dBFS, never below {@link SILENCE_DBFS}.
 */
export function windowDbfs(samples: Int16Array): number {
  if (samples.length === 0) return SILENCE_DBFS
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) {
    const value = (samples[i] ?? 0) / 32768
    sumSquares += value * value
  }
  const rms = Math.sqrt(sumSquares / samples.length)
  if (rms <= 0) return SILENCE_DBFS
  return Math.max(SILENCE_DBFS, 20 * Math.log10(rms))
}

/** Floor reported for digital silence; below any real recording's noise floor. */
export const SILENCE_DBFS = -100

/**
 * Turn raw little-endian signed 16-bit PCM into one loudness value per window.
 *
 * @param pcm - the decoded samples.
 * @param windowUs - window length; the last, partial window is dropped because a
 * short window always reads quieter and would look like a dip at the end.
 * @param sampleRate - sample rate of `pcm`, used to size each window.
 * @returns One dBFS value per complete window, in time order.
 */
export function curveFromPcm(pcm: Buffer, windowUs: number, sampleRate: number): number[] {
  const sampleCount = Math.floor(pcm.length / BYTES_PER_SAMPLE)
  const perWindow = Math.max(1, Math.round((windowUs / 1_000_000) * sampleRate))
  const levels: number[] = []
  for (let start = 0; start + perWindow <= sampleCount; start += perWindow) {
    const samples = new Int16Array(perWindow)
    for (let i = 0; i < perWindow; i++) samples[i] = pcm.readInt16LE((start + i) * BYTES_PER_SAMPLE)
    levels.push(round(windowDbfs(samples)))
  }
  return levels
}

/**
 * Summarise a loudness series into the shape a caller needs.
 *
 * The thresholds come from the recording itself rather than fixed decibel values: a
 * quiet interview and a noisy street have different floors, and "loud" only means
 * something relative to what the rest of this asset sounds like.
 *
 * @param levelsDbfs - one value per window, in order.
 * @param windowUs - window length, used to place each peak on the timeline.
 * @param peakLimit - how many peaks to keep; the rest are dropped, not summarised.
 * @returns The loudness series, its thresholds, and the loudest windows.
 */
export function summarize(levelsDbfs: number[], windowUs: number, peakLimit: number): LoudnessCurve {
  if (levelsDbfs.length === 0) {
    return { levelsDbfs: [], windowUs, floorDbfs: SILENCE_DBFS, peakDbfs: SILENCE_DBFS, loudDbfs: SILENCE_DBFS, quietDbfs: SILENCE_DBFS, peaks: [] }
  }
  const sorted = [...levelsDbfs].sort((a, b) => a - b)
  // An empty series is rejected above, so every percentile below has a value; `?? SILENCE_DBFS`
  // states that for the reader rather than relying on the reader to trace the guard.
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? SILENCE_DBFS
  const floorDbfs = at(0.05)
  const peakDbfs = sorted[sorted.length - 1] ?? SILENCE_DBFS
  // 90th percentile marks "clearly louder than most of this recording"; the floor plus
  // a fixed margin is too sensitive on a recording that is loud throughout.
  const loudDbfs = at(0.9)
  const quietDbfs = at(0.25)
  const peaks: LoudnessPeak[] = levelsDbfs
    .map((dbfs, index) => ({ index, dbfs, riseDb: round(dbfs - floorDbfs) }))
    .sort((a, b) => b.dbfs - a.dbfs)
    .slice(0, Math.max(0, peakLimit))
    .map(entry => ({ index: entry.index, startUs: entry.index * windowUs, endUs: (entry.index + 1) * windowUs, dbfs: entry.dbfs, riseDb: entry.riseDb }))
  return { levelsDbfs, windowUs, floorDbfs: round(floorDbfs), peakDbfs: round(peakDbfs), loudDbfs: round(loudDbfs), quietDbfs: round(quietDbfs), peaks }
}

/**
 * Group consecutive loud windows into spans, so a peak reads as a moment not a tick.
 *
 * @param curve - a summarised loudness series.
 * @param minWindows - shortest run that counts as a moment rather than a tick.
 * @returns Spans ranked loudest first.
 */
export function loudSpans(curve: LoudnessCurve, minWindows = 2): Array<{ startUs: number, endUs: number, peakDbfs: number }> {
  const spans: Array<{ startUs: number, endUs: number, peakDbfs: number }> = []
  let start = -1
  let peak = SILENCE_DBFS
  const close = (end: number): void => {
    if (start < 0) return
    if (end - start >= minWindows) spans.push({ startUs: start * curve.windowUs, endUs: end * curve.windowUs, peakDbfs: round(peak) })
    start = -1
    peak = SILENCE_DBFS
  }
  curve.levelsDbfs.forEach((dbfs, index) => {
    if (dbfs >= curve.loudDbfs) {
      if (start < 0) start = index
      peak = Math.max(peak, dbfs)
      return
    }
    close(index)
  })
  close(curve.levelsDbfs.length)
  return spans.sort((a, b) => b.peakDbfs - a.peakDbfs)
}

/** Round to one decimal: more precision than a decibel reading deserves. */
function round(value: number): number { return Math.round(value * 10) / 10 }
