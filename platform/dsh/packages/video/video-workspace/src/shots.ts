/**
 * Shot boundary detection and pacing, computed locally.
 *
 * A shot list answers two questions the analysis text cannot: how fast the video is
 * cut (pacing, which correlates with how "tight" a passage feels) and where a clip may
 * begin without landing mid-sentence (editorial snapping). Both are derived from
 * ffmpeg's scene score, so this needs no extra process or model call.
 *
 * The score ffmpeg reports is the fraction of the frame that changed, so a cut appears
 * as a spike. Thresholds are relative to the scores actually seen: a handheld vlog and
 * a screen recording have very different baselines, and one fixed number would either
 * miss cuts in the first or invent them in the second.
 */

/** One continuous camera take. */
export interface Shot {
  index: number
  startUs: number
  endUs: number
  /** Seconds of screen time, which is the shot's own length rather than a position. */
  seconds: number
}

/** Shot list plus the pacing measures derived from it. */
export interface ShotSummary {
  shots: Shot[]
  /** Median shot length: the typical cut rate, robust to one very long take. */
  medianSeconds: number
  /** Shots per minute over the analysed span. */
  cutsPerMinute: number
  /** Window length used for the pacing curve. */
  windowUs: number
  /** Cuts per window, in order; a high value means a tightly cut passage. */
  cutsPerWindow: number[]
  /** Windows with the most cuts, loudest passage first. */
  busiest: Array<{ startUs: number, endUs: number, cuts: number }>
}

/**
 * Known offsets of scene changes, from ffmpeg's metadata output.
 *
 * `showinfo` prints one line per frame with `pts_time`; only frames the scene filter
 * selected reach this output, so every line is a detected change. Only the timestamps
 * matter here, and duplicate positions are collapsed.
 *
 * @param stdout - combined ffmpeg output carrying `showinfo` lines.
 * @returns Distinct change positions in microseconds, ascending.
 */
export function parseSceneTimes(stdout: string): number[] {
  const times = new Set<number>()
  for (const line of stdout.split('\n')) {
    const match = /pts_time:([0-9.]+)/.exec(line)
    if (match === null) continue
    const seconds = Number(match[1])
    if (Number.isFinite(seconds)) times.add(Math.round(seconds * 1_000_000))
  }
  return [...times].sort((a, b) => a - b)
}

/**
 * Build the shot list from cut timestamps.
 *
 * A cut is only honoured when it sits at least `minShotUs` after the previous one: two
 * frames flagged in a row are a flash or a fast pan, not two shots, and keeping them
 * would produce shots too short to cut on.
 *
 * @param cutTimesUs - detected change positions, ascending.
 * @param durationUs - asset length, used to close the final shot.
 * @param minShotUs - shortest shot worth reporting.
 * @returns Shots in time order, together covering the whole asset.
 */
export function buildShots(cutTimesUs: number[], durationUs: number, minShotUs: number): Shot[] {
  const boundaries: number[] = []
  for (const time of cutTimesUs) {
    if (time <= 0 || time >= durationUs) continue
    const previous = boundaries[boundaries.length - 1] ?? 0
    if (time - previous < minShotUs) continue
    boundaries.push(time)
  }
  const starts = [0, ...boundaries]
  return starts.map((startUs, index) => {
    const endUs = starts[index + 1] ?? durationUs
    return { index, startUs, endUs, seconds: Math.round(((endUs - startUs) / 1_000_000) * 10) / 10 }
  }).filter(shot => shot.endUs > shot.startUs)
}

/**
 * Pacing measures over a shot list.
 *
 * @param shots - the shot list, in time order.
 * @param durationUs - asset length, used for the per-minute cut rate and the last window.
 * @param windowUs - window length for the pacing curve.
 * @param busyLimit - how many busiest windows to list.
 * @returns The shot list plus the pacing measures derived from it.
 */
export function summarizeShots(shots: Shot[], durationUs: number, windowUs: number, busyLimit: number): ShotSummary {
  const lengths = shots.map(shot => shot.seconds).sort((a, b) => a - b)
  const medianSeconds = lengths.length === 0 ? 0 : (lengths[Math.floor(lengths.length / 2)] ?? 0)
  const spanSeconds = durationUs / 1_000_000
  const cutsPerMinute = spanSeconds <= 0 ? 0 : Math.round(((Math.max(0, shots.length - 1)) / spanSeconds) * 60 * 10) / 10
  const windowCount = windowUs <= 0 ? 0 : Math.ceil(durationUs / windowUs)
  const cutsPerWindow = new Array<number>(windowCount).fill(0)
  // A cut belongs to the window its new shot starts in.
  for (const shot of shots.slice(1)) {
    const index = Math.min(windowCount - 1, Math.floor(shot.startUs / windowUs))
    if (index >= 0) cutsPerWindow[index] = (cutsPerWindow[index] ?? 0) + 1
  }
  const busiest = cutsPerWindow
    .map((cuts, index) => ({ startUs: index * windowUs, endUs: Math.min(durationUs, (index + 1) * windowUs), cuts }))
    .filter(entry => entry.cuts > 0)
    .sort((a, b) => b.cuts - a.cuts)
    .slice(0, Math.max(0, busyLimit))
  return { shots, medianSeconds, cutsPerMinute, windowUs, cutsPerWindow, busiest }
}

/**
 * Move a time to the nearest shot boundary within `toleranceUs`.
 *
 * Cutting exactly where the model asked lands mid-shot when the request came from a
 * transcript timestamp or an estimate, and a clip that opens mid-sentence reads as a
 * mistake. Snapping to the boundary the editor would have used keeps the clip legible;
 * moving further than the tolerance is refused because then the time is not near a cut.
 *
 * @param timeUs - the requested position.
 * @param shots - the shot list to snap against.
 * @param toleranceUs - furthest the position may move and still count as snapped.
 * @returns The chosen position and whether it moved.
 */
export function snapToShot(timeUs: number, shots: Shot[], toleranceUs: number): { timeUs: number, snapped: boolean, movedUs: number } {
  if (shots.length === 0) return { timeUs, snapped: false, movedUs: 0 }
  let best: number | undefined
  for (const shot of shots) {
    for (const boundary of [shot.startUs, shot.endUs]) {
      if (best === undefined || Math.abs(boundary - timeUs) < Math.abs(best - timeUs)) best = boundary
    }
  }
  if (best === undefined) return { timeUs, snapped: false, movedUs: 0 }
  const movedUs = best - timeUs
  if (Math.abs(movedUs) > toleranceUs) return { timeUs, snapped: false, movedUs: 0 }
  return { timeUs: best, snapped: movedUs !== 0, movedUs }
}
