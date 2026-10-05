// @vitest-environment jsdom
/**
 * The timeline's horizontal scrollbar.
 *
 * The library hides its own scrollbar, so this is the only visible way along an axis that is about
 * ten thousand pixels wide. Three things have to hold for it to be usable rather than decorative:
 *
 * - **It reports where the lane is**, so the thumb follows a wheel or a trackpad gesture and not
 *   only the scrollbar's own drags.
 * - **It maps the track to the whole axis**, so clicking near the right end reaches the end of the
 *   recording and not merely the end of what is loaded.
 * - **It disappears when there is nothing to scroll**, because a full-width track with no travel
 *   claims there is more to the right when there is not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TimelineScrollbar } from '../src/client/TimelineScrollbar.tsx'
import type {} from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import type { ClipSpan } from '../src/client/timing.ts'

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

/**
 * One clip.
 * @param start - start in recording seconds.
 * @param end - end in recording seconds.
 * @returns the clip.
 */
function clip(start: number, end: number): ClipSpan {
  return { start_us: start * 1e6, end_us: end * 1e6, speed: 1, muted: false, name: null }
}

/** The real recording: 2584 seconds, with the first two clips of the fast cut. */
const CLIPS = [clip(21.74, 29.46), clip(272.49, 276.49)]
const ASSET_SECONDS = 2584.133

/**
 * Render the scrollbar with a track of a known width.
 * @param overrides - props to replace.
 * @returns the render result plus the scroll spy.
 */
function renderBar(overrides: Partial<Parameters<typeof TimelineScrollbar>[0]> = {}) {
  const onScrollTo = vi.fn()
  const result = render(
    <TimelineScrollbar
      assetSeconds={ASSET_SECONDS}
      clips={CLIPS}
      contentWidth={10_000}
      onScrollTo={onScrollTo}
      scrollLeft={0}
      t={t as never}
      viewportWidth={1_000}
      {...overrides}
    />,
  )
  const track = result.container.querySelector('[data-scrollbar-track]') as HTMLElement | null
  /*
   * jsdom 不做布局：轨道宽度要自己给，否则换算出来的位移全是 0。
   *
   * 轨道可能**不存在** —— 没有可滑的余量时组件什么都不画，而那正是两条断言要看的结果。
   * 无条件 spy 会让那两条测试因为「找不到对象」而失败，看起来像渲染错了。
   */
  if (track !== null) {
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 500, top: 0, bottom: 12, width: 500, height: 12, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
  }
  return { ...result, onScrollTo, track }
}

/** A scrollbar is required by every interaction case; only the two absence cases keep null. */
function requiredTrack(track: HTMLElement | null): HTMLElement {
  if (track === null) throw new Error('测试需要可滚动的时间轴')
  return track
}

describe('what the scrollbar shows', () => {
  it('draws a thumb whose width is the share of the axis on screen', () => {
    // 视口占整条轴的 1/10，滑块就应当是轨道的 1/10 —— 那个比例就是「现在看得到多少」。
    const { container } = renderBar()
    const thumb = container.querySelector('[data-scrollbar-thumb]') as HTMLElement
    expect(thumb.style.width).toBe('10%')
    expect(thumb.style.left).toBe('0%')
  })

  it('moves the thumb to the share the lane is scrolled to', () => {
    const { container } = renderBar({ scrollLeft: 5_000 })
    const thumb = container.querySelector('[data-scrollbar-thumb]') as HTMLElement
    expect(thumb.style.left).toBe('50%')
  })

  it('maps which stretches of the recording the cut uses', () => {
    // 地图是用来瞄准的：空隙就是没被取用的部分，而这条素材有 944 秒没被用到。
    const { container } = renderBar()
    const marks = [...container.querySelectorAll('[data-scrollbar-clip]')] as HTMLElement[]
    expect(marks).toHaveLength(2)
    // 第 1 段取自素材 21.74→29.46 秒，起点占 0.84%，宽度约占 0.30%。
    expect(marks[0]?.style.left).toBe(`${(21.74 / ASSET_SECONDS) * 100}%`)
    expect(Number.parseFloat(marks[0]?.style.width ?? '0')).toBeCloseTo(((29.46 - 21.74) / ASSET_SECONDS) * 100, 3)
  })

  it('reports its position as a scrollbar, so a screen reader can read it', () => {
    const { container } = renderBar({ scrollLeft: 2_500 })
    const track = container.querySelector('[data-scrollbar-track]') as HTMLElement
    expect(track.getAttribute('role')).toBe('scrollbar')
    expect(track.getAttribute('aria-valuenow')).toBe('2500')
    expect(track.getAttribute('aria-valuemax')).toBe('10000')
  })

  it('draws nothing when the axis already fits on screen', () => {
    // 满格的轨道声称右边还有东西 —— 而实际上没有。那是句假话。
    const { container } = renderBar({ contentWidth: 800, viewportWidth: 1_000 })
    expect(container.querySelector('[data-timeline-scrollbar]')).toBeNull()
  })

  it('draws nothing before the lane has been laid out', () => {
    const { container } = renderBar({ contentWidth: 0, viewportWidth: 0 })
    expect(container.querySelector('[data-timeline-scrollbar]')).toBeNull()
  })
})

