/**
 * The workbench: an editing surface laid out the way an editor is, not as four equal columns.
 *
 * The shape follows what the task needs, which an equal split obscured: the picture is what
 * gets judged, so it takes the largest area; the timeline is where cuts are read and runs the
 * full width beneath everything, because a clip's position only means something against the
 * whole recording; and the clip list and the finished film sit at the edges where they can be
 * scanned without competing for the middle.
 *
 * The editor is rendered inside the root-scoped workbench drawer. It receives its selected asset
 * from the drawer and continues to read editor data through the plugin's own routes.
 *
 * The playhead is owned here rather than by the player, because the surfaces around it ask for
 * moments: a click on a clip or a bar becomes a seek request, the player performs it, and it
 * reports the position back. Nothing reads the video element directly, so there is one answer
 * to "where are we" instead of several that can disagree.
 */
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OutputList } from './OutputList.tsx'
import { Player } from './Player.tsx'
import { CompositionPlayer } from './CompositionPlayer.tsx'
import { copyAtIntent, revertIntent, type EditIntent, type EditableClip } from './editor-model.ts'
import { ClipActions } from './ClipActions.tsx'
import { Divider } from './Divider.tsx'
import { SubtitleOverlay } from './SubtitleOverlay.tsx'
import { cueAt, previewCues, previewStyle, type PreviewCue } from './subtitle-preview.ts'
import { RevisionList } from './RevisionList.tsx'
import { EVIDENCE_LANES, type EvidenceLaneKey } from './evidence-model.ts'
import { createWorkbenchLayoutStore, DEFAULT_LAYOUT, resolveDivision, resolveLowerHeight, type LayoutState } from './layout-store.ts'
import { Timeline, availableLanes, type ZoomControls } from './Timeline.tsx'
import { applyTimelineEdit, assetFromAddress, cancelExport, createTimeline, exportTimeline, mediaUrl, readEvidence, readHistory, readLoudness, readRenders, readTimelines, type EvidencePayload, type HistoryPayload, type Read, type WorkbenchAsset } from './read.ts'
import styles from './WorkbenchPanel.module.css'

/** What the panel reads: the owner share, this package's dictionary, and its layout store. */
type WorkbenchProps =
  PropsLocale<'workbench'>
  & PropsStore<ReturnType<typeof createWorkbenchLayoutStore>>

/** Dictionary key naming each lane, so the toggle row reads from the one dictionary. */
const EVIDENCE_LABELS = {
  transcript: 'evidence.transcript',
  screenText: 'evidence.screenText',
  shots: 'evidence.shots',
  silences: 'evidence.silences',
  loudness: 'evidence.loudness',
  chapters: 'evidence.chapters',
  highlights: 'evidence.highlights',
} as const satisfies Record<EvidenceLaneKey, string>

/** A read that has not settled yet. */
type Pending<T> = Read<T> | { readonly status: 'loading' }

/**
 * Resolve one dimension for the current asset, abandoning a superseded read.
 *
 * @param asset - the asset to read, or null while the address names none.
 * @param load - which reader to use.
 * @param within - a second identity the read depends on, for a dimension that is not keyed by the
 * asset alone. History belongs to a timeline, and one asset can carry several, so a reader that
 * ignored the timeline id would show the wrong timeline's revisions.
 * @returns The read state, which starts as loading.
 */
function useDimension<T>(
  asset: WorkbenchAsset | null,
  load: (asset: WorkbenchAsset, signal: AbortSignal) => Promise<Read<T>>,
  within?: string | null,
): Pending<T> {
  const [state, setState] = useState<Pending<T>>({ status: 'loading' })
  const key = asset === null ? '' : `${asset.projectId}/${asset.assetId}`
  // 依赖里带上第二重身份，但**读的时候不看它**：读哪一个由调用方闭包决定，
  // 这里只负责在它变化时重读。
  const fullKey = `${key}#${within ?? ''}`
  useEffect(() => {
    if (asset === null || within === null) { setState({ status: 'loading' }); return }
    const controller = new AbortController()
    setState({ status: 'loading' })
    void load(asset, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setState(result)
    })
    return () => controller.abort()
    // `load` is one module-level function per dimension, so the asset identity and `within` are
    // the only things that can change what is read.
  }, [fullKey])
  return state
}

/**
 * The cues a preview draws, from the spoken words.
 *
 * Reads the transcript rather than screen text: the spoken line is what a subtitle is normally made
 * of, and it is the one that lines up with what is being said at the playhead. A style set to
 * screen text is a separate case this preview does not draw yet — that gap is recorded in the
 * package README rather than papered over by silently previewing different words.
 *
 * @param tracks - the measured evidence, or null.
 * @param clips - the clips, in output order.
 * @returns The cues, in film order; empty when there is no transcript.
 */
