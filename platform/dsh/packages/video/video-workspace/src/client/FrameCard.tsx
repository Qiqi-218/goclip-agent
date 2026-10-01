/**
 * The card itself for the visual-lookup tool.
 *
 * Kept apart from the bundle entry (`index.ts`) because `clientBundle` resolves
 * its default entry as `src/client/index.ts`, while this module needs `.tsx` for
 * its markup.
 *
 * @module dsh-video-workspace/client/frame-card
 */

import { useState } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import css from './VideoFrameCard.module.css'

/** One match as the host tool recorded it. */
export interface FrameMatch {
  readonly start_us?: number
  readonly end_us?: number
  readonly frame_url?: string
  readonly reason?: string
}

/** The host tool's result payload, as far as this card reads it. */
export interface FindResult {
  readonly scanned?: number
  readonly query?: string
  readonly subject?: string
  readonly matches?: readonly FrameMatch[]
  readonly note?: string
}

/** Format one microsecond offset as `m:ss.s`. */
function clock(us: number | undefined): string {
  if (typeof us !== 'number' || !Number.isFinite(us) || us < 0) return '—'
  const total = us / 1_000_000
  const minutes = Math.floor(total / 60)
  const seconds = total - minutes * 60
  return `${String(minutes)}:${seconds.toFixed(1).padStart(4, '0')}`
}

/**
 * Read the host tool's result out of the settled call's text content. A card
 * that cannot parse its payload renders nothing rather than a guess, so
 * malformed or replayed data never shows invented frames.
 * @param props - the keyed toolview payload.
 * @returns the parsed payload, or null when this call carries none.
 */
export function readResult(props: ToolCallViewProps): FindResult | null {
  if (props.phase === 'preparing') return null
  const block = props.block
  if (!('kind' in block)) return null
  for (const item of block.content) {
    if (item.type !== 'text') continue
    try {
      const parsed: unknown = JSON.parse(item.text)
      if (typeof parsed === 'object' && parsed !== null) return parsed as FindResult
    } catch {
      // Streaming settles a truncated prefix first; keep looking for a full block.
    }
  }
  return null
}

/**
 * Render one `video_find_in_video` call: what was asked, what was scanned, and
 * the frames that matched.
 * @param props - keyed toolview payload for this call.
 * @returns the frame card, or null when the payload is not readable.
 */
export function FindInVideoCard(props: ToolCallViewProps) {
  const [openUrl, setOpenUrl] = useState<string | null>(null)
  const result = readResult(props)
  if (result === null) return null
  const matches = result.matches ?? []
  const subject = result.subject ?? result.query ?? ''

  return <div className={css.card} data-tool="video_find_in_video">
    <div className={css.head}>
      <span className={css.title}>看画面找「{subject}」</span>
      <span className={css.meta}>
        扫描 {result.scanned ?? 0} 帧 · 命中 {matches.length} 处
      </span>
    </div>
    {matches.length === 0 ? <p className={css.empty}>
      {result.note !== undefined && result.note !== '' ? result.note : '这段范围里没有找到该画面。'}
    </p> : <ul className={css.grid}>
      {matches.map(match => <li key={`${String(match.start_us)}-${match.frame_url ?? ''}`} className={css.item}>
        {match.frame_url === undefined ? null : <button
          type="button"
          className={css.frameButton}
          onClick={() => { setOpenUrl(match.frame_url ?? null) }}
          title="点开看这一帧的原图"
        >
          <img className={css.frame} src={match.frame_url} alt={`${clock(match.start_us)} 的画面`} loading="lazy" />
        </button>}
        <div className={css.caption}>
          <span className={css.time}>{clock(match.start_us)}–{clock(match.end_us)}</span>
          <span className={css.reason}>{match.reason ?? ''}</span>
        </div>
      </li>)}
    </ul>}
    {openUrl === null ? null : <div
      className={css.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label="帧原图"
      onClick={() => { setOpenUrl(null) }}
    >
      <img className={css.lightboxImage} src={openUrl} alt="帧原图" />
      <button type="button" className={css.lightboxClose} onClick={() => { setOpenUrl(null) }}>关闭</button>
    </div>}
  </div>
}
