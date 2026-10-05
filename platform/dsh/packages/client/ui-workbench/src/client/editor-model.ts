/**
 * Translate a timeline into the editor's rows and actions, and edits back into tool arguments.
 *
 * The editor is a view over `timeline_segments`; it owns no editing state of its own. That is
 * the decision the plan rests on — "对话修改、手动拖动和最终渲染始终基于同一份时间线" — so this
 * module is the only place the two representations meet.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not write.** A drag produces the tool call that would make the change; sending it
 *   is the caller's business. Keeping the translation pure is what makes it testable without a
 *   server, and it is what lets the surface mark a pending edit instead of pretending the
 *   change already landed.
 * - **It does not reorder.** The editor can drag an action along the output axis, but moving a
 *   clip to a different *position in the film* is a different operation with its own tool
 *   (`reorderSegment`). Reading a reorder out of a horizontal drag would guess at intent, so a
 *   drag is read as a change of length only.
 */
import type { TimelineAction, TimelineRow } from '@xzdarcy/timeline-engine'
import type { ClipSpan } from './timing.ts'
import { layoutOnOutputAxis, outputSecondsOf, rateOf, trimDeltaFromOutput } from './timing.ts'

/** One clip as the media route serialises it, plus the asset bounds its edits are limited by. */
export interface EditableClip extends ClipSpan {
  /** Position in the timeline, from zero. */
  readonly ordinal: number
}

/** Every clip the editor needs to know about, and the recording they were cut from. */
export interface EditSubject {
  /** The clips in output order. */
  readonly clips: readonly EditableClip[]
  /** Length of the source recording in microseconds; edits cannot reach past it. */
  readonly assetDurationUs: number
}

/** The effect id every clip action carries; the editor requires one per action. */
export const CLIP_EFFECT = 'clip'

/** Row id for the single lane the clips live on. */
const CLIP_ROW = 'clips'

/** The editor action id for one clip, from which the clip's ordinal can be read back. */
function actionIdOf(ordinal: number): string {
  return `clip-${ordinal}`
}

/**
 * Read a clip's ordinal back out of an action id.
 *
 * Read from the id rather than from a position in an array: the editor reorders and filters its
 * own actions, so an index into the input list is not the clip the callback is talking about.
 * Passing the wrong clip to the conversion produced a plausible-looking but wrong instruction
 * during verification.
 *
 * @param id - the action id the editor reported.
 * @returns The clip ordinal, or null when the id was not minted here.
 */
export function ordinalOfAction(id: string): number | null {
  if (!id.startsWith('clip-')) return null
  const ordinal = Number(id.slice('clip-'.length))
  return Number.isInteger(ordinal) ? ordinal : null
}

/**
 * Build the editor's rows for a timeline.
 *
 * Actions are laid out on the **output** axis, end to end, with `minStart` and `maxEnd` derived
 * from the source material available on each side of the clip. Bounding them here is what stops
 * a drag from asking for material the recording does not contain: the editor would otherwise
 * happily report a clip running past the end of the asset.
 *
 * @param subject - the clips and the recording they came from.
 * @returns One row holding every clip.
 */
export function toRows(subject: EditSubject): TimelineRow[] {
  const spans = layoutOnOutputAxis(subject.clips)
  const actions: TimelineAction[] = subject.clips.map((clip, index) => {
    const span = spans[index] as { start: number, end: number }
    const rate = rateOf(clip.speed)
    // 左边能用掉多少素材、右边还剩多少素材 —— 都换算到成片坐标，才能作为轴上的边界。
    const outputBefore = clip.start_us / 1e6 / rate
    const outputAfter = (subject.assetDurationUs - clip.end_us) / 1e6 / rate
    return {
      id: actionIdOf(clip.ordinal),
      start: span.start,
      end: span.end,
      effectId: CLIP_EFFECT,
      flexible: true,
      movable: false,
      // 往左拖最多到「本段起点之前的素材用完」为止；0 是成片轴的起点。
      minStart: Math.max(0, span.start - outputBefore),
      // 往右拖最多到「素材结尾」为止。
      maxEnd: span.end + outputAfter,
    }
  })
  return [{ id: CLIP_ROW, actions, rowHeight: 46 }]
}

