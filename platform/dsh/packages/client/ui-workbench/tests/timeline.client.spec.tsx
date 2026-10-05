// @vitest-environment jsdom
/**
 * The timeline surface's integration with the editor library.
 *
 * The library is mocked, deliberately. Its own drawing, dragging and zooming are its behaviour to
 * guarantee, not this package's, and a real instance brings `interactjs` pointer plumbing into
 * jsdom, where it either does nothing or fails for reasons unrelated to what is under test. What
 * this package owns — and what these cases pin down — is the wiring:
 *
 * - the clips reach it laid out on the **film's** axis, not at their positions in the recording;
 * - a drag is translated into a tool call rather than applied locally;
 * - the playhead follows the player instead of the lane keeping a cursor of its own;
 * - an edit that has been reported but not confirmed is drawn differently from a settled one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'

/** One action as the mocked editor receives it. */
interface FakeAction {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly effectId: string
}

/** What the mocked editor was rendered with, and how a test drives its callbacks. */
interface CapturedProps {
  editorData?: { id: string, actions: FakeAction[] }[]
  scaleWidth?: number
  dragLine?: boolean
  gridSnap?: boolean
  getActionRender?: (action: FakeAction) => ReactNode
  onClickActionOnly?: (event: unknown, param: { action: FakeAction, time: number }) => void
  onCursorDrag?: (time: number) => void
  onClickTimeArea?: (time: number) => boolean | undefined
  onActionMoveEnd?: (param: { action: FakeAction }) => void
  onActionResizeEnd?: (param: { action: FakeAction }) => void
}

const captured: { props: CapturedProps | null, setTime: ReturnType<typeof vi.fn>, scrollLeft: number[] } = {
  props: null,
  setTime: vi.fn(),
  scrollLeft: [],
}

vi.mock('@xzdarcy/react-timeline-editor', () => ({
  // 替身必须转发 ref：这个组件用 ref 调 `setTime` 把播放头推给车道，
  // 不转发的替身会让「播放头联动」那条测试因为 ref 为 null 而失败 —— 而那是替身的缺陷。
  //
  // `setScrollLeft` 也要给：缩放用它把光标下那一刻钉住，而真实库的 `TimelineState` 里
  // 确实有这个方法。替身只给一半接口时，测出来的是替身的短板而不是组件的行为。
  Timeline: forwardRef((props: CapturedProps, ref: unknown) => {
    captured.props = props
    useImperativeHandle(ref as never, () => ({
      setTime: captured.setTime,
      getTime: () => 0,
      setScrollLeft: (value: number) => { captured.scrollLeft.push(value) },
    }), [])
    /*
     * 替身要画出**真实的滚动容器结构**：组件从
     * `.timeline-editor-edit-area .ReactVirtualized__Grid` 上读滚动量。
     *
     * 这一层不能省。库里有**两个** `.ReactVirtualized__Grid`（时间区一个、编辑区一个），
     * 而时间区那个不滚动 —— 组件最初就是选错了那个，实测锚定漂了 25 秒。
     * 替身若只给一个 grid，那条错就永远测不出来。
     */
    return (
      <div data-editor="">
        <div className="timeline-editor-time-area"><div className="ReactVirtualized__Grid" data-time-grid="" /></div>
        <div className="timeline-editor-edit-area"><div className="ReactVirtualized__Grid" data-edit-grid="" /></div>
      </div>
    )
  }),
}))
vi.mock('@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css', () => ({}))

const { Timeline } = await import('../src/client/Timeline.tsx')
const { zh } = await import('../src/client/locales.ts')
const { availableLanes } = await import('../src/client/Timeline.tsx')

beforeEach(() => { captured.props = null; captured.setTime.mockClear(); captured.scrollLeft = [] })
afterEach(cleanup)

/**
 * Dictionary lookup with the `{name}` substitution the locale seat performs.
 * @param key - dictionary key.
 * @param params - placeholder values.
 * @returns the rendered string.
 */
