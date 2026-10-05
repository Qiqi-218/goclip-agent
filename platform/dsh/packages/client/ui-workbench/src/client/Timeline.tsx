/**
 * The timeline surface: a clip lane on the film's own axis, driven by the player beside it.
 *
 * This replaces the hand-drawn lane this package used to carry. The reasons to take a library
 * here are the interactions a real editor needs and that a hand-drawn lane did not have:
 * dragging a clip's edge to change what it draws from the recording, snapping, auto-scroll while
 * dragging, and a zoom range wide enough to cut at frame level — measured at 0.0082 s/px against
 * the real 43-minute recording, about four pixels per frame.
 *
 * The surface owns no editing state. A drag produces the tool call that would make the change and
 * reports it upward; it does not send it, and it does not pretend the change has landed. The
 * timeline the person sees is still the one the host holds, which is what keeps a drag, a spoken
 * instruction and the render from disagreeing about what the film is.
 */
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Timeline as EditorTimeline, type TimelineState } from '@xzdarcy/react-timeline-editor'
import type { TimelineAction, TimelineRow } from '@xzdarcy/timeline-engine'
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { EVIDENCE_EFFECT, EvidenceLane, evidenceRows } from './EvidenceLanes.tsx'
import { CLIP_EFFECT, intentFromEditedAction, ordinalOfAction, toRows, type EditIntent, type EditSubject } from './editor-model.ts'
import { EVIDENCE_LANES, laneOfAction, type EvidenceLaneKey, type EvidenceVisibility } from './evidence-model.ts'
import { layoutOnOutputAxis } from './timing.ts'
import type { EvidencePayload } from './read.ts'
import styles from './Timeline.module.css'

/** What the timeline draws and reports. */
export type TimelineProps =
  & PropsLocale<'workbench'>
  & {
    /** Every clip of the timeline being edited, in output order. */
    readonly clips: readonly EditSubject['clips'][number][]
    /** Length of the recording the clips were cut from, in microseconds. */
    readonly assetDurationUs: number
    /** Where the player currently is, in asset microseconds. */
    readonly playheadUs: number
    /** Called when the person asks to hear or see a moment; the caller moves the player. */
    readonly onSeek: (assetUs: number) => void
    /** Called with the tool call a drag implies, or when a drag leaves nothing to apply. */
    readonly onEdit: (intent: EditIntent | null) => void
    /** Timeline the edits belong to, or null while none is loaded. */
    readonly timelineId: string | null
    /** Revision the caller last read; the host refuses edits based on a stale one. */
    readonly baseRevision: number
    /** Clips whose edits have been reported but not yet confirmed by the host. */
    readonly pendingOrdinals: readonly number[]
    /** Called with the ordinal of a clip the person selected. */
    readonly onSelectClip: (ordinal: number) => void
    /** Measured evidence for the recording, or null while none was read. */
    readonly evidence: EvidencePayload['tracks'] | null
    /** Which evidence lanes to draw. */
    readonly lanes: EvidenceVisibility
  }

/** The lane keys whose evidence the recording actually has, so the controls only offer those. */
export function availableLanes(tracks: EvidencePayload['tracks'] | null): EvidenceLaneKey[] {
  if (tracks === null) return []
  /*
   * 逐条写清每个维度看哪个字段，末尾**不留兜底**。
   *
   * 这里原来以 `return (tracks.highlights?.length ?? 0) > 0` 收尾，于是任何新增的轨道都会
   * 悄悄按「有没有高光」来决定 —— 章节就这样永远不出现，而且看起来像是「这条素材没有章节」。
   * 加一条轨道时要改这里，编译器不会提醒；所以宁可让末尾显式列出它读的字段。
   */
  return EVIDENCE_LANES.filter(lane => {
    switch (lane) {
      case 'screenText': return (tracks.screen_text?.length ?? 0) > 0
      case 'transcript': return (tracks.transcript?.length ?? 0) > 0
      case 'shots': return (tracks.shots?.length ?? 0) > 0
      case 'silences': return (tracks.silences?.length ?? 0) > 0
      case 'loudness': return (tracks.loudness?.levels_dbfs.length ?? 0) > 0
      case 'chapters': return (tracks.chapters?.length ?? 0) > 0
      case 'highlights': return (tracks.highlights?.length ?? 0) > 0
    }
  })
}