describe('getting somewhere along the axis', () => {
  it('centres the viewport where the track was clicked', () => {
    // 点轨道就往那里去，并且**居中**：把左缘对到指针上会让「点哪儿看哪儿」差半个屏幕。
    // 点在轨道的 80% 处 = 轴上的 8000px，减去半个视口 500 → 7500。
    const { track: maybeTrack, onScrollTo } = renderBar()
    const track = requiredTrack(maybeTrack)
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 400 })
    expect(onScrollTo).toHaveBeenCalledWith(7_500)
  })

  it('does not scroll past the end of the axis', () => {
    const { track: maybeTrack, onScrollTo } = renderBar()
    const track = requiredTrack(maybeTrack)
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 500 })
    // 轴上的 10000 − 视口 1000 = 9000 是可滚的上限。
    expect(onScrollTo).toHaveBeenCalledWith(9_000)
  })

  it('never asks for a negative offset', () => {
    const { track: maybeTrack, onScrollTo } = renderBar()
    const track = requiredTrack(maybeTrack)
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 0 })
    expect(onScrollTo.mock.calls[0]?.[0]).toBe(0)
  })

  it('follows the pointer while the drag continues', () => {
    /*
     * 轨道 500px 对应内容 10000px，所以指针每动 1px 就滚动 20px。
     * 从 200px 处按下（滚动到 3500）再拖到 210px，应当到 3700。
     */
    const { track: maybeTrack, onScrollTo } = renderBar()
    const track = requiredTrack(maybeTrack)
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 200 })
    expect(onScrollTo).toHaveBeenLastCalledWith(3_500)
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 210 })
    expect(onScrollTo).toHaveBeenLastCalledWith(3_700)
  })

  it('stops following once the pointer is released', () => {
    const { track: maybeTrack, onScrollTo } = renderBar()
    const track = requiredTrack(maybeTrack)
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 200 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    const calls = onScrollTo.mock.calls.length
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300 })
    expect(onScrollTo.mock.calls.length).toBe(calls)
  })

  it('holds the clamp when the drag runs past the right edge', () => {
    /*
     * 这一条才是夹取的守卫。点轨道最右端时算式本身已经等于上限，夹不夹都一样 ——
     * 所以「点最右端」测不出夹取，要**拖过**右缘才测得到：指针动到轨道之外，
     * 不夹取就会滚到内容之外，滑块随即消失在那一边。
     */
    const { track: maybeTrack, onScrollTo } = renderBar()
    const track = requiredTrack(maybeTrack)
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 200 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 5_000 })
    expect(onScrollTo).toHaveBeenLastCalledWith(9_000)
  })

  it('holds the clamp when the drag runs past the left edge', () => {
    const { track: maybeTrack, onScrollTo } = renderBar({ scrollLeft: 1_000 })
    const track = requiredTrack(maybeTrack)
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: -5_000 })
    expect(onScrollTo).toHaveBeenLastCalledWith(0)
  })

  it('ignores a drag that is not the primary button', () => {
    const { track: maybeTrack, onScrollTo } = renderBar()
    const track = requiredTrack(maybeTrack)
    fireEvent.pointerDown(track, { button: 2, pointerId: 1, clientX: 200 })
    expect(onScrollTo).not.toHaveBeenCalled()
  })
})

describe('moving without a pointer', () => {
  it('nudges by a quarter of the viewport on an arrow key', () => {
    // 只能拖的滑轴对键盘用户等于不存在。
    const { track: maybeTrack, onScrollTo } = renderBar({ scrollLeft: 4_000 })
    const track = requiredTrack(maybeTrack)
    fireEvent.keyDown(track, { key: 'ArrowRight' })
    expect(onScrollTo).toHaveBeenLastCalledWith(4_250)
    fireEvent.keyDown(track, { key: 'ArrowLeft' })
    expect(onScrollTo).toHaveBeenLastCalledWith(3_750)
  })

  it('moves nearly a whole viewport with shift held', () => {
    const { track: maybeTrack, onScrollTo } = renderBar({ scrollLeft: 4_000 })
    const track = requiredTrack(maybeTrack)
    fireEvent.keyDown(track, { key: 'ArrowRight', shiftKey: true })
    expect(onScrollTo).toHaveBeenLastCalledWith(4_900)
  })

  it('goes to either end on Home and End', () => {
    const { track: maybeTrack, onScrollTo } = renderBar({ scrollLeft: 4_000 })
    const track = requiredTrack(maybeTrack)
    fireEvent.keyDown(track, { key: 'Home' })
    expect(onScrollTo).toHaveBeenLastCalledWith(0)
    fireEvent.keyDown(track, { key: 'End' })
    expect(onScrollTo).toHaveBeenLastCalledWith(9_000)
  })
})
