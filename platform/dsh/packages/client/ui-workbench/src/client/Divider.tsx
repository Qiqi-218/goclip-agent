/**
 * A division between two parts of the workbench that can be dragged.
 *
 * The gesture follows the docking surface's: capture the pointer, then follow it on the window
 * until release, so a drag that leaves the divider's own few pixels keeps working. Capture is
 * hardening rather than the mechanism — without it a scroll container the pointer crosses can
 * claim the gesture, which arrives as a cancelled pointer and a drag that stops halfway.
 *
 * Three details that are behaviour rather than polish:
 *
 * - **A pointer drag reports where the pointer is; a key press reports how far to move.** They are
 *   different questions and the owner answers them differently — the position is resolved against
 *   the container's box, while a key press moves the division by a step from wherever it is. Both
 *   funnelled through one "amount" would make an arrow key jump the division to 10 pixels.
 * - **The drag reports the pointer's position, not its movement.** Accumulating deltas lets the
 *   clamp at one end swallow movement that is then never given back, so a drag past the limit and
 *   back leaves the division short of where the hand is.
 * - **The surface stays mounted while dragging.** Only the numbers change, so nothing inside is
 *   torn down and rebuilt on every pointer move.
 */
import { useCallback, useRef, type ReactNode } from 'react'
import styles from './Divider.module.css'

/** Which way a division runs. */
export type DividerAxis = 'row' | 'column'

/** How far one arrow key moves a division. */
const STEP = 10
/** How far one arrow key moves it with shift held. */
const COARSE_STEP = 40

/** What a divider needs to work. */
export interface DividerProps {
  /** `row` splits left from right; `column` splits top from bottom. */
  readonly axis: DividerAxis
  /**
   * Called once when a drag begins, with the pointer's position along the drag axis.
   *
   * A division whose seam is not an edge of anything it can measure needs where the drag started
   * as well as where the pointer is; one that can measure its container needs only the current
   * position, and passes a no-op here.
   */
  readonly onDragStart: (position: number) => void
  /**
   * Called as the pointer moves, with its position along the drag axis in client coordinates.
   *
   * The owner resolves it against its own box, because only the owner knows which division this
   * is and what the position means for it.
   */
  readonly onDragTo: (position: number) => void
  /** Called when the drag ends, whether the pointer was released or the gesture was cancelled. */
  readonly onDragEnd: () => void
  /** Called with a signed distance, for a gesture that has no pointer position. */
  readonly onStep: (delta: number) => void
  /** Restores the default size. */
  readonly onReset: () => void
  /** Describes the division for assistive technology. */
  readonly label: string
}

/**
 * Render one draggable division.
 * @param props - the axis, the drag channels, and the reset channel.
 * @returns The divider.
 */
export function Divider({ axis, onDragStart, onDragTo, onDragEnd, onStep, onReset, label }: DividerProps): ReactNode {
  const node = useRef<HTMLDivElement>(null)
  /*
   * The listeners are installed on the window rather than through React props, so the gesture
   * survives the pointer leaving the element and so the move handler runs for every event without
   * a re-render in between — a state-driven handler would batch, and the division would lag.
   */
  const start = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const element = node.current
    if (element !== null && typeof element.setPointerCapture === 'function') {
      element.setPointerCapture(event.pointerId)
    }
    const pointerId = event.pointerId
    onDragStart(axis === 'row' ? event.clientX : event.clientY)
    const read = (moveEvent: PointerEvent): void => {
      // 只认这一根指针：另一根手指或一支笔既不该移动它，也不该结束这次拖动。
      if (moveEvent.pointerId !== pointerId) return
      onDragTo(axis === 'row' ? moveEvent.clientX : moveEvent.clientY)
    }
    const stop = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return
      detach()
    }
    const detach = (): void => {
      window.removeEventListener('pointermove', read)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', detach)
      onDragEnd()
    }
    window.addEventListener('pointermove', read)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', detach)
  }, [axis, onDragStart, onDragTo, onDragEnd])

  return (
    <div
      ref={node}
      // 方向键也要能移动：一条只能拖的分界线对键盘用户等于不存在。
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === 'row' ? 'vertical' : 'horizontal'}
      className={axis === 'row' ? styles.row : styles.column}
      data-divider={axis}
      onPointerDown={start}
      onDoubleClick={onReset}
      onKeyDown={event => {
        const back = axis === 'row' ? 'ArrowLeft' : 'ArrowUp'
        const forward = axis === 'row' ? 'ArrowRight' : 'ArrowDown'
        if (event.key !== back && event.key !== forward) return
        event.preventDefault()
        const step = event.shiftKey ? COARSE_STEP : STEP
        onStep(event.key === back ? -step : step)
      }}
    />
  )
}
