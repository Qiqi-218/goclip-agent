import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Shared geometry for Goclip's sidebar and empty-state mark. */
export interface GoclipBrandMarkProps {
  size: number
  className?: string | undefined
}

/**
 * Goclip's cut-frame G: an open edit frame completes a G around a play cue.
 * It stays legible as a one-colour 16px rail icon, without relying on a fill.
 */
export function GoclipBrandMark({ size, className }: GoclipBrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path d="M25.5 11A10.5 10.5 0 1 0 25.8 19" stroke="currentColor" strokeWidth="3.25" strokeLinecap="round" />
      <path d="M18 17h8v8h-8" stroke="currentColor" strokeWidth="3.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m17.5 12.5 5.5 3.5-5.5 3.5z" fill="currentColor" />
    </svg>
  )
}

/**
 * Render the Goclip mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the Goclip cut-frame mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <GoclipBrandMark size={size} />
}

/**
 * Render the Goclip product name without its independently slotted mark.
 * @returns the official name wordmark.
 */
export function OfficialBrandName() {
  return <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.035em' }}>Goclip</span>
}