/**
 * A tool call that would carry out one change the person asked for.
 *
 * A discriminated union rather than a looser `{ tool: string, args: object }`: the argument
 * objects differ per tool, and a caller that reads `args.edge` off a revert — or renders an
 * instruction the tool cannot carry out — is a mistake the compiler should catch rather than the
 * host.
 */
export type EditIntent = TrimIntent | RevertIntent | SplitIntent | MergeIntent | RemoveIntent | RenameIntent | ReorderIntent | NameSegmentIntent | AdjustIntent

/** Move one clip to another position in the running order. */
export interface ReorderIntent {
  /** Tool name to invoke. */
  readonly tool: 'video_timeline_reorder'
  /** Arguments for that tool. */
  readonly args: {
    readonly timeline_id: string
    readonly base_revision: number
    /** Position the clip is at now. */
    readonly from: number
    /** Position to move it to. */
    readonly to: number
  }
}

/** Name one clip. */
export interface NameSegmentIntent {
  /** Tool name to invoke. */
  readonly tool: 'video_timeline_name_segment'
  /** Arguments for that tool. */
  readonly args: {
    readonly timeline_id: string
    readonly base_revision: number
    readonly ordinal: number
    /** The name to set; an empty string clears it. */
    readonly name: string
  }
}

/** Shorten or lengthen one clip. */
export interface TrimIntent {
  /** Tool name to invoke. */
  readonly tool: 'video_timeline_trim'
  /** Arguments for that tool. */
  readonly args: {
    readonly timeline_id: string
    readonly base_revision: number
    readonly ordinal: number
    readonly edge: 'start' | 'end'
    readonly delta_us: number
  }
}

/**
 * Cut one clip in two at a moment inside it.
 *
 * The cut point is given in **asset** time, which is what the tool takes. The caller works in film
 * time, so it has to convert — and doing that conversion is exactly where an off-by-one-clip
 * mistake would come from, so it happens here rather than at the call site.
 */
export interface SplitIntent {
  /** Tool name to invoke. */
  readonly tool: 'video_timeline_split'
  /** Arguments for that tool. */
  readonly args: {
    readonly timeline_id: string
    readonly base_revision: number
    readonly ordinal: number
    readonly asset_time_us: number
  }
}

/** Join one clip with the one after it. */
export interface MergeIntent {
  /** Tool name to invoke. */
  readonly tool: 'video_timeline_merge'
  /** Arguments for that tool. */
  readonly args: {
    readonly timeline_id: string
    readonly base_revision: number
    /** The earlier of the two; the host merges it with the clip right after it. */
    readonly ordinal: number
  }
}

/** Drop one clip. */
export interface RemoveIntent {
  /** Tool name to invoke. */
  readonly tool: 'video_timeline_remove'
  /** Arguments for that tool. */
  readonly args: {
    readonly timeline_id: string
    readonly base_revision: number
    readonly ordinal: number
  }
}

/** Name one clip's timeline. */
export interface RenameIntent {
  /** Tool name to invoke. */
  readonly tool: 'video_timeline_rename'
  /** Arguments for that tool. */
  readonly args: {
    readonly timeline_id: string
    readonly name: string
  }
}

/** Change how one clip plays. */
export interface AdjustIntent {
  /** Tool name to invoke. */
  readonly tool: 'video_timeline_adjust'
  /** Arguments for that tool. */
  readonly args: {
    readonly timeline_id: string
    readonly base_revision: number
    readonly ordinal: number
    readonly speed?: number
    readonly muted?: boolean
  }
}

/** Put the timeline back to an earlier revision. */
export interface RevertIntent {
  /** Tool name to invoke. */
  readonly tool: 'video_timeline_revert'
  /** Arguments for that tool. */
  readonly args: {
    readonly timeline_id: string
    /** The revision the caller is looking at — what makes a concurrent edit refusable. */
    readonly base_revision: number
    /** The revision to restore. */
    readonly target_revision: number
  }
}

