// @vitest-environment jsdom
/**
 * The two conversions between our timeline and the editor: the coordinate arithmetic, and the
 * translation of a drag back into a tool call.
 *
 * These are the parts that fail silently. A wrong sign or a missing playback-rate factor still
 * produces a well-formed tool call — it just trims the wrong stretch of the recording — so the
 * cases here are chosen around the places where a plausible-looking answer is wrong:
 *
 * - a clip at 2× occupies half the output time it draws from the recording;
 * - a drag on the **left** edge moves the source range the **opposite** way to the length change;
 * - a drag of zero (or a sub-frame wobble) is not an edit at all.
 *
 * The numbers come from the real timeline: asset 2584.13s, ten clips, 86.21s of film.
 */
import { describe, expect, it } from 'vitest'
import {
  CLIP_EFFECT,
  adjustIntent,
  canMergeWithNext,
  clipOfIntent,
  intentFromEditedAction,
  removeIntent,
  renameIntent,
  revertIntent,
  splitIntent,
  ordinalOfAction,
  toRows,
  type EditableClip,
  type EditSubject,
} from '../src/client/editor-model.ts'
import { layoutOnOutputAxis, outputSecondsOf, rateOf, trimDeltaFromOutput } from '../src/client/timing.ts'

/** Asset length in microseconds, as the media route reports it. */
const ASSET_US = 2_584_133_000

/**
 * Build a clip.
 * @param ordinal - position in the timeline.
 * @param startSeconds - source start, in seconds.
 * @param endSeconds - source end, in seconds.
 * @param speed - playback rate.
 * @returns the clip.
 */
function clip(ordinal: number, startSeconds: number, endSeconds: number, speed = 1): EditableClip {
  return { ordinal, start_us: Math.round(startSeconds * 1e6), end_us: Math.round(endSeconds * 1e6), speed, muted: false }
}

/**
 * The first three clips of the real fast cut.
 *
 * The third one carries `speed: 2`, because that is what the real timeline has and it is the only
 * one of the three that does. Three 1× clips would look like the real data and would let every
 * rate-handling mistake through — which is how the split-point assertion below first failed: the
 * fixture was wrong, not the conversion.
 */
const SUBJECT: EditSubject = {
  clips: [clip(0, 21.74, 29.46), clip(1, 272.49, 276.49), clip(2, 296.58, 302.26, 2)],
  assetDurationUs: ASSET_US,
}

describe('playback rate', () => {
  it('treats a stored zero as no change rather than dividing by it', () => {
    // 存成 0 会让「成片长度 = 素材长度 ÷ 倍率」除出无穷大。
    expect(rateOf(0)).toBe(1)
    expect(rateOf(2)).toBe(2)
  })

  it('halves the output length at double speed', () => {
    // 4 秒素材、2 倍速 → 成片里占 2 秒。倍率漏掉就会算成 4 秒。
    expect(outputSecondsOf(clip(0, 10, 14, 2))).toBeCloseTo(2, 6)
    expect(outputSecondsOf(clip(0, 10, 14, 1))).toBeCloseTo(4, 6)
  })
})

describe('layout on the output axis', () => {
  it('lays clips end to end instead of at their source positions', () => {
    // 素材坐标 21.74 / 272.49 / 296.58 直接当轴坐标用，三段会散在 2584 秒里；
    // 成片轴上是首尾相接的 0 → 7.72 → 11.72 → 17.40。
    const spans = layoutOnOutputAxis(SUBJECT.clips)
    expect(spans[0]?.start).toBeCloseTo(0, 6)
    expect(spans[0]?.end).toBeCloseTo(7.72, 6)
    expect(spans[1]?.start).toBeCloseTo(7.72, 6)
    expect(spans[1]?.end).toBeCloseTo(11.72, 6)
    expect(spans[2]?.start).toBeCloseTo(11.72, 6)
  })

  it('accounts for speed when deciding how much film a clip fills', () => {
    const spans = layoutOnOutputAxis([clip(0, 0, 10, 2), clip(1, 100, 104, 1)])
    expect(spans[0]?.end).toBeCloseTo(5, 6)
    expect(spans[1]?.start).toBeCloseTo(5, 6)
    expect(spans[1]?.end).toBeCloseTo(9, 6)
  })

  it('returns nothing for no clips', () => {
    expect(layoutOnOutputAxis([])).toEqual([])
  })
})