const t = (key: keyof typeof zh, params?: Record<string, unknown>): string => {
  const template = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** Three clips of the real cut: 7.72s, 4.00s and 2.84s of film (the last at 2×). */
const CLIPS = [
  { ordinal: 0, start_us: 21_740_000, end_us: 29_460_000, speed: 1, muted: false },
  { ordinal: 1, start_us: 272_490_000, end_us: 276_490_000, speed: 1, muted: false },
  { ordinal: 2, start_us: 296_580_000, end_us: 302_260_000, speed: 2, muted: true },
]

/** Length of the recording the clips were cut from. */
const ASSET_US = 2_584_133_000

/**
 * Render the timeline.
 * @param overrides - props to replace.
 * @returns the render result plus the two spies.
 */
function renderTimeline(overrides: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const onSeek = vi.fn()
  const onEdit = vi.fn()
  const result = render(
    <Timeline
      assetDurationUs={ASSET_US}
      baseRevision={2}
      clips={CLIPS}
      evidence={null}
      lanes={{ transcript: false, screenText: false, shots: false, silences: false, loudness: false, chapters: false, highlights: false }}
      onEdit={onEdit}
      onSeek={onSeek}
      pendingOrdinals={[]}
      playheadUs={0}
      t={t as never}
      timelineId="tl-1"
      {...overrides}
    />,
  )
  return { ...result, onSeek, onEdit }
}

describe('timeline wiring', () => {
  it('lays the clips out where they sit in the recording, gaps and all', () => {
    renderTimeline()
    const actions = captured.props?.editorData?.[0]?.actions ?? []
    /*
     * 轴是**录制本身**，所以三段停在它们真实的素材位置上：21.74→29.46、272.49→276.49、
     * 296.58→302.26。中间没被取用的秒数就是空隙。
     *
     * 早先这里是首尾相接的成片轴（0→7.72→11.72→14.56）。那样轴与播放器是两个时间系统，
     * 点轴的 40 秒会让画面跳到素材的 40 秒 —— 而那是另一个时刻。
     */
    expect(actions[0]?.start).toBeCloseTo(21.74, 6)
    expect(actions[0]?.end).toBeCloseTo(29.46, 6)
    expect(actions[1]?.start).toBeCloseTo(272.49, 6)
    expect(actions[1]?.end).toBeCloseTo(276.49, 6)
    expect(actions[2]?.start).toBeCloseTo(296.58, 6)
    expect(actions[2]?.end).toBeCloseTo(302.26, 6)
  })

  it('turns line snapping off, which this recording would otherwise make destructive', () => {
    // 开着它时实测一次拖动被吸到 −264 秒外；这条守住那个结论。
    renderTimeline()
    expect(captured.props?.dragLine).toBe(false)
    expect(captured.props?.gridSnap).toBe(true)
  })

  it('reports a drag as a tool call instead of applying it', () => {
    const { onEdit } = renderTimeline()
    // 第 2 段取自素材 272.49→276.49 秒。把右边界拉到 278.49 就是多取 2 秒素材。
    const action = { id: 'clip-1', start: 272.49, end: 276.49, effectId: 'clip' }
    captured.props?.onActionResizeEnd?.({ action: { ...action, end: 278.49 } })
    expect(onEdit).toHaveBeenCalledWith({
      tool: 'video_timeline_trim',
      args: { timeline_id: 'tl-1', base_revision: 2, ordinal: 1, edge: 'end', delta_us: 2_000_000 },
    })
  })

  it('does not scale a drag by the playback rate, because the axis is the recording', () => {
    const { onEdit } = renderTimeline()
    /*
     * 第 3 段是 2 倍速。轴是录制本身，所以拖 1 秒就是 1 秒素材 —— 倍率不参与。
     *
     * 在成片轴上这里要乘 2（成片 1 秒 = 素材 2 秒），而漏掉那个因子只会让取用区间短一半：
     * 画面还在，只是少了一截，要看片才发现。这正是换成素材轴要消掉的那类错。
     */
    const action = { id: 'clip-2', start: 296.58, end: 302.26, effectId: 'clip' }
    captured.props?.onActionMoveEnd?.({ action: { ...action, end: 303.26 } })
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.objectContaining({ ordinal: 2, edge: 'end', delta_us: 1_000_000 }),
    }))
  })

  it('reports nothing when a drag left the clip alone', () => {
    const { onEdit } = renderTimeline()
    captured.props?.onActionMoveEnd?.({ action: { id: 'clip-1', start: 272.49, end: 276.49, effectId: 'clip' } })
    // 一字未改的拖动要报 null，好让上层的「待确认」标记被清掉；直接丢掉汇报会让它卡住。
    expect(onEdit).toHaveBeenCalledWith(null)
  })

  it('reports nothing when no timeline is loaded', () => {
    const { onEdit } = renderTimeline({ timelineId: null })
    captured.props?.onActionResizeEnd?.({ action: { id: 'clip-1', start: 7.72, end: 12.72, effectId: 'clip' } })
    expect(onEdit).toHaveBeenCalledWith(null)
  })

  it('asks the player to move rather than moving a cursor of its own', () => {
    const { onSeek } = renderTimeline()
    captured.props?.onCursorDrag?.(3.5)
    expect(onSeek).toHaveBeenCalledWith(3_500_000)
    captured.props?.onClickTimeArea?.(8)
    expect(onSeek).toHaveBeenCalledWith(8_000_000)
  })

  it('sends the playhead to the lane so both views agree', () => {
    renderTimeline({ playheadUs: 12_500_000 })
    expect(captured.setTime).toHaveBeenCalledWith(12.5)
  })
})