/**
 * The call that would cut one clip in two at a moment the person picked on the film.
 *
 * The conversion is the whole reason this function exists. The lane reports a position on the
 * **film**; the tool takes a moment in the **recording**. For a clip at 1× those differ by the
 * clip's own start, and at 2× also by the rate — and a cut placed at the wrong moment is invisible
 * until somebody watches the film and notices the shot changed in the middle of a sentence.
 *
 * @param clips - the clips, in output order.
 * @param ordinal - which clip to cut.
 * @param filmSeconds - where on the film the cut goes.
 * @param timelineId - the timeline to edit.
 * @param baseRevision - the revision the caller last read.
 * @returns The call to make, or null when the moment is not inside that clip.
 */
export function splitIntent(
  clips: readonly ClipSpan[],
  ordinal: number,
  filmSeconds: number,
  timelineId: string,
  baseRevision: number,
): SplitIntent | null {
  const index = clips.findIndex(clip => (clip as EditableClip).ordinal === ordinal)
  if (index < 0) return null
  const clip = clips[index] as ClipSpan
  const span = layoutOnOutputAxis(clips)[index] as { start: number, end: number }
  // 落点在片段之外就没有「在这里切开」这回事；不要就近吸附到一个别的片段上。
  if (filmSeconds <= span.start || filmSeconds >= span.end) return null
  const assetUs = Math.round(clip.start_us + (filmSeconds - span.start) * 1e6 * rateOf(clip.speed))
  // 切点落在素材区间之外说明换算错了；宁可什么都不做。
  if (assetUs <= clip.start_us || assetUs >= clip.end_us) return null
  return {
    tool: 'video_timeline_split',
    args: { timeline_id: timelineId, base_revision: baseRevision, ordinal, asset_time_us: assetUs },
  }
}

/**
 * The call that would drop one clip.
 *
 * @param ordinal - which clip to drop.
 * @param timelineId - the timeline to edit.
 * @param baseRevision - the revision the caller last read.
 * @returns The call to make.
 */
export function removeIntent(ordinal: number, timelineId: string, baseRevision: number): RemoveIntent {
  return { tool: 'video_timeline_remove', args: { timeline_id: timelineId, base_revision: baseRevision, ordinal } }
}

/**
 * The call that would change how one clip plays.
 *
 * Only the fields actually being changed are sent. A caller that always sent both would reset a
 * muted clip's audio every time somebody adjusted its speed.
 *
 * @param ordinal - which clip to change.
 * @param change - the fields to change; at least one must be present.
 * @param timelineId - the timeline to edit.
 * @param baseRevision - the revision the caller last read.
 * @returns The call to make, or null when nothing was asked for.
 */
export function adjustIntent(
  ordinal: number,
  change: { readonly speed?: number, readonly muted?: boolean },
  timelineId: string,
  baseRevision: number,
): AdjustIntent | null {
  if (change.speed === undefined && change.muted === undefined) return null
  // 倍率必须是正数：0 会让成片长度除出无穷大，负数会让片段倒放而工具不接受。
  if (change.speed !== undefined && !(change.speed > 0)) return null
  return {
    tool: 'video_timeline_adjust',
    args: {
      timeline_id: timelineId,
      base_revision: baseRevision,
      ordinal,
      ...(change.speed === undefined ? {} : { speed: change.speed }),
      ...(change.muted === undefined ? {} : { muted: change.muted }),
    },
  }
}

/**
 * The call that would name a timeline.
 *
 * Carries **no** revision: the name is not part of what the film is, so the host does not advance
 * the revision for it. Sending one would be harmless but would suggest a check that does not exist.
 *
 * @param timelineId - the timeline to name.
 * @param name - the name to set; an empty string clears it.
 * @returns The call to make.
 */
export function renameIntent(timelineId: string, name: string): RenameIntent {
  return { tool: 'video_timeline_rename', args: { timeline_id: timelineId, name } }
}

/**
 * Whether two neighbouring clips can be merged.
 *
 * Mirrors the host's own preconditions rather than approximating them. The host refuses a merge
 * that would swallow a gap, cross recordings, or combine two different playback settings, so a
 * button offered outside those conditions can only produce an error — and a button that exists and
 * fails teaches the wrong thing about what merging means.
 *
 * The clip list reaching the browser carries no asset id, so "same recording" is the one condition
 * this cannot check. A timeline whose clips come from more than one recording is the case where
 * the button will be offered and then refused, which is why the host's message names the reason.
 *
 * @param first - the earlier clip.
 * @param second - the clip right after it.
 * @returns Whether merging them would be accepted.
 */
