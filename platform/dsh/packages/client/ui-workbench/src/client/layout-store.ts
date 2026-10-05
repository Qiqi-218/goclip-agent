/**
 * How the workbench is divided.
 *
 * The three columns and the timeline's height are things a person adjusts once and expects to stay
 * put: somebody cutting a long interview wants a wide clip list, and having it snap back to the
 * default every time they open a conversation and return would make the surface feel like it is
 * fighting them. That is what puts these numbers in a declared store rather than in the panel's own
 * state — a store is what survives a remount.
 *
 * Sizes are kept in pixels, not fractions. A fraction would mean the same layout looks different on
 * a narrower window and silently re-proportions a column somebody sized deliberately; pixels keep
 * the thing they sized at the size they chose, and only the middle column absorbs a window change.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/**
 * Every adjustable division, as it currently stands.
 *
 * Mutable, unlike the rest of this package's data: a store action receives the draft to change, so
 * `readonly` here would be a promise the store cannot keep. The panel reads it through the store's
 * snapshot hook, which is what stops a component writing to it directly.
 */
export interface LayoutState {
  /** Width of the clip and revision column, in pixels. */
  leftWidth: number
  /** Width of the finished-films column, in pixels. */
  rightWidth: number
  /** Height of the timeline area below the picture, in pixels. */
  lowerHeight: number
}

/** What the surface may change. */
type LayoutActions = {
  /** Move one division, already clamped by the caller. */
  setDivision: (draft: LayoutState, division: keyof LayoutState, value: number) => void
}

/**
 * The bounds one division may take.
 *
 * A minimum is not decoration: a column dragged to nothing leaves its own drag handle unreachable,
 * and a horizontal division collapsed to zero leaves the timeline with no height to draw into and
 * no way back. The maximum keeps the middle column — the picture — from being squeezed out.
 */
export const LAYOUT_LIMITS = {
  /** Narrow enough to be out of the way, wide enough for a time and a duration. */
  leftWidth: { min: 140, max: 420 },
  rightWidth: { min: 160, max: 460 },
  /** Below this the timeline cannot show a clip row and one evidence lane. */
  lowerHeight: { min: 190, max: 900 },
} as const satisfies Record<keyof LayoutState, { min: number, max: number }>

/** Where every division starts, before anybody moves one. */
export const DEFAULT_LAYOUT: LayoutState = { leftWidth: 200, rightWidth: 240, lowerHeight: 380 }

/**
 * Clamp one division to its bounds.
 *
 * Exported because the drag needs the same numbers the store enforces: clamping only in the store
 * would let the divider follow the pointer past the limit and then jump back on release, which
 * reads as the surface lagging the hand.
 *
 * @param division - which division.
 * @param value - the requested size in pixels.
 * @returns The nearest size the division may take.
 */
export function clampDivision(division: keyof LayoutState, value: number): number {
  const { min, max } = LAYOUT_LIMITS[division]
  if (!Number.isFinite(value)) return DEFAULT_LAYOUT[division]
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * The middle column may never be squeezed below this.
 *
 * A picture narrower than this stops being a preview, and once both side columns have taken
 * everything there is, the dividers can still be dragged but nothing on screen changes.
 */
export const MIN_CENTER_WIDTH = 260

/** A rectangle in client coordinates, as `getBoundingClientRect` reports it. */
export interface ClientBox {
  /** Distance from the viewport's left edge to this box's left edge. */
  readonly left: number
  /** Distance from the viewport's left edge to this box's right edge. */
  readonly right: number
  /** Distance from the viewport's top edge to this box's bottom edge. */
  readonly bottom: number
  /** The box's height. */
  readonly height: number
}

/**
 * Turn a pointer position into the size one division should take.
 *
 * A pure function, so the arithmetic can be checked without a browser. What it encodes is which
 * edge each divider is measured from, and getting one of those wrong moves the seam the wrong way
 * — a mistake that a test asking only whether the number changed would not catch.
 *
 * The two vertical divisions are measured from the stage's own edges, so an absolute pointer
 * position resolves them directly. The horizontal one is not: its seam is the timeline's **top**
 * edge, and the timeline's bottom edge is not an edge of anything the stage knows. So that division
 * is resolved from where the drag began instead, which needs no layout at all.
 *
 * @param division - which division is being dragged.
 * @param pointer - the pointer's client coordinate along the drag axis.
 * @param box - the stage's box.
 * @param current - the sizes as they stand, for the room the other columns leave.
 * @returns The size to ask the store for.
 */
export function resolveDivision(
  division: 'leftWidth' | 'rightWidth',
  pointer: number,
  box: ClientBox,
  current: LayoutState,
): number {
  if (division === 'leftWidth') {
    // 左栏从舞台左缘量；上限还要让出中间与右栏。
    const room = box.right - box.left - current.rightWidth - MIN_CENTER_WIDTH
    return Math.min(clampDivision(division, pointer - box.left), Math.max(LAYOUT_LIMITS.leftWidth.min, room))
  }
  // 右栏从舞台右缘往回量。
  const room = box.right - box.left - current.leftWidth - MIN_CENTER_WIDTH
  return Math.min(clampDivision(division, box.right - pointer), Math.max(LAYOUT_LIMITS.rightWidth.min, room))
}

/**
 * Resolve the timeline's height from the distance the pointer has travelled.
 *
 * Downward movement makes the timeline shorter, so the sign is inverted: the seam *is* the
 * timeline's top edge, and dragging it down takes space away from what is below it.
 *
 * @param startHeight - the height when the drag began.
 * @param startPointer - the pointer's y when the drag began.
 * @param pointer - the pointer's y now.
 * @returns The height to ask the store for.
 */
export function resolveLowerHeight(startHeight: number, startPointer: number, pointer: number): number {
  return clampDivision('lowerHeight', startHeight - (pointer - startPointer))
}

/**
 * Create the workbench layout store.
 *
 * @returns a handle instantiated once for the root-scoped panel.
 */
export function createWorkbenchLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  return defineStore({
    init: (): LayoutState => ({ ...DEFAULT_LAYOUT }),
    actions: {
      setDivision: (draft, division, value) => {
        draft[division] = clampDivision(division, value)
      },
    },
  })
}
