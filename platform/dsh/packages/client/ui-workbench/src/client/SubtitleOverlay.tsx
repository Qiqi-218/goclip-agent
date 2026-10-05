/**
 * The subtitle as it would be drawn on the picture.
 *
 * Shown over the player rather than in its own row, because a subtitle's position is part of what
 * is being chosen: "bottom centre" and "top left" are different decisions about the same frame, and
 * a preview in a separate strip would make them look the same.
 *
 * The stage is measured rather than assumed. The style's sizes are shares of the picture, so the
 * pixels depend on the box actually on screen, and the stage is the only thing that knows how big
 * it is — the caller would otherwise have to guess from the window size, which is wrong whenever a
 * column or the sidebar is open.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PreviewCue, PreviewStyle } from './subtitle-preview.ts'
import styles from './SubtitleOverlay.module.css'

/** What the overlay draws. */
export interface SubtitleOverlayProps {
  /** The cue to draw, or null when nothing is said at this moment. */
  readonly cue: PreviewCue | null
  /** The style resolved for the stage's current size. */
  readonly style: PreviewStyle | null
  /** Reports the stage's measured size, so the caller can resolve sizes in pixels. */
  readonly onStageMeasured: (size: { width: number, height: number }) => void
}

/**
 * Draw the subtitle over the picture.
 * @param props - the cue, its style, and the measurement channel.
 * @returns The overlay, which reports its size even when it draws no words.
 */
export function SubtitleOverlay({ cue, style, onStageMeasured }: SubtitleOverlayProps): ReactNode {
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number, height: number } | null>(null)

  useEffect(() => {
    const node = stage.current
    if (node === null) return
    const report = (): void => {
      const box = node.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) return
      // 只在真的变了时才 setState：ResizeObserver 每次布局都会回调，
      // 原样回写会让测量本身变成一次重渲染的来源。
      setSize(current => (current !== null && current.width === box.width && current.height === box.height
        ? current
        : { width: box.width, height: box.height }))
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (size !== null) onStageMeasured(size)
  }, [size, onStageMeasured])

  return (
    <div className={styles.stage} ref={stage} data-subtitle-stage="">
      {cue !== null && style !== null && (
        <div className={styles.box} style={style.box} data-subtitle-overlay="">
          <span className={styles.text} style={style.text} data-subtitle-text="">{cue.text}</span>
        </div>
      )}
    </div>
  )
}
