/**
 * Browser-side, best-effort playback of the edited film.
 *
 * It deliberately uses the same ordered clips as export: each source interval is played at its
 * clip speed, muted state is applied per interval, and the next source starts when the current
 * interval ends. This is not advertised as frame-perfect FFmpeg preview; it is the fast visual
 * check that makes delete/reorder/speed meaningful before export.
 */
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { mediaUrl, type TimelineClip, type WorkbenchAsset } from './read.ts'
import styles from './Player.module.css'

export type CompositionPlayerProps = PropsLocale<'workbench'> & {
  readonly asset: WorkbenchAsset
  readonly clips: readonly TimelineClip[]
  readonly onSourceTime?: (atUs: number) => void
  /** Report the playhead on the packed finished-film axis. */
  readonly onFilmTime?: (atUs: number) => void
  /** Seek the finished film rather than a source timestamp. */
  readonly seek?: { readonly atUs: number, readonly token: number } | null
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function outputStartUs(clips: readonly TimelineClip[], index: number): number {
  return clips.slice(0, index).reduce((sum, clip) => sum + (clip.end_us - clip.start_us) / (clip.speed || 1), 0)
}

/** Play the source intervals as one composition, switching sources when required. */
export function CompositionPlayer({ asset, clips, onSourceTime, onFilmTime, seek: requestedSeek, t }: CompositionPlayerProps): ReactNode {
  const video = useRef<HTMLVideoElement>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [atUs, setAtUs] = useState(0)
  const [failed, setFailed] = useState(false)
  const requestedSourceTime = useRef<number | null>(null)
  const clip = clips[index] ?? null
  const durationUs = useMemo(() => outputStartUs(clips, clips.length), [clips])
  const source = clip === null ? null : { projectId: asset.projectId, assetId: clip.asset_id }

  // An edit can delete/reorder the current clip while it is playing. Start at the first surviving
  // clip rather than leaving a stale index that points outside the revised composition.
  useEffect(() => { setIndex(current => Math.min(current, Math.max(0, clips.length - 1))) }, [clips.length])

  // A click on the film ruler names output time. Convert it once into the source interval and let
  // the normal clip-loading effect perform the actual HTML media seek.
  useEffect(() => {
    if (requestedSeek === null || requestedSeek === undefined || clips.length === 0) return
    const wanted = Math.max(0, Math.min(durationUs, requestedSeek.atUs))
    let cursor = 0
    const next = clips.findIndex(candidate => {
      const end = cursor + (candidate.end_us - candidate.start_us) / (candidate.speed || 1)
      const found = wanted <= end || candidate === clips[clips.length - 1]
      if (!found) cursor = end
      return found
    })
    const index = Math.max(0, next)
    const candidate = clips[index] as TimelineClip
    requestedSourceTime.current = candidate.start_us + Math.round((wanted - cursor) * (candidate.speed || 1))
    setAtUs(wanted)
    setIndex(index)
  }, [requestedSeek?.token, clips, durationUs])

  const startClip = useCallback((next: number, autoplay: boolean) => {
    setIndex(next)
    setPlaying(autoplay)
  }, [])

  useEffect(() => {
    const element = video.current
    if (element === null || clip === null) return
    const seek = (): void => {
      const requested = requestedSourceTime.current
      requestedSourceTime.current = null
      element.currentTime = (requested ?? clip.start_us) / 1e6
      element.playbackRate = clip.speed || 1
      element.muted = clip.muted
      if (playing) void element.play().catch(() => setPlaying(false))
    }
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) seek()
    else element.addEventListener('loadedmetadata', seek, { once: true })
    return () => element.removeEventListener('loadedmetadata', seek)
  }, [clip?.asset_id, clip?.start_us, clip?.speed, clip?.muted, index, playing])

  if (clip === null || source === null) {
    return <div className={styles.player} data-composition-player=""><p className={styles.readout}>{t('composition.empty')}</p></div>
  }
  const prefixUs = outputStartUs(clips, index)
  return (
    <div className={styles.player} data-composition-player="">
      <video
        key={source.assetId}
        ref={video}
        className={styles.video}
        src={mediaUrl(source)}
        controls
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => setFailed(true)}
        onTimeUpdate={event => {
          const sourceUs = Math.round(event.currentTarget.currentTime * 1e6)
          onSourceTime?.(sourceUs)
          const filmUs = prefixUs + (sourceUs - clip.start_us) / (clip.speed || 1)
          setAtUs(Math.max(prefixUs, filmUs))
          onFilmTime?.(Math.max(prefixUs, filmUs))
          // Timeupdate is intentionally only the coarse boundary guard. The exact switch remains
          // bounded by the source interval; a browser cannot promise FFmpeg-level frame precision.
          if (sourceUs >= clip.end_us - 40_000) {
            if (index < clips.length - 1) startClip(index + 1, !event.currentTarget.paused)
            else { event.currentTarget.pause(); setPlaying(false) }
          }
        }}
      />
      <p className={styles.readout} data-composition-readout="">
        <span>{clock(atUs / 1e6)}</span><span>{clock(durationUs / 1e6)}</span>
      </p>
      {failed && <p className={styles.error} data-player-error="">{t('player.failed')}</p>}
    </div>
  )
}
