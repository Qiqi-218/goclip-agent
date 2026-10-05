/**
 * A horizontal scrollbar for the timeline, drawn over the whole recording.
 *
 * The library hides its own scrollbar and its scrolling is done through a virtualized grid, so a
 * 43-minute axis at four pixels per second is about ten thousand pixels wide with **no visible way
 * to move along it**. A wheel does move it, but a wheel is not discoverable and cannot be grabbed:
 * nothing on screen says there is more to the right, or how much.
 *
 * Two things this gives that a wheel cannot:
 *
 * - **Where you are in the whole recording.** The track is the full axis and the thumb is the part
 *   on screen, so the proportion is readable at a glance and the empty stretches between clips are
 *   visible as gaps in the map above it.
 * - **A target to aim at.** Clicking a position in the track jumps there; the thumb drags; the
 *   arrows nudge. Going to a moment twenty minutes away is one gesture instead of a long scroll.
 *
 * The map above the track is deliberately coarse: it shows which parts of the recording the cut uses,
 * not what is in them. A preview detailed enough to edit against would be a second timeline, and
 * this one exists to be aimed at.
 */
import { useCallback, useRef, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClipSpan } from './timing.ts'
import styles from './TimelineScrollbar.module.css'

/** What the scrollbar draws and reports. */
export type TimelineScrollbarProps =
  & PropsLocale<'workbench'>
  & {
    /** Where the lane is scrolled to, in pixels. */
    readonly scrollLeft: number
    /** How wide the lane's viewport is, in pixels. */
    readonly viewportWidth: number
    /** How wide the whole axis is, in pixels. */
    readonly contentWidth: number
    /** Length of the recording in seconds; the map is drawn against it. */
    readonly assetSeconds: number
    /** The clips, so the map shows which stretches the cut uses. */
    readonly clips: readonly ClipSpan[]
    /** Move the lane to an absolute scroll offset, in pixels. */
    readonly onScrollTo: (pixels: number) => void
  }

/**
 * Render the horizontal scrollbar.
 *
 * @param props - the lane's scroll geometry, the clips, and the scroll channel.
 * @returns The scrollbar, or nothing when the axis fits on screen.
 */
export function TimelineScrollbar({
  scrollLeft, viewportWidth, contentWidth, assetSeconds, clips, onScrollTo, t,
}: TimelineScrollbarProps): ReactNode {
  const track = useRef<HTMLDivElement>(null)
  /*
   * Where the pointer was when the drag began, and where the lane was scrolled to.
   *
   * Recorded rather than accumulated: the thumb has to follow the pointer exactly, and a thumb that
   * drifts away from the hand reads as the surface fighting back. The ratio between track and
   * content is what turns pointer movement into scroll movement.
   */
  const drag = useRef<{ pointerX: number, from: number } | null>(null)

  /*
   * 没有可滑的余量时什么都不画。
   *
   * 内容比视口窄（整条轴已经全在屏幕上），或者还没量到尺寸（首帧），两种情况都收在这里 ——
   * 而且要收在**最前面**：放在后面会先渲染一次再返回 null，那一帧里会出现一条满格的轨道，
   * 声称右边还有东西。
   */
  const nothingToScroll = contentWidth <= 0 || contentWidth <= viewportWidth

  /** Pointer x within the track, or null when the track is not laid out. */
  const trackX = useCallback((clientX: number): number | null => {
    const node = track.current
    if (node === null) return null
    const box = node.getBoundingClientRect()
    return box.width <= 0 ? null : clientX - box.left
  }, [])

  const start = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const node = track.current
    if (node === null) return
    const box = node.getBoundingClientRect()
    if (box.width <= 0) return
    /*
     * A press outside the thumb recentres it there and then starts dragging from that point, which
     * is what every scrollbar does: the first click both moves and grabs, so getting somewhere far
     * away is one gesture rather than click-then-drag.
     */
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    const jump = ratio * contentWidth - viewportWidth / 2
    drag.current = { pointerX: event.clientX, from: Math.max(0, Math.min(contentWidth - viewportWidth, jump)) }
    onScrollTo(drag.current.from)
    if (typeof node.setPointerCapture === 'function') node.setPointerCapture(event.pointerId)

    const pointerId = event.pointerId
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      const state = drag.current
      const at = trackX(moveEvent.clientX)
      if (state === null || at === null) return
      // 轨道宽度与内容宽度之比，就是指针位移到滚动位移的换算。
      const perPixel = contentWidth / (track.current?.getBoundingClientRect().width ?? 1)
      const wanted = state.from + (moveEvent.clientX - state.pointerX) * perPixel
      onScrollTo(Math.max(0, Math.min(contentWidth - viewportWidth, wanted)))
    }
    const end = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return
      drag.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }, [contentWidth, onScrollTo, trackX, viewportWidth])

  if (nothingToScroll) return null

  const thumbLeft = (scrollLeft / contentWidth) * 100
  const thumbWidth = Math.max(2, (viewportWidth / contentWidth) * 100)

  return (
    <div className={styles.scrollbar} data-timeline-scrollbar="">
      {/*
       * 地图：整条录制上标出被取用的区段。它是用来瞄准的，不是用来编辑的 ——
       * 详细到能编辑就会变成第二条时间线。
       */}
      <div className={styles.map} data-scrollbar-map="" aria-hidden="true">
        {assetSeconds > 0 && clips.map(clip => {
          const from = Math.max(0, Math.min(assetSeconds, clip.start_us / 1e6))
          const to = Math.max(from, Math.min(assetSeconds, clip.end_us / 1e6))
          return (
            <span
              key={`${clip.start_us}-${clip.end_us}`}
              className={styles.mapClip}
              data-scrollbar-clip=""
              style={{ left: `${(from / assetSeconds) * 100}%`, width: `${Math.max(0.1, ((to - from) / assetSeconds) * 100)}%` }}
            />
          )
        })}
      </div>
      <div
        ref={track}
        className={styles.track}
        data-scrollbar-track=""
        role="scrollbar"
        tabIndex={0}
        aria-label={t('timeline.scroll')}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.round(contentWidth)}
        aria-valuenow={Math.round(scrollLeft)}
        onPointerDown={start}
        onKeyDown={event => {
          const step = event.shiftKey ? viewportWidth * 0.9 : viewportWidth * 0.25
          if (event.key === 'ArrowLeft') { event.preventDefault(); onScrollTo(Math.max(0, scrollLeft - step)) }
          if (event.key === 'ArrowRight') { event.preventDefault(); onScrollTo(Math.min(contentWidth - viewportWidth, scrollLeft + step)) }
          if (event.key === 'Home') { event.preventDefault(); onScrollTo(0) }
          if (event.key === 'End') { event.preventDefault(); onScrollTo(contentWidth - viewportWidth) }
        }}
      >
        <span
          className={styles.thumb}
          data-scrollbar-thumb=""
          style={{ left: `${thumbLeft}%`, width: `${thumbWidth}%` }}
        />
      </div>
    </div>
  )
}
