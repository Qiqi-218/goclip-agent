/**
 * Read the measured dimensions the workbench draws.
 *
 * The workbench is a root-scoped central panel, so it holds no Session binding and
 * cannot read tool results the way a Session-scoped panel does. It therefore asks
 * the host over the media route, addressed by project and asset.
 *
 * A dimension that was never measured answers 404, which is a different fact from an
 * empty curve: it tells the caller to offer to compute the evidence rather than to
 * draw nothing. That distinction is preserved here instead of being flattened into
 * an empty result.
 */

/** The loudness curve as the host serialises it. */
export interface LoudnessPayload {
  /** Asset duration in microseconds; sample positions are shares of it. */
  readonly duration_us: number
  /** One reading per measurement window, in time order. */
  readonly samples: readonly { readonly at: number, readonly db: number }[]
  /** Quietest measured level, or null when the measurement did not record it. */
  readonly floor_dbfs: number | null
  /** Loudest measured level, or null when the measurement did not record it. */
  readonly peak_dbfs: number | null
  /** Perceived-level average, or null when the measurement did not record it. */
  readonly loud_dbfs: number | null
  /** Where the audio track ends as a share of the asset. */
  readonly audio_end_at: number
}

/** One clip of a timeline, positioned in asset time and as a share of the asset. */
export interface TimelineClip {
  /** Position in the timeline, from zero. */
  readonly ordinal: number
  /** Start in asset microseconds. */
  readonly start_us: number
  /** End in asset microseconds. */
  readonly end_us: number
  /** Start as a share of the asset. */
  readonly start: number
  /** End as a share of the asset. */
  readonly end: number
  /** Playback rate; a value other than 1 changes how long the clip occupies on output. */
  readonly speed: number
  /** Whether the clip's audio is dropped. */
  readonly muted: boolean
  /**
   * What a person called this clip, or null when nobody named it.
   *
   * Null rather than a generated label, because the surface has to tell "somebody called this
   * shot 开场" from "this is the third clip" — the two read differently and only one of them is
   * worth showing above the times.
   */
  readonly name: string | null
}

/**
 * How a timeline's subtitles are drawn.
 *
 * Every field is optional here even though the host stores all of them: this type describes what
 * arrives over the wire, and the host fills the gaps with its own defaults at burn time. Declaring
 * them all required would make the browser invent values the host never sent, and the two copies
 * would drift.
 */
export interface SubtitleStyle {
  /** Font family the burn asks libass for. */
  readonly font?: string
  /** Text height as a share of the picture height. */
  readonly size?: number
  /** Weight. */
  readonly bold?: boolean
  /** Slant. */
  readonly italic?: boolean
  /** Text colour, `#rrggbb`. */
  readonly color?: string
  /** Outline colour, `#rrggbb`. */
  readonly outlineColor?: string
  /** Outline thickness as a share of the text height. */
  readonly outlineWidth?: number
  /** Nine-grid position. */
  readonly alignment?: string
  /** Distance from the nearest horizontal edge, as a share of the picture height. */
  readonly marginVertical?: number
  /** Distance from the nearest vertical edge, as a share of the picture width. */
  readonly marginHorizontal?: number
  /** Box colour, or null for no box. */
  readonly backgroundColor?: string | null
  /** Box opacity. */
  readonly backgroundOpacity?: number
  /** Which evidence the words come from. */
  readonly source?: string
}

/** One timeline, with the clips that make it up. */
export interface Timeline {
  /** Stable id. */
  readonly id: string
  /** Display name, or null when it was never named. */
  readonly name: string | null
  /** Revision counter, incremented per accepted edit. */
  readonly revision: number
  /** The ordered clips. */
  readonly clips: readonly TimelineClip[]
  /** Finished length of this edit in seconds, already adjusted for playback rate. */
  readonly output_seconds: number
  /**
   * The subtitle style stored on this timeline, or null when none was ever set.
   *
   * Null is not the same as the burn's defaults: the surface says "no style chosen yet" rather than
   * presenting a default as if somebody had picked it.
   */
  readonly subtitle_style: SubtitleStyle | null
}

/** The timelines cut from one asset. */
export interface TimelinesPayload {
  /** Asset duration in microseconds; clip positions are shares of it. */
  readonly duration_us: number
  /** Every timeline on the asset, oldest first. */
  readonly timelines: readonly Timeline[]
}

/** One finished film. */
/** One step of a render, as the host timed it. */
export interface RenderStage {
  /** What the step did, in the host's own words. */
  readonly stage: string
  /** How long it took, in milliseconds. */
  readonly ms: number
  /** Whether it finished or threw; absent on entries recorded before the host kept this. */
  readonly outcome?: 'ok' | 'failed'
  /** Why it failed, present only on a failed entry. */
  readonly reason?: string
  /** True when the step was skipped because an earlier run already produced its result. */
  readonly skipped?: boolean
}

