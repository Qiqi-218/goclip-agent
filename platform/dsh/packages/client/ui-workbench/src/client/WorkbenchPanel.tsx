/**
 * The workbench: an editing surface laid out the way an editor is, not as four equal columns.
 *
 * The shape follows what the task needs, which an equal split obscured: the picture is what
 * gets judged, so it takes the largest area; the timeline is where cuts are read and runs the
 * full width beneath everything, because a clip's position only means something against the
 * whole recording; and the clip list and the finished film sit at the edges where they can be
 * scanned without competing for the middle.
 *
 * The panel is registered into the keyed `main` slot, whose owner passes no props and whose
 * scope is `root` — so it holds no Session binding and cannot read tool results the way a
 * Session-scoped panel does. It learns which asset to show from the page address and reads the
 * measurements over the plugin's own read-only route.
 *
 * The playhead is owned here rather than by the player, because the surfaces around it ask for
 * moments: a click on a clip or a bar becomes a seek request, the player performs it, and it
 * reports the position back. Nothing reads the video element directly, so there is one answer
 * to "where are we" instead of several that can disagree.
 */
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OutputList } from './OutputList.tsx'
import { Player } from './Player.tsx'
import { clipOfIntent, copyToEndIntent, revertIntent, type EditIntent, type EditableClip } from './editor-model.ts'
import { ClipActions } from './ClipActions.tsx'
import { Divider } from './Divider.tsx'
import { SubtitleOverlay } from './SubtitleOverlay.tsx'
import { cueAt, previewCues, previewStyle, type PreviewCue } from './subtitle-preview.ts'
import { RevisionList } from './RevisionList.tsx'
import { EVIDENCE_LANES, type EvidenceLaneKey } from './evidence-model.ts'
import { createWorkbenchLayoutStore, DEFAULT_LAYOUT, resolveDivision, resolveLowerHeight, type LayoutState } from './layout-store.ts'
import { Timeline, availableLanes, type ZoomControls } from './Timeline.tsx'
import { assetFromAddress, mediaUrl, readEvidence, readHistory, readLoudness, readRenders, readTimelines, type EvidencePayload, type HistoryPayload, type Read, type WorkbenchAsset } from './read.ts'
import styles from './WorkbenchPanel.module.css'

/** What the panel reads: the owner share, this package's dictionary, and its layout store. */
type WorkbenchProps =
  & PropsRuntime<'main'>
  & PropsLocale<'workbench'>
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
 * Render the workbench.
 * @param props - the panel's owner share, its dictionary, and an optional asset override.
 * @returns the editing surface.
 */