/**
 * Seconds each ruler tick covers, and the default width of one tick in pixels.
 *
 * The two together set the scale: `scaleWidth / scale` is pixels per second. A one-second tick
 * drawn 30px wide is 30px per second, which puts the real 86-second cut in about 2600px — wide
 * enough to read a clip on, short enough to reach the end of.
 *
 * An earlier pairing of `scale: 1` with `scaleWidth: 40` is also 40px per second, but it asks for a
 * tick every second across the whole axis, and the library caps how many ticks it will draw — so
 * the whole film collapsed to a 40px sliver and every mark on it was squashed to nothing.
 */
const SCALE_SECONDS = 1
const DEFAULT_SCALE_WIDTH = 30

/** Pixels per second the zoom covers. */
const MIN_SCALE_WIDTH = 1
const MAX_SCALE_WIDTH = 400

/** How much one press of a zoom button changes the scale. */
const ZOOM_STEP = 1.5

/**
 * Render the timeline.
 * @param props - the clips, the player's position, and the edit channel.
 * @returns the lane, with its zoom controls.
 */
export function Timeline({
  clips, assetDurationUs, playheadUs, onSeek, onEdit, onSelectClip, timelineId, baseRevision, pendingOrdinals, evidence, lanes, t,
}: TimelineProps): ReactNode {
  const editorRef = useRef<TimelineState>(null)
  const [scaleWidth, setScaleWidth] = useState(DEFAULT_SCALE_WIDTH)

  const subject = useMemo<EditSubject>(() => ({ clips, assetDurationUs }), [clips, assetDurationUs])
  const filmSeconds = useMemo(() => {
    const spans = layoutOnOutputAxis(clips)
    return spans.length === 0 ? 0 : (spans[spans.length - 1] as { end: number }).end
  }, [clips])
  // 行只在时间线或所选轨道变化时重算。每次渲染都重建会让编辑器自己的数据与这份行互相覆盖 ——
  // 拖动刚拉长一段，随即被一份新算出的行按回原样。
  const rows = useMemo<TimelineRow[]>(() => [
    ...toRows(subject),
    ...evidenceRows(EVIDENCE_LANES.filter(lane => lanes[lane]), filmSeconds),
  ], [subject, lanes, filmSeconds])
  const effects = useMemo(() => ({
    [CLIP_EFFECT]: { id: CLIP_EFFECT, name: t('column.timeline') },
    [EVIDENCE_EFFECT]: { id: EVIDENCE_EFFECT, name: t('evidence.lanes') },
  }), [t])

  /**
   * Fold one edited action back into a tool call and hand it up.
   *
   * A drag that changed nothing reports `null` rather than being dropped silently: the caller
   * uses that to clear a pending marker, and a dropped report would leave the marker stuck.
   *
   * @param action - the action as the editor reported it after the drag.
   */
  const reportEdit = useCallback((action: TimelineAction) => {
    if (timelineId === null) { onEdit(null); return }
    onEdit(intentFromEditedAction(subject, action, timelineId, baseRevision))
  }, [subject, timelineId, baseRevision, onEdit])

  const clipOf = useCallback((id: string) => {
    const ordinal = Number(id.slice('clip-'.length))
    return clips.find(clip => clip.ordinal === ordinal)
  }, [clips])

  /**
   * Follow the player's position.
   *
   * The playhead belongs to the player, not to this lane: one answer to "where are we" is what
   * keeps a click on the ruler, a clip edit and the picture from disagreeing. So the lane is told
   * where the player is rather than tracking a cursor of its own.
   */
  useEffect(() => {
    editorRef.current?.setTime(playheadUs / 1e6)
  }, [playheadUs])

  return (
    <div className={styles.timeline} data-timeline="">
      <div className={styles.bar}>
        <span className={styles.barLabel}>{t('column.timeline')}</span>
        <span className={styles.barHint}>{t('timeline.hint')}</span>
        <span className={styles.barSpacer} />
        <button
          type="button" className={styles.zoomButton} data-zoom="out"
          aria-label={t('timeline.zoomOut')} title={t('timeline.zoomOut')}
          onClick={() => setScaleWidth(value => Math.max(MIN_SCALE_WIDTH, value / ZOOM_STEP))}
        >−</button>
        <input
          type="range" className={styles.zoomRange} data-zoom-range=""
          min={MIN_SCALE_WIDTH} max={MAX_SCALE_WIDTH} value={scaleWidth}
          aria-label={t('timeline.zoom')}
          onChange={event => setScaleWidth(Number(event.target.value))}
        />
        <button
          type="button" className={styles.zoomButton} data-zoom="in"
          aria-label={t('timeline.zoomIn')} title={t('timeline.zoomIn')}
          onClick={() => setScaleWidth(value => Math.min(MAX_SCALE_WIDTH, value * ZOOM_STEP))}
        >＋</button>
      </div>

      <div className={styles.lane} data-timeline-viewport="">
        <EditorTimeline
          ref={editorRef}
          editorData={rows}
          effects={effects}
          scale={SCALE_SECONDS}
          scaleWidth={scaleWidth}
          scaleSplitCount={5}
          startLeft={0}
          rowHeight={46}
          gridSnap
          /*
           * 辅助线吸附必须关。实测开着它拖片段边界时，位移被吸到另一个片段的边界上，
           * 报出 −264 秒 —— 而用户只是把这一段拉长一点。10 段撒在 43 分钟里、彼此相隔
           * 几百秒，这种吸附在这里只会帮倒忙。
           */
          dragLine={false}
          autoScroll
          /*
           * 点一个片段既选中它、也让画面跳到那一秒。
           *
           * 两件事一起做是刻意的：选中是为了让「能对这一段做什么」出现（动作条在面板里），
           * 跳转是为了让眼睛落到那一段上。拆成两次点击会让最常用的动作变成两下，
           * 而这两件事本来就不冲突。
           */
          onClickActionOnly={(_event, param) => {
            const ordinal = ordinalOfAction(param.action.id)
            if (ordinal !== null) onSelectClip(ordinal)
            onSeek(Math.round(param.time * 1e6))
          }}
          onCursorDrag={time => onSeek(Math.round(time * 1e6))}
          onClickTimeArea={time => { onSeek(Math.round(time * 1e6)); return true }}
          onActionMoveEnd={({ action }) => reportEdit(action)}
          onActionResizeEnd={({ action }) => reportEdit(action)}
          getActionRender={action => {
            // 证据轨道每行只有一个横跨成片的动作，内容自己按成片比例定位。
            const lane = laneOfAction(action.id)
            if (lane !== null) {
              return (
                <div className={styles.evidenceLane} data-evidence-lane={lane}>
                  <EvidenceLane
                    assetDurationUs={assetDurationUs}
                    clips={clips}
                    filmSeconds={filmSeconds}
                    lane={lane}
                    onSeek={onSeek}
                    t={t}
                    tracks={evidence}
                  />
                </div>
              )
            }
            const clip = clipOf(action.id)
            if (clip === undefined) return null
            const pending = pendingOrdinals.includes(clip.ordinal)
            return (
              <div
                className={pending ? styles.clipPending : styles.clip}
                data-clip-render={clip.ordinal}
                data-clip-pending={pending ? '' : undefined}
                title={t('timeline.clipDetail', {
                  ordinal: String(clip.ordinal + 1),
                  start: (clip.start_us / 1e6).toFixed(1),
                  end: (clip.end_us / 1e6).toFixed(1),
                })}
              >
                <span className={styles.clipName}>#{clip.ordinal + 1}</span>
                {clip.speed !== 1 && <span className={styles.clipTag}>{clip.speed}×</span>}
                {clip.muted && <span className={styles.clipTag}>{t('timeline.muted')}</span>}
                <span className={styles.clipRange}>
                  {(clip.start_us / 1e6).toFixed(1)}→{(clip.end_us / 1e6).toFixed(1)}
                </span>
              </div>
            )
          }}
        />
      </div>
    </div>
  )
}