/** One render attempt. */
export interface Render {
  /** Job that produced it. */
  readonly job_id: string
  /** Last reported job status. */
  readonly status: string
  /** Timeline it was rendered from. */
  readonly timeline_id: string
  /** That timeline's name, or null when it was never named. */
  readonly timeline_name: string | null
  /**
   * Read-only route address to play it from, or null when there is nothing to play.
   *
   * Null for an attempt that failed or is still running. Reporting those attempts at all is the
   * point: a render that died during the burn is what somebody needs to see, and a list that omits
   * it reports "no films" for a timeline that has been rendered three times.
   */
  readonly url: string | null
  /** A sentence about the attempt: what it did, or what went wrong. */
  readonly note: string | null
  /** The step a failed attempt died at, or null when it did not fail or the host did not say. */
  readonly failed_stage: string | null
  /** The steps that ran, in order. */
  readonly stages: readonly RenderStage[]
}

/** The finished films rendered from one asset. */
export interface RendersPayload {
  /** Every render, newest first. */
  readonly renders: readonly Render[]
}

/** What one read produced. */
export type Read<T> =
  | { readonly status: 'ok', readonly value: T }
  /** The product has this dimension but the asset has nothing in it. */
  | { readonly status: 'absent' }
  /** The asset is unknown, or the host could not be reached. */
  | { readonly status: 'failed' }

/** Route prefix shared with the host plugin's `mediaRoutePrefix` default. */
const DEFAULT_PREFIX = '/goclip-media'

/** The two ids that identify one asset. */
export interface WorkbenchAsset {
  /** Project the asset belongs to. */
  readonly projectId: string
  /** Asset to draw and play. */
  readonly assetId: string
}

/**
 * The read-only route address of one asset's bytes.
 * @param asset - the asset to address.
 * @returns The path a `<video>` element can be given.
 */
export function mediaUrl(asset: WorkbenchAsset): string {
  return `${DEFAULT_PREFIX}/${encodeURIComponent(asset.projectId)}/${encodeURIComponent(asset.assetId)}`
}

/**
 * Read which asset the workbench should show from the page address.
 *
 * The panel is registered into a keyed slot whose owner passes no props, so it has no
 * asset handed to it and must discover one. The address is where a caller can put it
 * without this package reaching for another plugin's state.
 *
 * It reads the **fragment**, not the query string, and that is not a style choice:
 * the host's token sign-in answers with `303 See Other` to `./`, which drops the whole
 * query string before the browser ever runs. Measured on a live server — a link
 * carrying `?project=…&asset=…` arrives as a bare `/`, so the workbench came up with
 * nothing selected. A fragment is never sent to the server, so no redirect can remove
 * it. The query string is still read as a fallback for a deployment whose sign-in does
 * not redirect.
 *
 * @param hash - the page's fragment, with or without its leading `#`.
 * @param search - the page's query string, with or without its leading `?`.
 * @returns The named asset, or null when neither names one.
 */