export function canMergeWithNext(first: EditableClip, second: EditableClip): boolean {
  return first.speed === second.speed
    && first.muted === second.muted
    // 只有首尾相接才真的是连续的一段；中间有缺口时合并会把缺口也算进成片。
    && first.end_us === second.start_us
}

/**
 * The clip an intent is about, or null when it is not about a clip.
 *
 * A revision restore and a rename act on the timeline, not on one of its clips; every other intent
 * names a clip. Asking the question here keeps callers from switching over tool names to work out
 * whether reading `ordinal` is even allowed.
 *
 * @param intent - the intent to ask about.
 * @returns The clip's ordinal, or null for a timeline-level intent.
 */
export function clipOfIntent(intent: EditIntent): number | null {
  switch (intent.tool) {
    case 'video_timeline_revert':
    case 'video_timeline_rename':
      return null
    // 重排说的是「把第 from 段挪走」，受影响的正是 from 那一段。
    case 'video_timeline_reorder':
      return intent.args.from
    default:
      return intent.args.ordinal
  }
}

/**
 * The call that would restore an earlier revision.
 *
 * Reverting goes through the same channel as a drag rather than writing directly, and for the same
 * reason: the tool carries the revision the person was looking at, so a revert that raced another
 * edit is refused instead of silently discarding it. An undo that can clobber somebody else's work
 * is worse than an undo that takes one more step.
 *
 * @param timelineId - the timeline to restore.
 * @param baseRevision - the revision the caller last read.
 * @param targetRevision - the revision to restore.
 * @returns The call to make.
 */
export function revertIntent(timelineId: string, baseRevision: number, targetRevision: number): RevertIntent {
  return {
    tool: 'video_timeline_revert',
    args: { timeline_id: timelineId, base_revision: baseRevision, target_revision: targetRevision },
  }
}

/**
 * Turn one edited action back into the tool call that makes the change.
 *
 * The edge is decided by comparing each end against where it stood before, rather than by
 * comparing how far each moved: with a clip that both shifted and changed length, "which end
 * moved further" has no answer that matches what the person did.
 *
 * @param subject - the clips as they stood before the drag.
 * @param edited - the action the editor reported after the drag.
 * @param timelineId - timeline the edit belongs to.
 * @param baseRevision - revision the caller last read; the host refuses a stale one.
 * @returns The call to make, or null when the drag did not change the clip's length.
 */
export function intentFromEditedAction(
  subject: EditSubject,
  edited: TimelineAction,
  timelineId: string,
  baseRevision: number,
): EditIntent | null {
  const ordinal = ordinalOfAction(edited.id)
  if (ordinal === null) return null
  const index = subject.clips.findIndex(candidate => candidate.ordinal === ordinal)
  if (index < 0) return null
  const clip = subject.clips[index] as EditableClip
  const before = layoutOnOutputAxis(subject.clips)[index] as { start: number, end: number }

  const deltaSourceUs = trimDeltaFromOutput(clip, outputSecondsOf(clip), edited.end - edited.start)
  if (deltaSourceUs === null) return null

  // 一秒的千分之一以内算没动 —— 浮点位置在拖动里必然有微小的抖动。
  const tolerance = 1e-3
  const startMoved = Math.abs(edited.start - before.start) > tolerance
  if (!startMoved) {
    return {
      tool: 'video_timeline_trim',
      args: { timeline_id: timelineId, base_revision: baseRevision, ordinal, edge: 'end', delta_us: deltaSourceUs },
    }
  }
  // 左边界动了：位移方向与右边界相反 —— 往左拖是「多用前面的素材」，长度变长。
  return {
    tool: 'video_timeline_trim',
    args: { timeline_id: timelineId, base_revision: baseRevision, ordinal, edge: 'start', delta_us: -deltaSourceUs },
  }
}
