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
import { filmSecondsOf } from './timing.ts'
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
    /**
     * Receives the zoom controls, or null when this lane goes away.
     *
     * The keyboard shortcuts live in the panel and the zoom lives here, so this is how a key press
     * reaches it without the panel re-rendering on every scale change.
     */
    readonly onZoomReady?: (controls: ZoomControls | null) => void
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
 * The two together set the scale: `scaleWidth / scale` is pixels per second. **The axis is the
 * recording**, so the numbers are sized for a 43-minute one rather than for the 86-second cut: at
 * 4px per second the whole recording is about 10,000px, which scrolls and still shows where each
 * clip sits. The 30px per second this used to be was right for an 86-second film and would have
 * made the same axis 77,000px wide.
 *
 * A tick every second is deliberate, and the tick count is what the library caps: at this width the
 * ruler asks for 2584 ticks. Zooming in is how somebody gets to frame level — 400px per second is
 * about 18 frames across a 1080p viewport.
 *
 * An earlier pairing of `scale: 1` with `scaleWidth: 40` is also 40px per second, but the tick
 * count cap then collapsed the whole axis to a 40px sliver with every mark squashed to nothing.
 */
const SCALE_SECONDS = 1
const DEFAULT_SCALE_WIDTH = 4

/** Pixels per second the zoom covers. */
const MIN_SCALE_WIDTH = 0.5
const MAX_SCALE_WIDTH = 400

/** How much one press of a zoom button changes the scale. */
const ZOOM_STEP = 1.5

/**
 * Render the timeline.
 * @param props - the clips, the player's position, and the edit channel.
 * @returns the lane, with its zoom controls.
 */
export interface ZoomControls {
  /** Zoom in one step, anchored at the viewport centre. */
  readonly in: () => void
  /** Zoom out one step, anchored at the viewport centre. */
  readonly out: () => void
  /** Back to the default scale, anchored at the viewport centre. */
  readonly reset: () => void
}

