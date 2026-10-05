/**
 * The workbench's divisions: where they start, how far they may go, and what the surface is
 * allowed to ask for.
 *
 * The bounds are behaviour rather than polish. A column dragged to nothing takes its own drag
 * handle with it, and a horizontal division collapsed to zero leaves the timeline no height to
 * draw into and no way back — so the clamping is what keeps the surface recoverable by hand.
 *
 * The pointer arithmetic is here rather than in the component because it is the part that can be
 * wrong in a way nobody notices: measuring a column from the wrong edge moves its seam the wrong
 * way, which a test asking only whether the number changed would not catch.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  clampDivision,
  createWorkbenchLayoutStore,
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  MIN_CENTER_WIDTH,
  resolveDivision,
  resolveLowerHeight,
} from '../src/client/layout-store.ts'

describe('the bounds one division may take', () => {
  it('keeps a division inside its own limits', () => {
    for (const division of ['leftWidth', 'rightWidth', 'lowerHeight'] as const) {
      const { min, max } = LAYOUT_LIMITS[division]
      expect(clampDivision(division, min - 1000)).toBe(min)
      expect(clampDivision(division, max + 1000)).toBe(max)
      expect(clampDivision(division, (min + max) / 2)).toBe(Math.round((min + max) / 2))
    }
  })

  it('leaves a minimum wide enough that the handle is still reachable', () => {
    // 拖到 0 会把这一栏自己的拖动把手一起拖没，之后只能用键盘或双击找回。
    for (const division of ['leftWidth', 'rightWidth'] as const) {
      expect(LAYOUT_LIMITS[division].min).toBeGreaterThanOrEqual(120)
    }
  })

  it('leaves the timeline a minimum height that can still draw a track', () => {
    expect(LAYOUT_LIMITS.lowerHeight.min).toBeGreaterThanOrEqual(180)
  })

  it('falls back to the default for a value that is not a number', () => {
    // NaN 会一路传到 style 上，在那里变成一个被浏览器丢掉的宽度 —— 分界线从此不动。
    expect(clampDivision('leftWidth', Number.NaN)).toBe(DEFAULT_LAYOUT.leftWidth)
    expect(clampDivision('leftWidth', Number.POSITIVE_INFINITY)).toBe(DEFAULT_LAYOUT.leftWidth)
  })
})

describe('the store the surface writes through', () => {
  it('starts at the defaults', () => {
    expect(createWorkbenchLayoutStore().create().getSnapshot()).toEqual(DEFAULT_LAYOUT)
  })

  it('clamps what an action is asked to set', () => {
    // 夹取写在 store 里，所以即使调用方忘了夹，值也不会越界。
    const store = createWorkbenchLayoutStore().create()
    store.actions.setDivision('leftWidth', 9_999)
    expect(store.getSnapshot().leftWidth).toBe(LAYOUT_LIMITS.leftWidth.max)
    store.actions.setDivision('lowerHeight', -50)
    expect(store.getSnapshot().lowerHeight).toBe(LAYOUT_LIMITS.lowerHeight.min)
  })

  it('moves one division without touching the others', () => {
    // 拖左栏不该顺手改掉时间线的高度 —— 那是三个独立的尺寸，不是一组预设。
    const store = createWorkbenchLayoutStore().create()
    store.actions.setDivision('leftWidth', 300)
    expect(store.getSnapshot()).toEqual({ ...DEFAULT_LAYOUT, leftWidth: 300 })
  })

  it('notifies subscribers, which is what makes a drag follow the hand', () => {
    const store = createWorkbenchLayoutStore().create()
    const seen = vi.fn()
    const stop = store.subscribe(seen)
    store.actions.setDivision('rightWidth', DEFAULT_LAYOUT.rightWidth + 30)
    expect(seen).toHaveBeenCalled()
    stop()
    const after = seen.mock.calls.length
    store.actions.setDivision('rightWidth', DEFAULT_LAYOUT.rightWidth + 60)
    expect(seen.mock.calls.length).toBe(after)
  })
})

describe('turning a pointer position into a column width', () => {
  /** The stage as the workbench lays it out: 300…1300 across. */
  const STAGE = { left: 300, right: 1300, bottom: 700, height: 600 }

  it('measures the left column from the stage left edge', () => {
    // 指针在 500、左缘在 300 → 200 宽。
    expect(resolveDivision('leftWidth', 500, STAGE, DEFAULT_LAYOUT)).toBe(200)
  })

  it('measures the right column from the stage right edge', () => {
    // 指针在 1050、右缘在 1300 → 250 宽。两栏量的是**不同的边**：
    // 写成同一条边，右栏就会跟着指针反向移动。
    expect(resolveDivision('rightWidth', 1050, STAGE, DEFAULT_LAYOUT)).toBe(250)
  })

  it('stops the left column before it squeezes the picture out', () => {
    // 舞台宽 1000；右栏先占到 460，只剩 1000 − 460 − 260 = 280 给左栏。
    const current = { ...DEFAULT_LAYOUT, rightWidth: 460 }
    expect(resolveDivision('leftWidth', 9_999, STAGE, current)).toBe(280)
  })

  it('stops the right column before it squeezes the picture out', () => {
    const current = { ...DEFAULT_LAYOUT, leftWidth: 420 }
    expect(resolveDivision('rightWidth', -9_999, STAGE, current)).toBe(1000 - 420 - MIN_CENTER_WIDTH)
  })

  it('still respects a column own maximum when there is plenty of room', () => {
    // 空间够时先撞到的是这一栏自己的上限 —— 与「让出中间」是两条不同的约束，
    // 而左栏的上限(420)恰好小于「让出中间」后的余量(500)，所以两条要分别测。
    expect(resolveDivision('leftWidth', 9_999, STAGE, DEFAULT_LAYOUT)).toBe(LAYOUT_LIMITS.leftWidth.max)
  })

  it('never asks for less than a minimum, even in a stage too narrow to share', () => {
    // 窄到让不出中间时仍给最小值：栏目变成 0 会把它的拖动把手一起弄没。
    const narrow = { left: 0, right: 200, bottom: 700, height: 600 }
    expect(resolveDivision('leftWidth', 199, narrow, DEFAULT_LAYOUT)).toBe(LAYOUT_LIMITS.leftWidth.min)
  })
})

describe('the timeline height from a drag', () => {
  it('shortens when the seam is dragged down', () => {
    // 缝就是时间线的**上缘**：往下拖是从下面拿走空间，所以高度变小。
    expect(resolveLowerHeight(380, 400, 460)).toBe(320)
  })

  it('lengthens when the seam is dragged up', () => {
    expect(resolveLowerHeight(380, 400, 340)).toBe(440)
  })

  it('is unchanged when the pointer has not moved', () => {
    expect(resolveLowerHeight(380, 400, 400)).toBe(380)
  })

  it('clamps at both ends rather than following the pointer past them', () => {
    expect(resolveLowerHeight(380, 400, 9_999)).toBe(LAYOUT_LIMITS.lowerHeight.min)
    expect(resolveLowerHeight(380, 400, -9_999)).toBe(LAYOUT_LIMITS.lowerHeight.max)
  })
})