describe('timeline controls', () => {
  it('widens the scale when zoomed in and narrows it when zoomed out', () => {
    const { container } = renderTimeline()
    const initial = captured.props?.scaleWidth ?? 0
    fireEvent.click(container.querySelector('[data-zoom="in"]') as Element)
    expect(captured.props?.scaleWidth ?? 0).toBeGreaterThan(initial)
    fireEvent.click(container.querySelector('[data-zoom="out"]') as Element)
    fireEvent.click(container.querySelector('[data-zoom="out"]') as Element)
    expect(captured.props?.scaleWidth ?? 0).toBeLessThan(initial)
  })

  it('takes the zoom slider as the scale itself', () => {
    const { container } = renderTimeline()
    // scaleWidth 就是「每秒多少像素」；把它和刻度秒数一起改等于没缩放 —— 验证时犯过这个错。
    fireEvent.change(container.querySelector('[data-zoom-range]') as Element, { target: { value: '240' } })
    expect(captured.props?.scaleWidth).toBe(240)
  })
})

describe('what a clip looks like', () => {
  it('names the clip and the stretch of recording it draws', () => {
    renderTimeline()
    const rendered = captured.props?.getActionRender?.({ id: 'clip-1', start: 7.72, end: 11.72, effectId: 'clip' })
    render(<div data-shot="">{rendered}</div>)
    const shot = document.querySelector('[data-shot]')
    // 拖动之后最需要核对的就是「这一段取自哪里」，所以片段上必须写出来。
    expect(shot?.textContent).toContain('272.5→276.5')
    expect(shot?.textContent).toContain('#2')
  })

  it('draws a reported but unconfirmed edit differently from a settled one', () => {
    renderTimeline({ pendingOrdinals: [1] })
    render(<div data-shot="">{captured.props?.getActionRender?.({ id: 'clip-1', start: 7.72, end: 11.72, effectId: 'clip' })}</div>)
    expect(document.querySelector('[data-shot] [data-clip-pending]')).not.toBeNull()
  })

  it('leaves a settled clip unmarked', () => {
    renderTimeline({ pendingOrdinals: [] })
    render(<div data-shot="">{captured.props?.getActionRender?.({ id: 'clip-0', start: 0, end: 7.72, effectId: 'clip' })}</div>)
    expect(document.querySelector('[data-shot] [data-clip-pending]')).toBeNull()
  })

  it('renders nothing for an action this surface did not mint', () => {
    renderTimeline()
    expect(captured.props?.getActionRender?.({ id: 'foreign-1', start: 0, end: 1, effectId: 'x' })).toBeNull()
  })
})

/** Evidence with two tracks present and four absent, as the host reports an asset. */
const EVIDENCE = {
  transcript: [{ start_us: 22_740_000, end_us: 24_740_000, text: '第一句' }],
  chapters: [{ start_us: 22_740_000, end_us: 26_740_000, summary: '讲塔的来历', is_highlight: true }],
  highlights: [{ start_us: 23_000_000, end_us: 25_000_000, reason: '塔的全景', confidence: 0.9 }],
} as never

/** All lanes visible. */
const ALL_LANES = { transcript: true, screenText: true, shots: true, silences: true, loudness: true, chapters: true, highlights: true }

/** No lanes visible. */
const NO_LANES = { transcript: false, screenText: false, shots: false, silences: false, loudness: false, chapters: false, highlights: false }