function previewCuesOf(tracks: EvidencePayload['tracks'] | null, clips: readonly EditableClip[]): PreviewCue[] {
  if (tracks === null) return []
  return previewCues(clips, tracks.transcript ?? [])
}

/**
 * Build a reader for one timeline's revisions.
 *
 * A factory rather than a plain function because history is not keyed by the asset alone: one asset
 * can carry several timelines, so a reader that ignored the timeline id would show the wrong
 * timeline's revisions. The caller memoises the result per timeline id, which keeps the loader's
 * identity stable for as long as the identity it reads stays the same.
 *
 * @param timelineId - which timeline to read.
 * @returns A loader for that timeline.
 */
function historyLoader(timelineId: string): (asset: WorkbenchAsset, signal: AbortSignal) => Promise<Read<HistoryPayload>> {
  return (asset, signal) => readHistory(asset, timelineId, signal)
}

/**
 * Which known failure a rejected edit is, or null when it is none of them.
 *
 * Classification only — the sentence is the dictionary's. The two render sites already wrap the
 * reason in `timeline.saveFailed` / `export.failed`, so copy that lived here would arrive translated
 * inside a translated template, and the same failure would read two different ways depending on which
 * call reported it.
 *
 * @param error - whatever the rejected promise carried.
 * @returns the dictionary key for a recognised failure, or null.
 */
function classifyEditFailure(error: unknown): 'edit.conflict' | 'edit.notSaved' | null {
  const message = error instanceof Error ? error.message : String(error)
  // 时间线的乐观并发检查在版本被别处推进时以此措辞拒绝。
  if (message.includes('revision conflict')) return 'edit.conflict'
  if (message.includes('UNIQUE constraint') || message.includes('timeline_segments')) return 'edit.notSaved'
  return null
}

/**
 * The raw reason a rejected call carried, for the `{reason}` template slot.
 * @param error - whatever the rejected promise carried.
 * @returns the message text.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render the workbench.
 * @param props - the panel's owner share, its dictionary, and an optional asset override.
 * @returns the editing surface.
 */