describe('trim delta', () => {
  it('scales an output movement back into the source by the playback rate', () => {
    // 2 倍速下成片里延长 1 秒，等于素材里多取 2 秒 —— 漏掉倍率就只取了一半。
    expect(trimDeltaFromOutput(clip(0, 10, 14, 2), 2, 3)).toBe(2_000_000)
    expect(trimDeltaFromOutput(clip(0, 10, 14, 1), 4, 5)).toBe(1_000_000)
  })

  it('reports a shortening as a negative movement', () => {
    expect(trimDeltaFromOutput(clip(0, 10, 14, 1), 4, 3)).toBe(-1_000_000)
  })

  it('refuses an edit smaller than a frame', () => {
    // 一次点击带来的浮点抖动不该变成一次编辑，否则每次点选都会发出一条工具调用。
    expect(trimDeltaFromOutput(clip(0, 10, 14, 1), 4, 4)).toBeNull()
    expect(trimDeltaFromOutput(clip(0, 10, 14, 1), 4, 4 + 1 / 60)).toBeNull()
  })
})

describe('rows for the editor', () => {
  it('mints one action per clip, on the output axis', () => {
    const rows = toRows(SUBJECT)
    expect(rows).toHaveLength(1)
    const actions = rows[0]?.actions ?? []
    expect(actions.map(action => action.id)).toEqual(['clip-0', 'clip-1', 'clip-2'])
    expect(actions.every(action => action.effectId === CLIP_EFFECT)).toBe(true)
    expect(actions[0]?.start).toBeCloseTo(0, 6)
    expect(actions[0]?.end).toBeCloseTo(7.72, 6)
  })

  it('bounds a clip by the material actually available on each side', () => {
    const rows = toRows(SUBJECT)
    const first = rows[0]?.actions[0]
    // 第 0 段从素材 21.74s 处开始，所以往左最多能拉回 21.74 秒；成片起点是 0，取不到负的。
    expect(first?.minStart).toBeCloseTo(0, 6)
    // 它到素材 29.46s 结束，素材还剩 2584.13 − 29.46 秒可用，成片里就能往右长这么多。
    expect(first?.maxEnd).toBeCloseTo(7.72 + (ASSET_US / 1e6 - 29.46), 3)
  })

  it('lets a later clip reach back into the material before it', () => {
    const rows = toRows(SUBJECT)
    const second = rows[0]?.actions[1]
    // 第 1 段从素材 272.49s 开始，所以成片里它的左边界可以往回退 272.49 秒。
    expect(second?.minStart).toBeCloseTo(Math.max(0, 7.72 - 272.49), 6)
  })

  it('does not let a clip be dragged along the film', () => {
    // 在成片轴上横向拖动会改变片段顺序，而顺序是另一个工具的事；
    // 让它不可移动，拖动就只会被读成「改长度」。
    const rows = toRows(SUBJECT)
    expect(rows[0]?.actions.every(action => action.movable === false)).toBe(true)
    expect(rows[0]?.actions.every(action => action.flexible === true)).toBe(true)
  })
})

describe('reading an ordinal back from an action id', () => {
  it('reads the ordinal rather than assuming a position in the array', () => {
    expect(ordinalOfAction('clip-0')).toBe(0)
    expect(ordinalOfAction('clip-12')).toBe(12)
  })

  it('refuses an id it did not mint', () => {
    expect(ordinalOfAction('something-else')).toBeNull()
    expect(ordinalOfAction('clip-abc')).toBeNull()
  })
})