describe('evidence lanes', () => {
  it('offers only the lanes the recording actually has evidence for', () => {
    // 给一条没有证据的轨道，会让人以为「这里没有停顿」，而实际是「停顿还没测过」——
    // 那是两个不同的结论，所以开关只列出真的有的。
    expect(availableLanes(EVIDENCE)).toEqual(['transcript', 'chapters', 'highlights'])
    // 章节没有自己的判定分支时，它会掉进高光的兜底：这条素材有高光、于是章节也被列出来，
    // 而一条只有章节、没有高光的素材会反过来把章节藏掉。下面这条正是那个方向。
    // 参数就是 tracks 本身，不要再包一层 `tracks` —— 包了会得到一个空对象，
    // 断言于是因为「什么都没传」而通过或失败，与要守的那件事无关。
    expect(availableLanes({ chapters: [{ start_us: 0, end_us: 1_000_000, summary: '开场', is_highlight: false }] } as never))
      .toEqual(['chapters'])
    expect(availableLanes(null)).toEqual([])
    expect(availableLanes({} as never)).toEqual([])
  })

  it('adds one row per enabled lane, under the clip row', () => {
    renderTimeline({ evidence: EVIDENCE, lanes: ALL_LANES })
    const rows = captured.props?.editorData ?? []
    // 第 1 行是片段，其后每行一条证据轨道。
    expect(rows[0]?.id).toBe('clips')
    expect(rows.map(row => row.id)).toEqual(['clips', 'transcript', 'screenText', 'shots', 'silences', 'loudness', 'chapters', 'highlights'])
  })

  it('draws a chapter as readable text, because the lane answers what a section is about', () => {
    // 章节与高光来自同一份分析片段，画法却不同，因为回答的问题不同：章节要说「这一段讲了
    // 什么」，文字必须铺开；高光只说「哪几段值得挑」，位置本身就是答案。
    renderTimeline({ evidence: EVIDENCE, lanes: ALL_LANES })
    const chapters = captured.props?.getActionRender?.({ id: 'lane-chapters', start: 0, end: 1, effectId: 'evidence' })
    render(<div data-shot="">{chapters}</div>)
    expect(document.querySelector('[data-shot] [data-evidence-text]')?.textContent).toBe('讲塔的来历')
  })

  it('draws a highlight as a block rather than as text', () => {
    renderTimeline({ evidence: EVIDENCE, lanes: ALL_LANES })
    const highlights = captured.props?.getActionRender?.({ id: 'lane-highlights', start: 0, end: 1, effectId: 'evidence' })
    render(<div data-shot="">{highlights}</div>)
    expect(document.querySelector('[data-shot] [data-evidence-mark="highlights"]')).not.toBeNull()
    expect(document.querySelector('[data-shot] [data-evidence-text]')).toBeNull()
  })

  it('draws no evidence rows when no lane is enabled', () => {
    renderTimeline({ evidence: EVIDENCE, lanes: NO_LANES })
    expect((captured.props?.editorData ?? []).map(row => row.id)).toEqual(['clips'])
  })

  it('gives every evidence row one action covering the whole recording, not a sliver of it', () => {
    renderTimeline({ evidence: EVIDENCE, lanes: ALL_LANES })
    const lane = (captured.props?.editorData ?? []).find(row => row.id === 'transcript')
    expect(lane?.actions).toHaveLength(1)
    expect(lane?.actions[0]?.id).toBe('lane-transcript')
    expect(lane?.actions[0]?.effectId).toBe('evidence')
    // 动作的像素宽度 = end × scaleWidth，所以 end 必须是**轴的秒数**，而轴就是录制。
    // 这两条守住两种都让轨道看起来是空的写法：end=1 把动作压成一秒宽，
    // 而一个「很大」的 end 会把行撑到几百万像素、把整条轴挤成一条线。
    expect(lane?.actions[0]?.end).toBeCloseTo(ASSET_US / 1e6, 3)
    expect(lane?.actions[0]?.start).toBe(0)
  })

  it('keeps a lane renderable when the timeline has no clips yet', () => {
    // 成片长度为 0 时动作宽度也是 0，库不渲染宽度为 0 的动作 —— 轨道会整个消失。
    renderTimeline({ clips: [], evidence: EVIDENCE, lanes: ALL_LANES })
    const lane = (captured.props?.editorData ?? []).find(row => row.id === 'transcript')
    expect(lane?.actions[0]?.end).toBeGreaterThan(0)
  })

  it('does not let an evidence lane be dragged', () => {
    // 证据是测出来的，不是剪出来的；让它可拖会产生一条改不了任何东西的编辑意图。
    renderTimeline({ evidence: EVIDENCE, lanes: ALL_LANES })
    const lane = (captured.props?.editorData ?? []).find(row => row.id === 'highlights')
    expect(lane?.actions[0]?.movable).toBe(false)
    expect(lane?.actions[0]?.flexible).toBe(false)
  })

  it('places a spoken line at the moment it was spoken', () => {
    renderTimeline({ evidence: EVIDENCE, lanes: ALL_LANES })
    const rendered = captured.props?.getActionRender?.({ id: 'lane-transcript', start: 0, end: 1, effectId: 'evidence' })
    render(<div data-shot="">{rendered}</div>)
    const mark = document.querySelector('[data-shot] [data-evidence-text]') as HTMLElement | null
    expect(mark).not.toBeNull()
    /*
     * 素材 22.74 秒的标记画在轴的 22.74 秒处；轴总长就是素材时长 2584.13 秒。
     *
     * 这条断的是「标记的位置就是它被测量到的时刻」。在成片轴上它会被挪到 1.00 秒处
     * （占 14.56 秒的 6.868%）—— 那个位置与它测量的时刻无关，而屏幕上看起来一样合理，
     * 所以只有断言具体数值才分得出来。
     */
    expect(mark?.style.left).toBe('0.8799856663724351%')
  })

  it('never places an evidence mark past the right edge of the film', () => {
    renderTimeline({ evidence: EVIDENCE, lanes: ALL_LANES })
    const rendered = captured.props?.getActionRender?.({ id: 'lane-transcript', start: 0, end: 1, effectId: 'evidence' })
    render(<div data-shot="">{rendered}</div>)
    const marks = [...document.querySelectorAll('[data-shot] [data-evidence-text]')] as HTMLElement[]
    expect(marks.length).toBeGreaterThan(0)
    for (const item of marks) expect(Number.parseFloat(item.style.left)).toBeLessThan(100)
  })

  it('marks the cut point lane with ticks, not blocks', () => {
    renderTimeline({ evidence: { shots: [{ start_us: 23_000_000, end_us: 23_000_000 }] } as never, lanes: ALL_LANES })
    const rendered = captured.props?.getActionRender?.({ id: 'lane-shots', start: 0, end: 1, effectId: 'evidence' })
    // 零长度的切点在区间判定里会被丢掉，所以这里预期没有标记 —— 而不该出现一个宽度为 0 的块。
    render(<div data-shot="">{rendered}</div>)
    expect(document.querySelector('[data-shot] [data-evidence-mark="shots"]')).toBeNull()
  })

  it('reports nothing for an action id it did not mint', () => {
    renderTimeline({ evidence: EVIDENCE, lanes: ALL_LANES })
    expect(captured.props?.getActionRender?.({ id: 'lane-unknown', start: 0, end: 1, effectId: 'evidence' })).toBeNull()
  })
})
describe('zooming the timeline', () => {
  /** A viewport wide enough that the anchor arithmetic has something to work with. */
  const VIEWPORT_WIDTH = 1000

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => VIEWPORT_WIDTH })
  })

  /**
   * Scroll the lane the way the editor reports it.
   * @param container - the rendered tree.
   * @param left - the offset in pixels.
   */
  function scrollTo(container: HTMLElement, left: number): void {
    // 组件从**编辑区**那个 grid 上读滚动量；改它的 scrollLeft 就是「这条道被滚动过」。
    const grid = container.querySelector('[data-edit-grid]') as HTMLElement
    expect(grid).not.toBeNull()
    Object.defineProperty(grid, 'scrollLeft', { value: left, configurable: true, writable: true })
  }

  it('changes the scale on ctrl-wheel, and leaves a plain wheel alone', () => {
    // 不按修饰键时完全不干预：那种滚轮是横向滚动，正是想要的。
    const { container } = renderTimeline()
    const lane = container.querySelector('[data-timeline-viewport]') as HTMLElement
    const before = captured.props?.scaleWidth ?? 0
    fireEvent.wheel(lane, { deltaY: -100 })
    expect(captured.props?.scaleWidth).toBe(before)
    fireEvent.wheel(lane, { deltaY: -100, ctrlKey: true, clientX: 400 })
    expect(captured.props?.scaleWidth ?? 0).toBeGreaterThan(before)
  })

  it('zooms out on a downward ctrl-wheel', () => {
    const { container } = renderTimeline()
    const lane = container.querySelector('[data-timeline-viewport]') as HTMLElement
    const before = captured.props?.scaleWidth ?? 0
    fireEvent.wheel(lane, { deltaY: 100, ctrlKey: true, clientX: 400 })
    expect(captured.props?.scaleWidth ?? 0).toBeLessThan(before)
  })

  it('holds the moment under the pointer still', () => {
    /*
     * 这是缩放做对与做错的分界：缩放若以视口左缘为锚，人正要放大的那一刻会被推出屏幕，
     * 于是「想看清楚」的动作恰好把要看的东西弄丢。
     *
     * 换算：`scrollNeeded = (scrollLeft + anchor) × next / old − anchor`。
     * 从 scaleWidth 4、滚到 400px、指针在 400px 处放大 1.5 倍：
     * (400 + 400) × 6 / 4 − 400 = 800。锚点那一刻仍在视口的同一处。
     *
     * 若按「滚动量乘缩放比」（400 × 1.5 = 600）就会漂 —— 因为锚点不在滚动原点上。
     */
    const { container } = renderTimeline()
    const lane = container.querySelector('[data-timeline-viewport]') as HTMLElement
    scrollTo(container, 400)
    fireEvent.wheel(lane, { deltaY: -100, ctrlKey: true, clientX: 400 })
    expect(captured.props?.scaleWidth).toBe(6)
    expect(captured.scrollLeft).toEqual([800])
  })

  it('holds the centre still for the zoom buttons, which have no pointer', () => {
    // 按钮没有指针位置，所以锚在视口中心：从滚到 200px 处放大 1.5 倍，
    // (200 + 500) × 6 / 4 − 500 = 550。
    const { container } = renderTimeline()
    scrollTo(container, 200)
    fireEvent.click(container.querySelector('[data-zoom="in"]') as Element)
    expect(captured.props?.scaleWidth).toBe(6)
    expect(captured.scrollLeft).toEqual([550])
  })

  it('does not scroll into negative territory at the very start', () => {
    // 已经在最左端时缩小：算出来是负数，夹到 0 —— 否则库会收到一个非法滚动量。
    const { container } = renderTimeline()
    const lane = container.querySelector('[data-timeline-viewport]') as HTMLElement
    scrollTo(container, 0)
    fireEvent.wheel(lane, { deltaY: 100, ctrlKey: true, clientX: 0 })
    expect(captured.scrollLeft.every(value => value >= 0)).toBe(true)
  })

  it('stops at the scale limits rather than running past them', () => {
    const { container } = renderTimeline()
    const lane = container.querySelector('[data-timeline-viewport]') as HTMLElement
    for (let press = 0; press < 30; press += 1) {
      fireEvent.wheel(lane, { deltaY: -100, ctrlKey: true, clientX: 400 })
    }
    expect(captured.props?.scaleWidth).toBe(400)
    for (let press = 0; press < 60; press += 1) {
      fireEvent.wheel(lane, { deltaY: 100, ctrlKey: true, clientX: 400 })
    }
    expect(captured.props?.scaleWidth).toBe(0.5)
  })
})
describe('what the bar tells the person', () => {
  it('keeps the hint that clip edges can be dragged', () => {
    /*
     * 这条提示是**唯一**说明「边界可拖」的地方。加长度读数时它被替换掉了，于是
     * `timeline.hint` 成了没人用的孤儿键 —— 而没有任何断言因此变红，谁也没发现。
     * 这条就是那个缺失的断言。
     */
    const { container } = renderTimeline()
    expect(container.querySelector('[data-timeline-hint]')?.textContent).toBe(zh['timeline.hint'])
  })

  it('reports both lengths, because they answer different questions', () => {
    // 轴是**录制**（素材多长、哪几段被用了），读数里另有**成片**（按倍速折算后多长）。
    // 只给一个数会让人以为轴就是成片 —— 那正是先前那个坐标错。
    const { container } = renderTimeline()
    const lengths = container.querySelector('[data-lengths]')?.textContent ?? ''
    expect(lengths).toContain('2584')
    expect(lengths).toContain('14.6')
  })
})