/**
 * The sidebar row's artwork for the workbench panel.
 *
 * A panel row renders at whatever square edge the collapsed rail asks for, so
 * the mark is drawn in a viewBox and scales with the supplied size instead of
 * pinning pixel dimensions.
 *
 * The sidebar publishes no owner-props type through its package root (`./src/*`
 * is its only other export), so the two fields a `sidebar.panellist` occupant
 * receives are spelled here. They are the whole currency of that seat: the row
 * decides the square edge and whether this panel is the selected one.
 *
 * @module dsh-video-workspace/client/workbench-icon
 */

/** What a `sidebar.panellist` occupant receives from the sidebar shell. */
export interface PanelIconProps {
  /** Requested square edge in pixels. */
  readonly size: number
  /** Whether this panel is selected in the main column. */
  readonly active: boolean
}

/**
 * Render the workbench mark.
 * @param props - the square edge the sidebar row asks for, and its selected state.
 * @returns the mark as inline SVG.
 */
export function WorkbenchIcon({ size, active }: PanelIconProps) {
  return <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    role="img"
    aria-hidden="true"
    style={active ? undefined : { opacity: 0.75 }}
  >
    {/* A film frame: the timeline sprockets the panel edits. */}
    <rect x="2.5" y="5" width="19" height="14" rx="2.5"
      stroke="currentColor" strokeWidth="1.5" />
    <path d="M7 5v14M17 5v14" stroke="currentColor" strokeWidth="1.5" />
    <path d="M10.5 9.6v4.8l4.2-2.4z" fill="currentColor" />
  </svg>
}