describe('turning an edited action into a tool call', () => {
  it('trims the right edge when only the end moved', () => {
    const rows = toRows(SUBJECT)
    const edited = { ...(rows[0]?.actions[0] as never as { id: string, start: number, end: number, effectId: string }), end: 9.72 }
    const intent = intentFromEditedAction(SUBJECT, edited, 'tl-1', 2)
    // 成片里 7.72 → 9.72，即多取 2 秒素材。
    expect(intent?.tool).toBe('video_timeline_trim')
    expect(intent?.args).toMatchObject({ timeline_id: 'tl-1', base_revision: 2, ordinal: 0, edge: 'end', delta_us: 2_000_000 })
  })

  it('trims the left edge with the opposite sign when the start moved', () => {
    const rows = toRows(SUBJECT)
    // 左边界往右推 1 秒 = 成片短了 1 秒，而素材起点要往后走 1 秒（正位移）。
    const edited = { ...(rows[0]?.actions[0] as never as { id: string, start: number, end: number, effectId: string }), start: 1, end: 7.72 }
    const intent = intentFromEditedAction(SUBJECT, edited, 'tl-1', 5)
    expect(intent?.args).toMatchObject({ ordinal: 0, edge: 'start', delta_us: 1_000_000 })
  })

  it('keeps the playback rate when reading a left-edge drag', () => {
    const subject: EditSubject = { clips: [clip(0, 100, 110, 2)], assetDurationUs: ASSET_US }
    const rows = toRows(subject)
    const original = rows[0]?.actions[0] as never as { id: string, start: number, end: number, effectId: string }
    // 成片原长 5 秒；左边界推到 1 秒 → 成片 4 秒，短了 1 秒 → 素材起点要前进 1×2 = 2 秒。
    const intent = intentFromEditedAction(subject, { ...original, start: 1 }, 'tl-1', 1)
    expect(intent?.args).toMatchObject({ edge: 'start', delta_us: 2_000_000 })
  })

  it('reports nothing when the drag left the length alone', () => {
    const rows = toRows(SUBJECT)
    const untouched = rows[0]?.actions[0] as never as { id: string, start: number, end: number, effectId: string }
    expect(intentFromEditedAction(SUBJECT, untouched, 'tl-1', 2)).toBeNull()
  })

  it('reports nothing for an action this surface did not mint', () => {
    const foreign = { id: 'other-1', start: 0, end: 5, effectId: 'x' }
    expect(intentFromEditedAction(SUBJECT, foreign, 'tl-1', 2)).toBeNull()
  })

  it('reports nothing for an ordinal that is no longer in the timeline', () => {
    // 拖动的过程中另一端可能刚删掉这一段；这时不能凭旧序号发出一次编辑。
    const stale = { id: 'clip-9', start: 0, end: 5, effectId: CLIP_EFFECT }
    expect(intentFromEditedAction(SUBJECT, stale, 'tl-1', 2)).toBeNull()
  })
})

describe('cutting a clip in two', () => {
  it('converts the moment from the film back into the recording', () => {
    // 车道报的是**成片**位置，工具要的是**素材**时刻。第 1 段从素材 21.74s 起、在成片 0s 起，
    // 所以在成片上 3s 处切开＝素材 21.74 + 3 = 24.74s。
    const intent = splitIntent(SUBJECT.clips, 0, 3, 'tl-1', 4)
    expect(intent?.tool).toBe('video_timeline_split')
    expect(intent?.args).toMatchObject({ ordinal: 0, asset_time_us: 24_740_000 })
  })

  it('accounts for the clip playback rate as well as its offset', () => {
    // 第 3 段（ordinal 2）是 2 倍速、素材从 296.58s 起、成片从 11.72s 起。
    // 成片上 12.72s 处＝这一段里过了 1s 的成片时间＝素材里过了 2s。
    const intent = splitIntent(SUBJECT.clips, 2, 12.72, 'tl-1', 4)
    expect(intent?.args.asset_time_us).toBe(298_580_000)
  })

  it('starts the cut from the right clip when earlier ones are longer', () => {
    // 第 2 段（ordinal 1）在成片 7.72s 起；在成片 8.72s 处切＝素材 272.49 + 1 = 273.49s。
    // 少减了这一段的成片起点，切点会落在上一段里 —— 而那是另一个位置的另一段素材。
    const intent = splitIntent(SUBJECT.clips, 1, 8.72, 'tl-1', 4)
    expect(intent?.args.asset_time_us).toBe(273_490_000)
  })

  it('refuses a moment outside the clip instead of snapping to the nearest one', () => {
    // 落点在片段之外就没有「在这里切开」这回事；就近吸附会切到别的地方。
    expect(splitIntent(SUBJECT.clips, 0, 20, 'tl-1', 4)).toBeNull()
    expect(splitIntent(SUBJECT.clips, 0, -1, 'tl-1', 4)).toBeNull()
  })

  it('refuses a cut exactly on an endpoint, which would produce an empty clip', () => {
    expect(splitIntent(SUBJECT.clips, 0, 0, 'tl-1', 4)).toBeNull()
    expect(splitIntent(SUBJECT.clips, 0, 7.72, 'tl-1', 4)).toBeNull()
  })

  it('refuses an ordinal the timeline does not have', () => {
    expect(splitIntent(SUBJECT.clips, 9, 3, 'tl-1', 4)).toBeNull()
  })
})