export function assetFromAddress(hash: string, search: string): WorkbenchAsset | null {
  for (const source of [hash.replace(/^#/, ''), search.replace(/^\?/, '')]) {
    const params = new URLSearchParams(source)
    const projectId = params.get('project')
    const assetId = params.get('asset')
    if (projectId !== null && projectId !== '' && assetId !== null && assetId !== '') {
      return { projectId, assetId }
    }
  }
  return null
}

/** One stretch of the recording with whatever was measured over it. */
export interface EvidenceSpan {
  /** Start in asset microseconds. */
  readonly start_us: number
  /** End in asset microseconds. */
  readonly end_us: number
}

/** One line of speech or on-screen text. */
export interface EvidenceText extends EvidenceSpan {
  /** What was said or shown. */
  readonly text: string
}

/**
 * Every measured dimension for one asset, as the host normalises them.
 *
 * The host is what reconciles the three field conventions the measurers used (`levelsDbfs` with a
 * window, `startUs`/`endUs`, `start_us`/`end_us`); by the time a track arrives here its spans are
 * all `start_us`/`end_us`. A dimension that was never measured is **absent** rather than empty, so
 * the surface can tell "not measured" apart from "measured and found nothing".
 */
export interface EvidencePayload {
  /** Asset duration in microseconds. */
  readonly duration_us: number
  /** The measured dimensions; a missing key means that dimension was never measured. */
  readonly tracks: {
    /** One reading per window of the recording. */
    readonly loudness?: {
      readonly window_us: number
      readonly levels_dbfs: readonly number[]
      readonly floor_dbfs: number | null
      readonly peak_dbfs: number | null
      readonly loud_spans: readonly EvidenceSpan[]
    }
    /** Speech, verbatim, so a phrase can be located exactly. */
    readonly transcript?: readonly EvidenceText[]
    /** Text visible in the picture, verbatim. */
    readonly screen_text?: readonly EvidenceText[]
    /** Camera cuts. */
    readonly shots?: readonly (EvidenceSpan & { readonly index: number })[]
    /** Stretches with no speech. */
    readonly silences?: readonly EvidenceSpan[]
    /** What the picture shows, per stretch. */
    readonly scenes?: readonly (EvidenceSpan & { readonly description: string })[]
    /**
     * Every stretch the analysis described, in order.
     *
     * The superset of `highlights`: chapters answer "what is this film about, section by section"
     * while highlights answer "which parts are worth cutting out". Both come from the same analysed
     * segments, so drawing only one of them leaves the other question unanswerable.
     */
    readonly chapters?: readonly (EvidenceSpan & { readonly summary: string, readonly is_highlight: boolean })[]
    /** Stretches the analysis marked as worth cutting out on their own. */
    readonly highlights?: readonly (EvidenceSpan & { readonly reason: string | null })[]
  }
}

/**
 * Read every measured dimension of one asset.
 * @param asset - the asset to read.
 * @param signal - aborted when the reader unmounts or the asset changes.
 * @returns The tracks, or which kind of nothing happened.
 */
export function readEvidence(asset: WorkbenchAsset, signal: AbortSignal): Promise<Read<EvidencePayload>> {
  return read<EvidencePayload>(asset, 'evidence', signal)
}

/**
 * One recorded revision of a timeline.
 *
 * Only the summary is read, not the clips: the panel's job is to let somebody pick which state to
 * go back to, and a list of ten revisions each carrying its whole clip list would be a large
 * answer for a question that is "which one was it".
 */
export interface RevisionEntry {
  /** The revision number to pass back when restoring it. */
  readonly revision: number
  /** How many clips that revision held. */
  readonly segment_count: number
  /** What the edit did, or null when it was not recorded. */
  readonly note: string | null
  /** When it was recorded, in milliseconds since the epoch. */
  readonly at: number
}

/** The revisions recorded for one timeline. */
export interface HistoryPayload {
  /** Timeline these belong to. */
  readonly timeline_id: string
  /** Revisions, newest first. */
  readonly entries: readonly RevisionEntry[]
  /** What to do with them, or why there are none. */
  readonly note: string | null
}

/**
 * Read a timeline's recorded revisions.
 * @param asset - the asset the timeline belongs to.
 * @param timelineId - which timeline; one asset can carry several.
 * @param signal - aborted when the reader unmounts or the asset changes.
 * @returns The revisions, or which kind of nothing happened.
 */
export function readHistory(asset: WorkbenchAsset, timelineId: string, signal: AbortSignal): Promise<Read<HistoryPayload>> {
  return read<HistoryPayload>(asset, 'history', signal, timelineId)
}

/**
 * Read one dimension of one asset.
 *
 * A dimension that was never measured answers 404, which is a different fact from an
 * empty result: it tells the caller to offer to compute the evidence rather than to draw
 * nothing. That distinction is preserved instead of being flattened into an empty value.
 *
 * @param asset - the asset to read.
 * @param dimension - which reader to use, as the route names it.
 * @param signal - aborted when the reader unmounts or the asset changes.
 * @returns The dimension's value, or which kind of nothing happened.
 */
async function read<T>(asset: WorkbenchAsset, dimension: string, signal: AbortSignal, extraPath?: string): Promise<Read<T>> {
  // 维度是最后一段，所以额外的一段（例如时间线 id）要插在维度**之前**。
  const between = extraPath === undefined ? '' : `/${encodeURIComponent(extraPath)}`
  const url = `${DEFAULT_PREFIX}/data/${encodeURIComponent(asset.projectId)}/${encodeURIComponent(asset.assetId)}${between}/${dimension}`
  let response: Response
  try {
    response = await fetch(url, { signal })
  } catch {
    // An aborted read is the ordinary way a reader leaves; it is not a failure to show.
    return signal.aborted ? { status: 'absent' } : { status: 'failed' }
  }
  if (response.status === 404) return { status: 'absent' }
  if (!response.ok) return { status: 'failed' }
  return { status: 'ok', value: await response.json() as T }
}

/**
 * Read one asset's loudness curve.
 * @param asset - the asset to read.
 * @param signal - aborted when the reader unmounts or the asset changes.
 * @returns The curve, or which kind of nothing happened.
 */
export function readLoudness(asset: WorkbenchAsset, signal: AbortSignal): Promise<Read<LoudnessPayload>> {
  return read<LoudnessPayload>(asset, 'loudness', signal)
}

/**
 * Read the timelines cut from one asset.
 * @param asset - the asset to read.
 * @param signal - aborted when the reader unmounts or the asset changes.
 * @returns The timelines, or which kind of nothing happened.
 */
export function readTimelines(asset: WorkbenchAsset, signal: AbortSignal): Promise<Read<TimelinesPayload>> {
  return read<TimelinesPayload>(asset, 'timelines', signal)
}

/**
 * Read the finished films rendered from one asset.
 * @param asset - the asset to read.
 * @param signal - aborted when the reader unmounts or the asset changes.
 * @returns The renders, or which kind of nothing happened.
 */
export function readRenders(asset: WorkbenchAsset, signal: AbortSignal): Promise<Read<RendersPayload>> {
  return read<RendersPayload>(asset, 'renders', signal)
}
