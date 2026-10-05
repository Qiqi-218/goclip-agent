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
import { layoutOnSourceAxis, outputSecondsOf, rateOf, trimDeltaFromAxis } from '../src/client/timing.ts'

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

describe('layout on the recording axis', () => {
  it('draws each clip where it sits in the recording, gaps and all', () => {
    /*
     * 轴是**录制本身**，所以三段停在它们真实的素材位置上：21.74→29.46、272.49→276.49、
     * 296.58→302.26。中间那些没被用到的秒数就是空隙 —— 那正是「这一刀留下了什么」。
     *
     * 早先这里是首尾相接的成片轴（0→7.72→11.72→…）。那样轴与播放器用的是两个时间系统，
     * 点轴的 40 秒会让画面跳到素材的 40 秒，而那是另一个时刻。
     */
    const spans = layoutOnSourceAxis(SUBJECT.clips)
    expect(spans[0]?.start).toBeCloseTo(21.74, 6)
    expect(spans[0]?.end).toBeCloseTo(29.46, 6)
    expect(spans[1]?.start).toBeCloseTo(272.49, 6)
    expect(spans[1]?.end).toBeCloseTo(276.49, 6)
    expect(spans[2]?.start).toBeCloseTo(296.58, 6)
    expect(spans[2]?.end).toBeCloseTo(302.26, 6)
  })

  it('does not let the playback rate move a clip on this axis', () => {
    // 倍率改变的是**成片**里占多长，不改变它取自素材的哪一段 —— 在素材轴上它不该移动。
    const spans = layoutOnSourceAxis([clip(0, 0, 10, 2), clip(1, 100, 104, 1)])
    expect(spans[0]?.start).toBeCloseTo(0, 6)
    expect(spans[0]?.end).toBeCloseTo(10, 6)
    expect(spans[1]?.start).toBeCloseTo(100, 6)
    expect(spans[1]?.end).toBeCloseTo(104, 6)
  })

  it('returns nothing for no clips', () => {
    expect(layoutOnSourceAxis([])).toEqual([])
  })
})

describe('trim delta', () => {
  it('reads a drag as the same number of recording seconds, whatever the rate', () => {
    /*
     * 轴是**录制本身**，所以轴上一秒就是一秒素材 —— 倍率不参与。
     *
     * 在成片轴上这里要乘倍率（2 倍速下成片 1 秒是素材 2 秒），而漏掉那个因子只会让取用
     * 区间短一半：画面还在，只是少了一截。这正是换成素材轴要消掉的那类错。
     */
    expect(trimDeltaFromAxis(4, 5)).toBe(1_000_000)
    expect(trimDeltaFromAxis(2, 3)).toBe(1_000_000)
  })

  it('reports a shortening as a negative movement', () => {
    expect(trimDeltaFromAxis(4, 3)).toBe(-1_000_000)
  })

  it('refuses an edit smaller than a frame', () => {
    // 一次点击带来的浮点抖动不该变成一次编辑，否则每次点选都会发出一条工具调用。
    expect(trimDeltaFromAxis(4, 4)).toBeNull()
    expect(trimDeltaFromAxis(4, 4 + 1 / 60)).toBeNull()
  })
})

describe('rows for the editor', () => {
  it('mints one action per clip, at the positions they hold in the recording', () => {
    const rows = toRows(SUBJECT)
    expect(rows).toHaveLength(1)
    const actions = rows[0]?.actions ?? []
    expect(actions.map(action => action.id)).toEqual(['clip-0', 'clip-1', 'clip-2'])
    expect(actions.every(action => action.effectId === CLIP_EFFECT)).toBe(true)
    // 第 1 段取自素材 21.74→29.46 秒，于是它就画在那里 —— 不是画在轴的 0 秒处。
    expect(actions[0]?.start).toBeCloseTo(21.74, 6)
    expect(actions[0]?.end).toBeCloseTo(29.46, 6)
  })

  it('bounds a clip by the material actually available on each side', () => {
    const rows = toRows(SUBJECT)
    const first = rows[0]?.actions[0]
    // 这条轴的左端就是录制的开头，所以往左最多拉到 0 —— 不用按倍率折算。
    expect(first?.minStart).toBeCloseTo(0, 6)
    // 右端就是录制的结尾，所以往右最多到素材时长。
    expect(first?.maxEnd).toBeCloseTo(ASSET_US / 1e6, 3)
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
    // 第 1 段原本到素材 29.46 秒；把右边界拉到 31.46 就是多取 2 秒。轴上的秒数就是素材秒数。
    const edited = { ...(rows[0]?.actions[0] as never as { id: string, start: number, end: number, effectId: string }), end: 31.46 }
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

  it('reads a left-edge drag as recording seconds, with no rate factor', () => {
    const subject: EditSubject = { clips: [clip(0, 100, 110, 2)], assetDurationUs: ASSET_US }
    const rows = toRows(subject)
    const original = rows[0]?.actions[0] as never as { id: string, start: number, end: number, effectId: string }
    /*
     * 这一段是 2 倍速，而**倍率在这里不参与**：轴是录制本身，把左边界从素材 100 秒推到
     * 102 秒就是丢掉 2 秒素材。在成片轴上同样的拖动只等于 1 秒素材，因为成片里 1 秒是素材 2 秒
     * —— 那个因子漏掉时取用区间会短一半，而画面还在，所以只有看片才发现少了一截。
     */
    const intent = intentFromEditedAction(subject, { ...original, start: 102 }, 'tl-1', 1)
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
  it('takes the moment on the axis as the moment in the recording', () => {
    /*
     * 轴就是录制，所以「点在哪里」**就是**素材时刻 —— 不需要换算。
     *
     * 早先这里要减掉片段的成片起点、再乘倍率；那个换算漏一项就会把切口放到别的地方，
     * 而错的位置要到有人看片、发现一句话中间换了镜头才暴露。换成素材轴之后，
     * 这一类错没有存在的地方。
     */
    const intent = splitIntent(SUBJECT.clips, 0, 24.74, 'tl-1', 4)
    expect(intent?.tool).toBe('video_timeline_split')
    expect(intent?.args).toMatchObject({ ordinal: 0, asset_time_us: 24_740_000 })
  })

  it('ignores the playback rate, which changes the film and not the recording', () => {
    // 第 3 段取自素材 296.58→302.26 秒（2 倍速）。切在素材 298.58 秒就是切在那一秒 ——
    // 倍率不改变它取自哪里，只改变它在成片里占多长。
    const intent = splitIntent(SUBJECT.clips, 2, 298.58, 'tl-1', 4)
    expect(intent?.args.asset_time_us).toBe(298_580_000)
  })

  it('cuts the clip that actually contains the moment', () => {
    // 第 2 段取自素材 272.49→276.49 秒。切点必须落在**这一段**的区间里；
    // 落在一段没被使用的空隙上就不是「切这一段」。
    const intent = splitIntent(SUBJECT.clips, 1, 273.49, 'tl-1', 4)
    expect(intent?.args.asset_time_us).toBe(273_490_000)
    // 273.49 秒也落在第 1 段（21.74→29.46）之外，所以切第 1 段时它必须被拒绝。
    expect(splitIntent(SUBJECT.clips, 0, 273.49, 'tl-1', 4)).toBeNull()
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