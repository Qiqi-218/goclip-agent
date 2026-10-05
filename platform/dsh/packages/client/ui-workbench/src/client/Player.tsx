/**
 * The source player: one `<video>` on the read-only media route.
 *
 * Two things make this more than a video tag:
 *
 * - The address is the plugin's own route, not OSS. A signed OSS address would expose
 *   the access key id in the page and expire mid-playback; the route re-signs per
 *   request and answers byte ranges, so seeking works on a file far larger than memory.
 * - Position is owned here and read by the columns around it. The loudness curve asks
 *   for a moment; this moves the playhead there. If the element instead owned the
 *   position, every reader would need its own listener and the two could disagree.
 */
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import styles from './Player.module.css'

/** What the player reads and reports. */
export type PlayerProps =
  & PropsLocale<'workbench'>
  & {
    /** Read-only route address of the asset to play. */
    readonly src: string
    /**
     * Moment to move the playhead to, in microseconds of the asset.
     *
     * A value rather than a callback: asking twice for the same moment must not be a
     * no-op, so each request carries a changing token and the effect re-runs.
     */
    readonly seek?: { readonly atUs: number, readonly token: number } | null
    /** Total asset length in microseconds, shown beside the playhead. */
    readonly durationUs: number
    /** Reports the playhead as it moves, in microseconds. */
    readonly onTime?: (atUs: number) => void
  }

/** Format one second count as minutes and seconds. */
function clock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—'
  const whole = Math.floor(totalSeconds)
  const minutes = Math.floor(whole / 60)
  const seconds = whole % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Render the player.
 * @param props - the source address, the moment to move to, and the time report.
 * @returns the player surface.
 */
export function Player({ src, seek = null, durationUs, onTime, t }: PlayerProps): ReactNode {
  const video = useRef<HTMLVideoElement>(null)
  const [at, setAt] = useState(0)
  const [failed, setFailed] = useState(false)

  // 每次请求带着一个变化的 token，所以「再跳回同一秒」也会重新执行 ——
  // 只用位置做依赖时，第二次点同一根柱子会什么都不发生。
  useEffect(() => {
    const element = video.current
    if (element === null || seek === null) return
    element.currentTime = seek.atUs / 1e6
  }, [seek?.token, seek?.atUs])

  return (
    <div className={styles.player} data-player="">
      <video
        ref={video}
        className={styles.video}
        src={src}
        controls
        preload="metadata"
        onTimeUpdate={event => {
          const seconds = event.currentTarget.currentTime
          setAt(seconds)
          onTime?.(Math.round(seconds * 1e6))
        }}
        onError={() => setFailed(true)}
      />
      <p className={styles.readout} data-player-readout="">
        <span>{clock(at)}</span>
        <span>{clock(durationUs / 1e6)}</span>
      </p>
      {failed && <p className={styles.error} data-player-error="">{t('player.failed')}</p>}
    </div>
  )
}