export function WorkbenchPanel({ t, asset, useStore, actions }: WorkbenchProps & { readonly asset?: WorkbenchAsset | null }): ReactNode {
  // 显式传 null 表示「未选中」，与「没传」不同 —— 用 ?? 会把前者也当成后者，
  // 于是调用方想说「什么都没有」时反而去读了地址。
  const target = useMemo(
    () => (asset === undefined ? assetFromAddress(window.location.hash, window.location.search) : asset),
    [asset],
  )
  const curve = useDimension(target, readLoudness)
  const timelines = useDimension(target, readTimelines)
  const renders = useDimension(target, readRenders)
  const evidence = useDimension(target, readEvidence)
  // 历史按时间线读，所以要等 active 拿到才知道读哪一条；`active?.id` 作为第二重身份，
  // 它一变就重读，而加载函数按 id 记忆化，避免每次渲染都换一个新函数。
  const activeId = timelines.status === 'ok' ? timelines.value.timelines[0]?.id ?? null : null
  const loadHistory = useMemo(() => (activeId === null ? null : historyLoader(activeId)), [activeId])
  const history = useDimension(target, loadHistory ?? (() => Promise.resolve({ status: 'absent' as const })), activeId)
  const [seek, setSeek] = useState<{ atUs: number, token: number } | null>(null)
  const [playheadUs, setPlayheadUs] = useState(0)
  const [pending, setPending] = useState<readonly number[]>([])
  const [hidden, setHidden] = useState<readonly EvidenceLaneKey[]>([])
  // 每次请求带一个变化的 token，所以「再跳回同一秒」也会重新执行。
  const askSeek = useCallback((atUs: number) => setSeek({ atUs, token: Date.now() }), [])
  /**
   * Record what the person asked for, without applying it.
   *
   * The message names the tool and its arguments so a person can see that the gesture was
   * understood, and marks the affected clip — or the proposed revision — so the surface shows it
   * as not yet the host's state. Sending the call is deliberately not done here: the tool layer is
   * the only writer, and it carries the revision check that keeps two editors from overwriting
   * each other.
   *
   * @param intent - the call the gesture implies, or null when it changed nothing.
   */
  const onEdit = useCallback((intent: EditIntent | null) => {
    if (intent === null) { setPending([]); setProposedRevision(null); setLastEdit(null); return }
    // 两种时间线级的意图影响的不是某一段：回滚标在某个版本上，改名根本不针对片段。
    // 一律当成「序号」会让回滚把某个无关的片段标成待确认。
    if (intent.tool === 'video_timeline_revert') {
      setPending([])
      setProposedRevision(intent.args.target_revision)
    } else {
      setProposedRevision(null)
      const ordinal = clipOfIntent(intent)
      setPending(ordinal === null ? [] : [ordinal])
    }
    setLastEdit(intent)
  }, [])
  const [lastEdit, setLastEdit] = useState<EditIntent | null>(null)
  const [proposedRevision, setProposedRevision] = useState<number | null>(null)
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
  /** 时间线交给面板的缩放控件；快捷键靠它触到缩放（见 Timeline 的 onZoomReady）。 */
  const zoomRef = useRef<ZoomControls | null>(null)
  const holdZoom = useCallback((controls: ZoomControls | null) => { zoomRef.current = controls }, [])

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
  const active = timelines.status === 'ok' ? timelines.value.timelines[0] ?? null : null
  const clips = active?.clips ?? []
  // 时间线要的片段形态与读取结果不同：读取结果带的是份额（start/end），这里要的是微秒区间。
  const editableClips = clips.map(clip => ({
    ordinal: clip.ordinal, start_us: clip.start_us, end_us: clip.end_us, speed: clip.speed, muted: clip.muted, name: clip.name,
  }))
  const selectedClip = editableClips.find(clip => clip.ordinal === selectedOrdinal) ?? null
  // 快捷键要用到这两个 id；活动时间线还没读到时它们是 null，快捷键于是整体不生效。
  const timelineId = active?.id ?? null
  const assetId = target.assetId
  const films = renders.status === 'ok' ? renders.value.renders : []
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
        // 粘贴与「复制一份」在宿主这里是同一个动作：追加一段同样的素材。见 copyToEndIntent。
        const source = key === 'v' ? clipboard : clip
        if (source === null || assetId === null) return
        event.preventDefault()
        onEdit(copyToEndIntent(source, assetId, timelineId, active?.revision ?? 0))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active?.revision, assetId, clipboard, editableClips, onEdit, selectedOrdinal, timelineId])

  return (
    <div className={styles.workbench} data-workbench="" ref={panel}>
      <div className={styles.stage} ref={stageBox}>
        <aside className={styles.side} style={{ width: layout.leftWidth }} data-area="clips">
          <h2 className={styles.heading}>{t('timeline.trackVideo')}</h2>
          <div className={styles.rows}>
            {clips.length === 0
              ? <p className={styles.note}>{t('timeline.none.hint')}</p>
              : clips.map(clip => (
                <button
                  key={clip.ordinal}
                  type="button"
                  className={styles.clipRow}
                  data-list-clip={clip.ordinal}
                  data-list-pending={pending.includes(clip.ordinal) ? '' : undefined}
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
          <div className={styles.rows}>
            <RevisionList
              currentRevision={active?.revision ?? 0}
              history={history.status === 'ok' || history.status === 'absent' || history.status === 'failed'
                ? history
                : { status: 'loading' }}
              onRestore={target => onEdit(
                target === null || active === null ? null : revertIntent(active.id, active.revision, target),
              )}
              proposed={proposedRevision}
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
            <Player src={mediaUrl(target)} seek={seek} durationUs={durationUs} onTime={setPlayheadUs} t={t} />
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
            <OutputList renders={films} t={t} />
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
          baseRevision={active?.revision ?? 0}
          clips={editableClips}
          evidence={evidence.status === 'ok' ? evidence.value.tracks : null}
          lanes={laneVisibility}
          onEdit={onEdit}
          onSeek={askSeek}
          onSelectClip={setSelectedOrdinal}
          onZoomReady={holdZoom}
          pendingOrdinals={pending}
          playheadUs={playheadUs}
          t={t}
          timelineId={active?.id ?? null}
        />
      </section>

      <ClipActions
        baseRevision={active?.revision ?? 0}
        clip={selectedClip}
        clips={editableClips}
        onIntent={onEdit}
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
        {/*
         * 字幕预览的开关放在这一行末端，与证据轨道之间留一段空：它不改变时间线，
         * 只决定画面上要不要多一层文字 —— 混在轨道开关里会让人以为它也会改时间线。
         */}
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

      {lastEdit !== null && (
        <p className={styles.pending} data-pending-edit="">
          {t('timeline.pendingEdit', {
            tool: lastEdit.tool,
            args: JSON.stringify(lastEdit.args),
          })}
        </p>
      )}

      {curve.status === 'absent' && (
        <p className={styles.note}>
          {t('source.missing.hint', { asset: target.assetId, project: target.projectId })}
        </p>
      )}
    </div>
  )
}