export function WorkbenchPanel({ t, asset, initialTimelineId, onTimelineChange, useStore, actions }: WorkbenchProps & { readonly asset?: WorkbenchAsset | null, readonly initialTimelineId?: string | null, readonly onTimelineChange?: (timelineId: string | null) => void }): ReactNode {
  // 显式传 null 表示「未选中」，与「没传」不同 —— 用 ?? 会把前者也当成后者，
  // 于是调用方想说「什么都没有」时反而去读了地址。
  const target = useMemo(
    () => (asset === undefined ? assetFromAddress(window.location.hash, window.location.search) : asset),
    [asset],
  )
  const curve = useDimension(target, readLoudness)
  const [timelineRefresh, setTimelineRefresh] = useState(0)
  const [renderRefresh, setRenderRefresh] = useState(0)
  const [pollRenders, setPollRenders] = useState(false)
  const timelines = useDimension(target, readTimelines, String(timelineRefresh))
  const renders = useDimension(target, readRenders, String(renderRefresh))
  const evidence = useDimension(target, readEvidence)
  // 历史按时间线读，所以要等 active 拿到才知道读哪一条；`active?.id` 作为第二重身份，
  // 它一变就重读，而加载函数按 id 记忆化，避免每次渲染都换一个新函数。
  const [selectedTimelineId, setSelectedTimelineId] = useState<string | null>(null)
  useEffect(() => {
    if (timelines.status !== 'ok') return
    const ids = timelines.value.timelines.map(timeline => timeline.id)
    setSelectedTimelineId(current => {
      if (initialTimelineId !== null && initialTimelineId !== undefined && ids.includes(initialTimelineId)) return initialTimelineId
      return current !== null && ids.includes(current) ? current : ids[0] ?? null
    })
  }, [initialTimelineId, timelines.status === 'ok' ? timelines.value.timelines.map(timeline => timeline.id).join('\u0000') : ''])
  const activeId = selectedTimelineId
  const films = renders.status === 'ok' ? renders.value.renders : []
  const currentRenderIsActive = activeId !== null && films.some(film => film.timeline_id === activeId && (film.status === 'queued' || film.status === 'running'))
  const loadHistory = useMemo(() => (activeId === null ? null : historyLoader(activeId)), [activeId])
  const history = useDimension(target, loadHistory ?? (() => Promise.resolve({ status: 'absent' as const })), activeId === null ? null : `${activeId}:${timelineRefresh}`)
  const [seek, setSeek] = useState<{ atUs: number, token: number } | null>(null)
  const [playheadUs, setPlayheadUs] = useState(0)
  const [filmPlayheadUs, setFilmPlayheadUs] = useState(0)
  const [filmSeek, setFilmSeek] = useState<{ atUs: number, token: number } | null>(null)
  const [previewMode, setPreviewMode] = useState<'source' | 'composition'>('composition')
  const [sourceInUs, setSourceInUs] = useState<number | null>(null)
  const [sourceOutUs, setSourceOutUs] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
    /** Which known failure the last edit hit — a dictionary key — or the raw reason when unclassified. */
  const [editError, setEditError] = useState<'edit.conflict' | 'edit.notSaved' | { reason: string } | null>(null)
  // The exact state before this session's last undo. A fresh edit clears redo, so it
  // can never silently overwrite a newer cut.
  const [redoRevision, setRedoRevision] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
    /** Same shape as `editError`: a dictionary key for a recognised failure, otherwise the raw reason. */
  const [exportError, setExportError] = useState<'edit.conflict' | 'edit.notSaved' | { reason: string } | null>(null)
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null)
  const [exportAspect, setExportAspect] = useState<'keep' | '16:9' | '9:16' | '1:1'>('keep')
  const [burnSubtitles, setBurnSubtitles] = useState(false)
  // Evidence is supporting material, not the default editing surface. Showing every transcript,
  // OCR, chapter and highlight row on first open made the actual cut disappear below a wall of text.
  const [hidden, setHidden] = useState<readonly EvidenceLaneKey[]>([...EVIDENCE_LANES])
  // 每次请求带一个变化的 token，所以「再跳回同一秒」也会重新执行。
  const askSeek = useCallback((atUs: number) => {
    // Evidence is indexed in source time. Switching mode here makes a click on a transcript or
    // loudness mark truthful rather than seeking a similarly numbered moment in the finished film.
    setPreviewMode('source')
    setSeek({ atUs, token: Date.now() })
  }, [])
  /** The packed cut has its own coordinate system; keep it separate from source seeking. */
  const askFilmSeek = useCallback((atUs: number) => {
    setPreviewMode('composition')
    setFilmSeek({ atUs, token: Date.now() })
  }, [])
  /** Persist a deliberate editor gesture, then re-read the authoritative timeline. */
  const onEdit = useCallback((intent: EditIntent | null, preserveRedo = false) => {
    if (intent === null || target === null || saving) return
    if (!preserveRedo) setRedoRevision(null)
    setSaving(true)
    setEditError(null)
    void applyTimelineEdit(target, intent)
      .then(() => { setSelectedOrdinal(null); setTimelineRefresh(current => current + 1) })
      .catch(error => setEditError(classifyEditFailure(error) ?? { reason: reasonOf(error) }))
      .finally(() => setSaving(false))
  }, [saving, target])
  // 选中的片段由面板持有：时间线只报告「点了哪一段」，动作条是面板的一部分。
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(null)
  /*
   * 字幕预览默认关着。
   *
   * 它覆盖在画面上，而画面的主要用途是看素材；默认打开会让每一次播放都多一层文字，
   * 而这层文字只对正在调字幕的人有用。开着它是一次明确的选择，不是一个默认状态。
   */
  const [preview, setPreview] = useState(false)
  // 舞台尺寸由覆盖层自己量出来：样式里的字号是画面高度的**占比**，没有真实尺寸就算不出像素。
  const [stageSize, setStageSize] = useState<{ width: number, height: number } | null>(null)
  /**
   * 快捷键复制过的那一段。
   *
   * 放在组件 state 而不是声明的 store 里：剪贴板是一次手势，不是一项偏好；放 store 会让它
   * 跨重挂载活下来，那反而意外。
   */
  const [clipboard, setClipboard] = useState<EditableClip | null>(null)
  const [creatingTimeline, setCreatingTimeline] = useState(false)
  const [timelineCreateError, setTimelineCreateError] = useState<string | null>(null)
  /** 时间线交给面板的缩放控件；快捷键靠它触到缩放（见 Timeline 的 onZoomReady）。 */
  const zoomRef = useRef<ZoomControls | null>(null)
  const holdZoom = useCallback((controls: ZoomControls | null) => { zoomRef.current = controls }, [])
  const makeInitialTimeline = useCallback(async () => {
    if (target === null || curve.status !== 'ok' || curve.value.duration_us <= 0 || creatingTimeline) return
    setCreatingTimeline(true)
    setTimelineCreateError(null)
    try {
      await createTimeline(target.projectId, target.assetId)
      setTimelineRefresh(current => current + 1)
    } catch (error) {
      setTimelineCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreatingTimeline(false)
    }
  }, [creatingTimeline, curve, target])
  const exportFilm = useCallback(() => {
    if (target === null || activeId === null || exporting) return
    setExporting(true)
    setExportError(null)
    void exportTimeline(target, activeId, { aspect: exportAspect, ...(burnSubtitles ? { burnSubtitles: 'transcript' as const } : {}) })
      .then(() => { setPollRenders(true); setRenderRefresh(current => current + 1) })
      .catch(error => setExportError(classifyEditFailure(error) ?? { reason: reasonOf(error) }))
      .finally(() => setExporting(false))
  }, [activeId, burnSubtitles, exportAspect, exporting, target])
  const cancelFilm = useCallback((jobId: string) => {
    if (target === null || cancellingJobId !== null) return
    setCancellingJobId(jobId)
    void cancelExport(target.projectId, jobId)
      .then(() => { setPollRenders(true); setRenderRefresh(current => current + 1) })
      .catch(error => setExportError(classifyEditFailure(error) ?? { reason: reasonOf(error) }))
      .finally(() => setCancellingJobId(null))
  }, [cancellingJobId, target])
  useEffect(() => {
    if (!pollRenders) return
    if (!currentRenderIsActive && films.some(film => film.timeline_id === activeId)) {
      setPollRenders(false)
      return
    }
    const timer = window.setInterval(() => setRenderRefresh(current => current + 1), 2_000)
    return () => window.clearInterval(timer)
  }, [activeId, currentRenderIsActive, films, pollRenders])

  if (target === null) {
    return (
      <div className={styles.workbench} data-workbench="">
        <div className={styles.empty} data-workbench-empty="">
          <p className={styles.emptyTitle}>{t('source.none')}</p>
          <p className={styles.emptyHint}>{t('source.none.hint')}</p>
        </div>
      </div>
    )
  }

  const durationUs = curve.status === 'ok' ? curve.value.duration_us : 0
  // 一次只编辑一条时间线。把所有时间线的片段摊平会让不同时间线的序号相撞
  // （每条都从第 0 段开始），而编辑是按序号定位的 —— 那会改错片子。
  const active = timelines.status === 'ok' ? timelines.value.timelines.find(timeline => timeline.id === activeId) ?? null : null
  const clips = active?.clips ?? []
  // 时间线要的片段形态与读取结果不同：读取结果带的是份额（start/end），这里要的是微秒区间。
  const editableClips = clips.map(clip => ({
    ordinal: clip.ordinal, start_us: clip.start_us, end_us: clip.end_us, speed: clip.speed, muted: clip.muted, name: clip.name,
  }))
  const selectedClip = editableClips.find(clip => clip.ordinal === selectedOrdinal) ?? null
  const selectedRange = sourceInUs !== null && sourceOutUs !== null && sourceOutUs > sourceInUs
    ? { startUs: sourceInUs, endUs: sourceOutUs }
    : null
  const setSourceIn = useCallback(() => {
    setSourceInUs(playheadUs)
    if (sourceOutUs !== null && sourceOutUs <= playheadUs) setSourceOutUs(null)
  }, [playheadUs, sourceOutUs])
  const setSourceOut = useCallback(() => {
    setSourceOutUs(playheadUs)
    if (sourceInUs !== null && sourceInUs >= playheadUs) setSourceInUs(null)
  }, [playheadUs, sourceInUs])
  const appendSourceRange = useCallback(() => {
    if (selectedRange === null || active === null) return
    onEdit({ tool: 'video_timeline_add', args: { timeline_id: active.id, base_revision: active.revision, asset_id: target.assetId, start_us: selectedRange.startUs, end_us: selectedRange.endUs, speed: 1 } })
  }, [active, onEdit, selectedRange, target.assetId])
  const insertSourceRange = useCallback(() => {
    if (selectedRange === null || active === null) return
    const ordinal = selectedClip === null ? active.clips.length : selectedClip.ordinal + 1
    onEdit({ tool: 'video_timeline_insert', args: { timeline_id: active.id, base_revision: active.revision, asset_id: target.assetId, start_us: selectedRange.startUs, end_us: selectedRange.endUs, ordinal, speed: 1 } })
  }, [active, onEdit, selectedClip, selectedRange, target.assetId])
  // 快捷键要用到这两个 id；活动时间线还没读到时它们是 null，快捷键于是整体不生效。
  const timelineId = active?.id ?? null
  const assetId = target.assetId
  const tracks = evidence.status === 'ok' ? evidence.value.tracks : null
  // 只提供这条素材**真的有**的轨道：给一条空轨道会让人以为「这里没有停顿」，
  // 而实际是「停顿还没测过」—— 那是两个不同的结论。
  const offered = availableLanes(tracks)
  const laneVisibility = Object.fromEntries(
    EVIDENCE_LANES.map(lane => [lane, offered.includes(lane) && !hidden.includes(lane)]),
  ) as Record<EvidenceLaneKey, boolean>

  const layout = useStore(state => state)
  /*
   * 舞台的框由这里量，而不是由窗口尺寸推。
   *
   * 侧栏、对话列以及面板外面的留白都会改变可用宽度；按窗口宽度算会让分界线停在指针
   * 之外的位置，而那是这一处最容易出的错。
   */
  const stageBox = useRef<HTMLDivElement>(null)

  /**
   * 拖动开始时的指针位置与时间线高度。
   *
   * 两条竖直的分界线能从舞台自身的两条边直接解出宽度，所以不需要起点。横向那条不行 ——
   * 它的缝是时间线的**上缘**，而时间线的下缘不是舞台的任何一条边。所以那一条按位移解，
   * 位移只需要起点，不需要布局。
   */
  const lowerDrag = useRef<{ pointer: number, height: number } | null>(null)

  const dragLeft = useCallback((clientX: number) => {
    const box = stageBox.current?.getBoundingClientRect()
    if (box === undefined) return
    actions.setDivision('leftWidth', resolveDivision('leftWidth', clientX, box, layout))
  }, [actions, layout])

  const dragRight = useCallback((clientX: number) => {
    const box = stageBox.current?.getBoundingClientRect()
    if (box === undefined) return
    actions.setDivision('rightWidth', resolveDivision('rightWidth', clientX, box, layout))
  }, [actions, layout])

  /** 按下时记下起点：之后每一次移动都相对它算。 */
  const beginLower = useCallback((clientY: number) => {
    lowerDrag.current = { pointer: clientY, height: layout.lowerHeight }
  }, [layout.lowerHeight])

  const dragLower = useCallback((clientY: number) => {
    const start = lowerDrag.current
    if (start === null) return
    actions.setDivision('lowerHeight', resolveLowerHeight(start.height, start.pointer, clientY))
  }, [actions])

  const endLower = useCallback(() => { lowerDrag.current = null }, [])
  const noop = useCallback(() => {}, [])

  const step = useCallback((division: keyof LayoutState) => (delta: number) => {
    actions.setDivision(division, layout[division] + delta)
  }, [actions, layout])

  const reset = useCallback((division: keyof LayoutState) => () => {
    actions.setDivision(division, DEFAULT_LAYOUT[division])
  }, [actions])

  /**
   * Keyboard shortcuts for the selected clip and for zoom.
   *
   * Four rules, each for a reason that shows up in use:
   *
   * - **Nothing fires while a field has focus.** Otherwise typing a clip's name deletes clips. The
   *   rename box, the zoom slider and the seek bar are all keyboard-reachable.
   * - **Nothing fires outside this panel.** The workbench is one surface beside a conversation; a
   *   shortcut that removed a clip while somebody typed in the composer would be a bug with a long
   *   reach.
   * - **Zoom keys carry a modifier** — `Ctrl/⌘` plus `=`, `-` or `0`. Without one they are ordinary
   *   characters, and the rename box is not the only place somebody types.
   * - **Delete and Space stay unclaimed.** The seek bar uses arrows and a video element uses Space;
   *   taking those keys would break controls that already work.
   *
   * A shortcut produces the same tool call its button does, so it goes through the same channel and
   * leaves the same "proposed, not applied yet" marker. Nothing here writes.
   */
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const node = panel.current
      const target = event.target
      if (node === null || !(target instanceof HTMLElement)) return
      // 输入类控件里不抢键；否则给片段改名时打字会变成删片段。
      if (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]') !== null) return
      if (!node.contains(target)) return
      if (timelineId === null) return
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      const clip = editableClips.find(candidate => candidate.ordinal === selectedOrdinal) ?? null

      if (mod && (key === '=' || key === '+' || key === '-')) {
        event.preventDefault()
        if (key === '-') zoomRef.current?.out()
        else zoomRef.current?.in()
        return
      }
      if (mod && key === '0') { event.preventDefault(); zoomRef.current?.reset(); return }
      if (key === 'escape') { setSelectedOrdinal(null); return }
      if (mod && key === 'z' && active !== null && history.status === 'ok') {
        event.preventDefault()
        if (event.shiftKey) {
          if (redoRevision === null) return
          const targetRevision = redoRevision
          setRedoRevision(null)
          onEdit(revertIntent(active.id, active.revision, targetRevision), true)
          return
        }
        const previous = history.value.entries.find(entry => entry.revision < active.revision)
        if (previous === undefined) return
        setRedoRevision(active.revision)
        onEdit(revertIntent(active.id, active.revision, previous.revision), true)
        return
      }
      if (clip === null) return

      if (mod && (key === 'c' || key === 'x')) {
        event.preventDefault()
        setClipboard(clip)
        // 剪切＝复制 + 删除。两步都走同一条通道，所以留下的待确认标记与按钮一致。
        if (key === 'x') {
          onEdit({ tool: 'video_timeline_remove', args: { timeline_id: timelineId, base_revision: active?.revision ?? 0, ordinal: clip.ordinal } })
        }
        return
      }
      if (mod && (key === 'v' || key === 'd')) {
        // 粘贴与「复制一份」放在当前选择之后；不再悄悄追加到成片末尾。
        const source = key === 'v' ? clipboard : clip
        if (source === null || assetId === null) return
        event.preventDefault()
        onEdit(copyAtIntent(source, assetId, timelineId, active?.revision ?? 0, clip.ordinal + 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, assetId, clipboard, editableClips, history, onEdit, redoRevision, selectedOrdinal, timelineId])

  return (
    <div className={styles.workbench} data-workbench="" ref={panel}>
      <header className={styles.editorHeader} data-editor-context="">
        <div className={styles.editorContext}>
          <span className={styles.contextMode}>{previewMode === 'composition' ? t('preview.composition') : t('preview.source')}</span>
          <strong>{active?.name ?? (active === null ? t('timeline.none') : t('timeline.unnamed', { ordinal: '1' }))}</strong>
          {active !== null && <span className={styles.contextMeta}>{t('timeline.lengths', { source: (durationUs / 1e6).toFixed(1), film: active.output_seconds.toFixed(1) })}</span>}
        </div>
        <div className={styles.headerPreviewModes} role="group" aria-label={t('preview.mode')}>
          <button type="button" className={previewMode === 'composition' ? styles.previewModeOn : styles.previewMode} aria-pressed={previewMode === 'composition'} onClick={() => setPreviewMode('composition')}>
            {t('preview.composition')}
          </button>
          <button type="button" className={previewMode === 'source' ? styles.previewModeOn : styles.previewMode} aria-pressed={previewMode === 'source'} onClick={() => setPreviewMode('source')}>
            {t('preview.source')}
          </button>
        </div>
        <div className={styles.headerExport} data-export-controls="">
          <label className={styles.exportLabel}>
            <span>{t('export.aspect')}</span>
            <select value={exportAspect} disabled={active === null || exporting} onChange={event => setExportAspect(event.target.value as typeof exportAspect)}>
              <option value="keep">{t('export.keep')}</option>
              <option value="9:16">{t('export.portrait')}</option>
              <option value="16:9">{t('export.landscape')}</option>
              <option value="1:1">{t('export.square')}</option>
            </select>
          </label>
          <label className={styles.exportCheckbox}>
            <input type="checkbox" checked={burnSubtitles} disabled={active === null || exporting} onChange={event => setBurnSubtitles(event.target.checked)} />
            {t('export.subtitles')}
          </label>
          <button type="button" className={styles.exportButton} data-export-film="" disabled={active === null || exporting} onClick={exportFilm}>
            {exporting ? t('export.exporting') : t('export.button')}
          </button>
        </div>
        {exportError !== null && <p className={styles.exportHeaderError} role="alert">{typeof exportError === 'string' ? t(exportError) : t('export.failed', { reason: exportError.reason })}</p>}
        {previewMode === 'source' && (
          <div className={styles.sourceRange} data-source-range="">
            <button type="button" className={styles.rangeButton} onClick={setSourceIn}>{t('sourceRange.setIn')}</button>
            <span className={styles.rangeReadout}>
              {selectedRange === null
                ? t('sourceRange.empty')
                : t('sourceRange.selected', { start: (selectedRange.startUs / 1e6).toFixed(2), end: (selectedRange.endUs / 1e6).toFixed(2) })}
            </span>
            <button type="button" className={styles.rangeButton} onClick={setSourceOut}>{t('sourceRange.setOut')}</button>
            <button type="button" className={styles.rangeAction} disabled={selectedRange === null || active === null || saving} onClick={appendSourceRange}>{t('sourceRange.append')}</button>
            <button type="button" className={styles.rangeAction} disabled={selectedRange === null || active === null || saving} onClick={insertSourceRange}>{t('sourceRange.insert')}</button>
          </div>
        )}
      </header>
      <div className={styles.stage} ref={stageBox}>
        <aside className={styles.side} style={{ width: layout.leftWidth }} data-area="clips">
          <h2 className={styles.heading}>{t('timeline.trackVideo')}</h2>
          {timelines.status === 'ok' && timelines.value.timelines.length > 1 && (
            <label className={styles.timelinePicker}>
              <span>{t('timeline.choose')}</span>
              <select value={selectedTimelineId ?? ''} onChange={event => { const next = event.target.value || null; setSelectedTimelineId(next); onTimelineChange?.(next); setSelectedOrdinal(null) }}>
                {timelines.value.timelines.map((timeline, index) => <option key={timeline.id} value={timeline.id}>{timeline.name ?? t('timeline.unnamed', { ordinal: String(index + 1) })}</option>)}
              </select>
            </label>
          )}
          <div className={styles.rows}>
            {clips.length === 0
              ? <>
                <p className={styles.note}>{active === null ? t('timeline.none.hint') : t('timeline.empty.hint')}</p>
                <button
                  type="button"
                  className={styles.createTimeline}
                  disabled={active === null ? creatingTimeline || curve.status !== 'ok' : saving || durationUs <= 0}
                  onClick={() => {
                    if (active === null) { void makeInitialTimeline(); return }
                    onEdit({ tool: 'video_timeline_add', args: { timeline_id: active.id, base_revision: active.revision, asset_id: target.assetId, start_us: 0, end_us: durationUs, speed: 1 } })
                  }}
                >
                  {active === null ? (creatingTimeline ? t('timeline.creating') : t('timeline.create')) : t('timeline.empty.add')}
                </button>
                {timelineCreateError !== null && <p className={styles.note} role="alert">{timelineCreateError}</p>}
              </>
              : clips.map(clip => (
                <button
                  key={clip.ordinal}
                  type="button"
                  className={clip.ordinal === selectedOrdinal ? styles.clipRowSelected : styles.clipRow}
                  data-list-clip={clip.ordinal}
                  aria-pressed={clip.ordinal === selectedOrdinal}
                  /*
                   * 点列表里的一行既选中它、也让画面跳到它开头。
                   *
                   * 原来只跳转不选中，于是「在列表里点一段、再按 Ctrl+C」什么都不会发生 ——
                   * 而列表是选片段最自然的地方。动作条随之出现，否则看不出选中的是哪一段。
                   */
                  onClick={() => { setSelectedOrdinal(clip.ordinal); askSeek(clip.start_us) }}
                >
                  <span className={styles.clipIndex}>{clip.ordinal + 1}</span>
                  {/* 人起的名字优先于序号：序号是位置，名字是这一段是什么。
                      没起过名时不显示占位文本 —— 那会让每一段看起来都像被命名过。 */}
                  {clip.name !== null && <span className={styles.clipName} data-clip-name={clip.ordinal}>{clip.name}</span>}
                  <span className={styles.clipTimes}>
                    <span>{t('timeline.seconds', { value: (clip.start_us / 1e6).toFixed(1) })}</span>
                    <span className={styles.clipMeta}>
                      {t('timeline.seconds', { value: (((clip.end_us - clip.start_us) / 1e6) / (clip.speed === 0 ? 1 : clip.speed)).toFixed(1) })}
                      {clip.speed !== 1 ? ` · ${t('timeline.speed', { speed: String(clip.speed) })}` : ''}
                      {clip.muted ? ` · ${t('timeline.muted')}` : ''}
                    </span>
                  </span>
                </button>
              ))}
          </div>
          {/* 版本列表放在片段下面：它回答的是「改坏了怎么回去」，
              而片段列表回答的是「现在是什么」。两者都属于这一列。 */}
          <h2 className={styles.heading} data-history-heading="">{t('revision.heading')}</h2>
          <div className={styles.historyActions} role="group" aria-label={t('revision.heading')}>
            <button
              type="button"
              className={styles.historyAction}
              disabled={saving || active === null || history.status !== 'ok' || !history.value.entries.some(entry => entry.revision < active.revision)}
              onClick={() => {
                if (active === null || history.status !== 'ok') return
                const previous = history.value.entries.find(entry => entry.revision < active.revision)
                if (previous === undefined) return
                setRedoRevision(active.revision)
                onEdit(revertIntent(active.id, active.revision, previous.revision), true)
              }}
            >{t('revision.undo')}</button>
            <button
              type="button"
              className={styles.historyAction}
              disabled={saving || active === null || redoRevision === null}
              onClick={() => {
                if (active === null || redoRevision === null) return
                const targetRevision = redoRevision
                setRedoRevision(null)
                onEdit(revertIntent(active.id, active.revision, targetRevision), true)
              }}
            >{t('revision.redo')}</button>
          </div>
          <div className={styles.rows}>
            <RevisionList
              currentRevision={active?.revision ?? 0}
              history={history.status === 'ok' || history.status === 'absent' || history.status === 'failed'
                ? history
                : { status: 'loading' }}
              onRestore={target => onEdit(
                target === null || active === null ? null : revertIntent(active.id, active.revision, target),
              )}
              proposed={null}
              t={t}
            />
          </div>
        </aside>

        <Divider
          axis="row"
          label={t('layout.leftSplit')}
          onDragEnd={noop}
          onDragStart={noop}
          onDragTo={dragLeft}
          onReset={reset('leftWidth')}
          onStep={step('leftWidth')}
        />

        <section className={styles.viewer} data-area="viewer">
          {/*
           * 预览叠在画面上，位置就是它在成片里的位置 ——「底部居中」和「左上角」是不同的
           * 决定，画在另一条横条里会让两者看起来一样。
           *
           * 显示哪一句由**成片坐标**决定，与导出、烧录用的是同一条换算路径；三者共用它，
           * 才能保证「看到的」和「烧出来的」是同一句话落在同一个时刻。
          */}
          <div className={styles.stageWrap}>
            {previewMode === 'composition' && active !== null
              ? <CompositionPlayer asset={target} clips={active.clips} onFilmTime={setFilmPlayheadUs} onSourceTime={setPlayheadUs} seek={filmSeek} t={t} />
              : <Player src={mediaUrl(target)} seek={seek} durationUs={durationUs} onTime={setPlayheadUs} t={t} />}
            {preview ? (
              <SubtitleOverlay
                cue={cueAt(previewCuesOf(tracks, editableClips), playheadUs / 1e6)}
                onStageMeasured={setStageSize}
                style={stageSize === null ? null : previewStyle(active?.subtitle_style ?? null, stageSize)}
              />
            ) : null}
          </div>
        </section>

        <Divider
          axis="row"
          label={t('layout.rightSplit')}
          onDragEnd={noop}
          onDragStart={noop}
          onDragTo={dragRight}
          onReset={reset('rightWidth')}
          onStep={step('rightWidth')}
        />

        <aside className={styles.side} style={{ width: layout.rightWidth }} data-area="output">
          <h2 className={styles.heading}>{t('column.output')}</h2>
          <div className={styles.rows}>
            <OutputList renders={films} onCancel={cancelFilm} cancellingJobId={cancellingJobId} t={t} />
          </div>
        </aside>
      </div>

      <Divider
        axis="column"
        label={t('layout.timelineSplit')}
        onDragEnd={endLower}
        onDragStart={beginLower}
        onDragTo={dragLower}
        onReset={reset('lowerHeight')}
        onStep={step('lowerHeight')}
      />

      <section className={styles.lower} style={{ height: layout.lowerHeight }} data-area="timeline">
        <Timeline
          assetDurationUs={durationUs}
          axis={previewMode === 'composition' ? 'film' : 'source'}
          baseRevision={active?.revision ?? 0}
          clips={editableClips}
          evidence={previewMode === 'source' && evidence.status === 'ok' ? evidence.value.tracks : null}
          lanes={previewMode === 'source' ? laneVisibility : Object.fromEntries(EVIDENCE_LANES.map(lane => [lane, false])) as Record<EvidenceLaneKey, boolean>}
          onEdit={onEdit}
          onSeek={previewMode === 'composition' ? askFilmSeek : askSeek}
          onSelectClip={setSelectedOrdinal}
          onZoomReady={holdZoom}
          pendingOrdinals={[]}
          playheadUs={previewMode === 'composition' ? filmPlayheadUs : playheadUs}
          t={t}
          timelineId={active?.id ?? null}
        />
      </section>

      <ClipActions
        baseRevision={active?.revision ?? 0}
        clip={selectedClip}
        clips={editableClips}
        onIntent={onEdit}
        playheadUs={playheadUs}
        saving={saving}
        t={t}
        timelineId={active?.id ?? null}
      />

      <div className={styles.lanes} data-lane-controls="">
          <span className={styles.lanesLabel}>{t('evidence.lanes')}</span>
          {offered.length === 0
            ? <span className={styles.lanesNone} data-evidence-none="">{t('evidence.none')}</span>
            : offered.map(lane => (
              <button
                key={lane}
                type="button"
                className={hidden.includes(lane) ? styles.laneOff : styles.laneOn}
                data-lane-toggle={lane}
                aria-pressed={!hidden.includes(lane)}
                onClick={() => setHidden(current => current.includes(lane) ? current.filter(item => item !== lane) : [...current, lane])}
              >
                {t(EVIDENCE_LABELS[lane])}
              </button>
            ))}
          {/* 字幕预览只影响画面，不改变证据或时间线。 */}
          <span className={styles.lanesGap} />
          <button
            type="button"
            className={preview ? styles.laneOn : styles.laneOff}
            data-subtitle-preview-toggle=""
            aria-pressed={preview}
            onClick={() => setPreview(current => !current)}
            title={t('subtitle.previewHint')}
          >
            {t('subtitle.preview')}
          </button>
      </div>

      {/*
       * 快捷键写在这里而不是藏进帮助：没有提示的快捷键等于不存在，而这一行本来就空着 ——
       * 所以它不占新的高度。
       */}
      <p className={styles.shortcuts} data-shortcuts="">{t('shortcuts.hint')}</p>

      {saving && <p className={styles.pending} data-save-state="saving">{t('timeline.saving')}</p>}
      {editError !== null && <p className={styles.note} data-save-error="" role="alert">{typeof editError === 'string' ? t(editError) : t('timeline.saveFailed', { reason: editError.reason })}</p>}

      {curve.status === 'absent' && (
        <p className={styles.note}>
          {t('source.missing.hint', { asset: target.assetId, project: target.projectId })}
        </p>
      )}
    </div>
  )
}