export function Timeline({
  clips, assetDurationUs, playheadUs, onSeek, onEdit, onSelectClip, onZoomReady, timelineId, baseRevision, pendingOrdinals, evidence, lanes, t,
}: TimelineProps): ReactNode {
  const editorRef = useRef<TimelineState>(null)
  const [scaleWidth, setScaleWidth] = useState(DEFAULT_SCALE_WIDTH)
  const viewport = useRef<HTMLDivElement>(null)
  /**
   * Where the lane is scrolled to, in pixels, read from the DOM at the moment it is needed.
   *
   * Read rather than tracked through the editor's scroll callback: that callback is not the only way
   * the lane scrolls — a scrollbar drag, a trackpad gesture and the library's own auto-scroll all
   * move it — and a value that is one event behind makes the zoom anchor drift. Measured against a
   * real browser, relying on the callback left the anchor 25 seconds off after one wheel step.
   *
   * @returns The scroller's current horizontal offset, or 0 when it cannot be read.
   */
  const readScrollLeft = useCallback((): number => {
    /*
     * 要的是**编辑区**那个 grid，不是时间区那个：两者都是 `.ReactVirtualized__Grid`，
     * 而时间区那个不滚动（`overflow: hidden`）。选错会把 0 当成滚动量 —— 锚定于是
     * 按「已经在最左端」来算，实测漂了 25 秒。
     */
    const grid = viewport.current?.querySelector('.timeline-editor-edit-area .ReactVirtualized__Grid')
    return grid instanceof HTMLElement ? grid.scrollLeft : 0
  }, [])

  /**
   * Zoom while keeping one point of the axis where it is on screen.
   *
   * **Anchoring is the whole feature.** Zooming about the viewport's left edge moves the moment the
   * person was looking at off screen, so the thing they were about to edit disappears exactly as
   * they try to get closer to it. Anchoring about the pointer keeps it under the pointer; the zoom
   * buttons anchor about the middle, because a button press has no pointer position on the axis.
   *
   * The arithmetic is the library's own mapping — `pixel = startLeft + time / scale * scaleWidth`,
   * with `startLeft` at 0 — solved for the scroll offset that puts the anchored moment back where it
   * was. Doing it any other way (scaling the scroll offset by the zoom ratio, say) drifts, because
   * the anchor is not at the scroll origin.
   *
   * @param factor - how much to multiply the scale by; above 1 zooms in.
   * @param anchorX - the pixel of the viewport to hold still, or null for its middle.
   */
  /**
   * Move the lane's horizontal scroll, when the editor can.
   *
   * Guarded with a `typeof` check rather than a plain call: `setScrollLeft` is on the library's
   * `TimelineState`, so the type says it is there, but a stub or a different build can hand back a
   * handle without it — and the whole zoom would then throw instead of merely not re-anchoring.
   *
   * @param value - the new scroll offset in pixels.
   */
  const scrollTo = useCallback((value: number) => {
    const editor = editorRef.current
    if (editor === null || typeof editor.setScrollLeft !== 'function') return
    editor.setScrollLeft(value)
  }, [])

  const zoomBy = useCallback((factor: number, anchorX: number | null) => {
    const element = viewport.current
    if (element === null) return
    setScaleWidth(current => {
      const next = Math.min(MAX_SCALE_WIDTH, Math.max(MIN_SCALE_WIDTH, current * factor))
      if (next === current) return current
      const anchor = anchorX === null ? element.clientWidth / 2 : anchorX
      /*
       * 锚点那一刻在轴上的位置是 `(scrollLeft + anchor) / current`；要让它缩放后仍落在
       * 视口的同一处，新的滚动位置就是 `(scrollLeft + anchor) × next / current − anchor`。
       * 先把滚动挪好再改缩放，否则会先画出一帧错位的内容。
       */
      const from = readScrollLeft()
      const wanted = (from + anchor) * (next / current) - anchor
      scrollTo(Math.max(0, Math.round(wanted)))
      return next
    })
  }, [readScrollLeft, scrollTo])

  /**
   * Zoom to one factor outright, anchoring the viewport's centre.
   *
   * The keyboard shortcut needs this: a shortcut has no pointer position on the axis, and a person
   * pressing "reset zoom" expects the view back at the start rather than scrolled to wherever they
   * happened to be. Going through `zoomBy` would also keep the current scroll, which after a long
   * zoom-in leaves the axis showing a stretch nobody asked for.
   *
   * @param width - the pixels-per-tick to use.
   */
  const zoomTo = useCallback((width: number) => {
    const element = viewport.current
    if (element === null) return
    setScaleWidth(current => {
      const next = Math.min(MAX_SCALE_WIDTH, Math.max(MIN_SCALE_WIDTH, width))
      const anchor = element.clientWidth / 2
      const from = readScrollLeft()
      const wanted = (from + anchor) * (next / current) - anchor
      scrollTo(Math.max(0, Math.round(wanted)))
      return next
    })
  }, [])

  /*
   * The zoom controls a shortcut can reach.
   *
   * A ref rather than props: the shortcut lives in the panel, the zoom lives here, and the panel
   * has no business re-rendering every time the scale changes just so a key press can read it.
   */
  useEffect(() => {
    if (onZoomReady === undefined) return
    onZoomReady({
      in: () => zoomBy(ZOOM_STEP, null),
      out: () => zoomBy(1 / ZOOM_STEP, null),
      reset: () => zoomTo(DEFAULT_SCALE_WIDTH),
    })
    return () => onZoomReady(null)
  }, [onZoomReady, zoomBy, zoomTo])

  const subject = useMemo<EditSubject>(() => ({ clips, assetDurationUs }), [clips, assetDurationUs])
  /*
   * 轴的右端是**录制时长**，不是成片时长。
   *
   * 这一条是整个改动的地基：轴、刻度、片段位置、播放头、点击定位全都读同一个数。
   * 之前轴是成片时长（86 秒）而播放头是素材时间（0→2584 秒），于是点轴的 40 秒会把
   * 画面移到素材的 40 秒 —— 那是另一个时刻。
   */
  const assetSeconds = assetDurationUs / 1e6
  // 成片时长仍然要报：它是这一刀的结果，只是不再当轴用。
  const filmSeconds = useMemo(() => filmSecondsOf(clips), [clips])
  // 行只在时间线或所选轨道变化时重算。每次渲染都重建会让编辑器自己的数据与这份行互相覆盖 ——
  // 拖动刚拉长一段，随即被一份新算出的行按回原样。
  const rows = useMemo<TimelineRow[]>(() => [
    ...toRows(subject),
    ...evidenceRows(EVIDENCE_LANES.filter(lane => lanes[lane]), assetSeconds),
  ], [subject, lanes, assetSeconds])
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

  /*
   * Ctrl/⌘ + 滚轮缩放，锚在指针上。
   *
   * 监听器用原生注册而不是 React 的 `onWheel`：后者在 React 18 里是**被动**的，
   * `preventDefault()` 会被忽略，于是浏览器在缩放的同时还会横向滚动一次 —— 看起来就是
   * 「缩放了但跳到了别处」。`{ passive: false }` 是这里唯一能拦住它的写法。
   *
   * 不按修饰键时完全不干预：那种滚轮由库的滚动容器处理，是横向滚动，正是想要的。
   */
  useEffect(() => {
    const element = viewport.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      // 位移取符号即可：一格滚轮是一格缩放，触控板的细碎位移不该被放大成大幅跳变。
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, event.clientX - element.getBoundingClientRect().left)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  return (
    <div className={styles.timeline} data-timeline="">
      <div className={styles.bar}>
        <span className={styles.barLabel}>{t('column.timeline')}</span>
        {/*
         * 两个长度并排显示，因为它们回答不同的问题：刻度上的轴是**录制**（素材多长、
         * 哪几段被用了、中间空了哪些），而这个读数是**成片**（按倍速折算后有多长）。
         * 只给一个数会让人以为轴就是成片，那正是先前那个错。
         */}
        <span className={styles.barHint} data-lengths="">
          {t('timeline.lengths', {
            source: (assetDurationUs / 1e6).toFixed(1),
            film: filmSeconds.toFixed(1),
          })}
        </span>
        <span className={styles.barSpacer} />
        <button
          type="button" className={styles.zoomButton} data-zoom="out"
          aria-label={t('timeline.zoomOut')} title={t('timeline.zoomOut')}
          onClick={() => zoomBy(1 / ZOOM_STEP, null)}
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
          onClick={() => zoomBy(ZOOM_STEP, null)}
        >＋</button>
      </div>

      <div className={styles.lane} ref={viewport} data-timeline-viewport="">
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
                    filmSeconds={assetSeconds}
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
