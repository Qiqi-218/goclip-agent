/** Goclip's running mark: the cut-frame G with an edit sweep travelling its ring. */
import css from './ChatView.module.css'

/** Cut-frame G geometry on the mark's 32-unit grid, shared with the product wordmark. */
const RING = 'M25.5 11A10.5 10.5 0 1 0 25.8 19'
const FRAME = 'M18 17h8v8h-8'
const PLAY = 'm17.5 12.5 5.5 3.5-5.5 3.5z'

/**
 * Render the decorative running icon. The stylesheet owns the sweep timing and
 * reduces the mark to its still form when the viewer asks for less motion.
 * @returns the Goclip cut-frame mark at the running status's icon size.
 */
export function RunningMark() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <svg className={css.runningMark} viewBox="0 0 32 32" fill="none" width="100%" height="100%">
        <path className={css.runningMarkRing} d={RING} stroke="currentColor" strokeWidth={3.25} strokeLinecap="round" />
        <path className={css.runningMarkSweep} d={RING} pathLength={100} stroke="currentColor" strokeWidth={3.25} strokeLinecap="round" />
        <path d={FRAME} stroke="currentColor" strokeWidth={3.25} strokeLinecap="round" strokeLinejoin="round" />
        <path d={PLAY} fill="currentColor" />
      </svg>
    </span>
  )
}