describe('dropping and re-timing a clip', () => {
  it('names the clip to drop and the revision it was read at', () => {
    expect(removeIntent(2, 'tl-1', 7)).toEqual({
      tool: 'video_timeline_remove',
      args: { timeline_id: 'tl-1', base_revision: 7, ordinal: 2 },
    })
  })

  it('sends only the field being changed', () => {
    // 两个字段都发会把已静音的片段在每次调倍速时恢复声音。
    expect(adjustIntent(1, { speed: 2 }, 'tl-1', 3)?.args).toEqual({
      timeline_id: 'tl-1', base_revision: 3, ordinal: 1, speed: 2,
    })
    expect(adjustIntent(1, { muted: true }, 'tl-1', 3)?.args).toEqual({
      timeline_id: 'tl-1', base_revision: 3, ordinal: 1, muted: true,
    })
  })

  it('refuses a speed that is not positive', () => {
    // 0 会让成片长度除出无穷大，负数会让片段倒放 —— 工具两种都不接受。
    expect(adjustIntent(1, { speed: 0 }, 'tl-1', 3)).toBeNull()
    expect(adjustIntent(1, { speed: -1 }, 'tl-1', 3)).toBeNull()
  })

  it('refuses a change that changes nothing', () => {
    expect(adjustIntent(1, {}, 'tl-1', 3)).toBeNull()
  })
})

describe('naming a timeline', () => {
  it('carries no revision, because a name is not part of what the film is', () => {
    expect(renameIntent('tl-1', '初剪')).toEqual({
      tool: 'video_timeline_rename',
      args: { timeline_id: 'tl-1', name: '初剪' },
    })
  })
})

describe('which clips can be merged', () => {
  it('requires the two to continue each other in the recording', () => {
    // 中间有缺口时合并会把缺口也算进成片，所以宿主拒绝 —— 按钮也不该出现。
    expect(canMergeWithNext(clip(0, 10, 20), clip(1, 20, 30))).toBe(true)
    expect(canMergeWithNext(clip(0, 10, 20), clip(1, 21, 30))).toBe(false)
  })

  it('requires the same playback settings', () => {
    // 两段设置不同时，合成一段无法同时表达这两种设置。
    expect(canMergeWithNext(clip(0, 10, 20, 1), clip(1, 20, 30, 2))).toBe(false)
    const muted = { ...clip(1, 20, 30), muted: true }
    expect(canMergeWithNext(clip(0, 10, 20), muted)).toBe(false)
  })
})

describe('which clip an intent is about', () => {
  it('reads the ordinal from a clip-level intent', () => {
    expect(clipOfIntent(removeIntent(3, 'tl-1', 1))).toBe(3)
  })

  it('reports none for an intent that is not about a clip', () => {
    // 回滚与改名作用在时间线上；把它们当成序号会让某个无关的片段被标成待确认。
    expect(clipOfIntent(revertIntent('tl-1', 5, 2))).toBeNull()
    expect(clipOfIntent(renameIntent('tl-1', '初剪'))).toBeNull()
  })
})