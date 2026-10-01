/**
 * One project's whole workspace: its footage, its timelines, its finished cuts.
 *
 * The panel is a reader of the local video-agent service, not a second store: it
 * asks the same HTTP actions the agent's tools use and renders what comes back,
 * so nothing here can disagree with what the model was told. Playback is the
 * point — the service streams source bytes and finished cuts with Range support,
 * so a player on this page can seek instead of only downloading.
 *
 * @module dsh-video-workspace/client/Workbench
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, IconPlayOutlineRegular,
  IconRefreshOutlineRegular, TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Workbench.module.css'

/** Where the local video-agent service listens. */
export const SERVICE = 'http://127.0.0.1:8090'

/** One project as `project_list` reports it. */
interface Project {
  readonly id: string
  readonly name: string
  readonly asset_count?: number
}

/** One asset as `assets_list` reports it. */
interface Asset {
  readonly id: string
  readonly duration_us?: number
  readonly width?: number
  readonly height?: number
  readonly has_audio?: boolean
  readonly path?: string
}

/** One clip of a timeline revision. */
interface Clip {
  readonly id?: string
  readonly asset_id?: string
  readonly source_in_us?: number
  readonly source_out_us?: number
}

/** One timeline revision as `timeline_list` returns it. */
interface Timeline {
  readonly id: string
  readonly revision?: number
  readonly project_id?: string
  readonly items?: readonly Clip[]
}

/** One render job as `jobs_list` returns it. */
interface Job {
  readonly id: string
  readonly timeline_id?: string
  readonly status?: string
  readonly progress?: number
  readonly output?: string
  readonly error?: string
}

interface CurveSecond {
  readonly start_us: number
  readonly end_us: number
  readonly dbfs: number
  readonly event?: string
}

/** One measured second of the loudness curve, ready to draw. */
interface Level {
  readonly startUS: number
  readonly db: number
}

/** The service's response envelope. */
interface Envelope<T> {
  readonly ok?: boolean
  readonly result?: T
  readonly error?: { readonly code?: string; readonly message?: string }
}

/**
 * Invoke one service action.
 * @param action - the action name, matching the service's dispatch.
 * @param body - the action's input object.
 * @returns the action's result.
 * @throws Error carrying the service's own message when it refuses.
 */
async function call<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${SERVICE}/v1/tools/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const envelope = await response.json() as Envelope<T>
  if (envelope.error !== undefined) {
    throw new Error(envelope.error.message ?? envelope.error.code ?? '剪辑服务拒绝了这次请求')
  }
  if (!response.ok || envelope.ok !== true) {
    throw new Error(`剪辑服务返回 HTTP ${String(response.status)}`)
  }
  return envelope.result as T
}

/**
 * Store one picked file and record it as an asset of the open project.
 *
 * The bytes go to the service and the service imports them, in one request.
 * A browser cannot hand the host a filesystem path it never had — picking a
 * file only ever produces bytes — so the import has to happen where the bytes
 * land.
 *
 * @param projectId - the project the footage belongs to.
 * @param file - the file the operator picked or dropped.
 * @returns the imported asset's id.
 * @throws Error carrying the service's own message when it refuses.
 */
async function ingest(projectId: string, file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch(`${SERVICE}/v1/projects/${encodeURIComponent(projectId)}/assets`, {
    method: 'POST',
    body: form,
  })
  const envelope = await response.json() as Envelope<{ readonly id?: string }>
  if (envelope.error !== undefined) {
    throw new Error(envelope.error.message ?? envelope.error.code ?? '导入失败')
  }
  if (!response.ok || envelope.ok !== true) {
    throw new Error(`导入失败（HTTP ${String(response.status)}）`)
  }
  return envelope.result?.id ?? ''
}

/** Format a microsecond offset as `m:ss`. */
function clock(us: number | undefined): string {
  if (typeof us !== 'number' || !Number.isFinite(us) || us < 0) return '—'
  const total = Math.round(us / 1_000_000)
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Draw one asset's measured loudness as one bar per second.
 *
 * The bars are real measurements at real timestamps, not a decoration: hovering
 * names the second and its level, and clicking opens the source at that moment.
 * That is the whole point of measuring — the curve a viewer sees is the same
 * series of numbers the model retrieved, so a claim about where the recording
 * got loud can be checked against the picture beside it.
 *
 * @param props - the measured windows, and what to do when one is picked.
 * @returns the curve.
 */
function LoudnessCurve({ levels, onPick }: {
  readonly levels: readonly Level[]
  readonly onPick: (startUS: number) => void
}) {
  // A fixed vertical scale over the whole range keeps bars comparable; scaling
  // each bar to its own value would make a flat recording look eventful.
  const top = Math.max(...levels.map(level => level.db))
  const bottom = Math.min(...levels.map(level => level.db))
  const span = Math.max(top - bottom, 1)
  // Seeded from the first entry rather than reduced from a sentinel, so the
  // result is a real measurement rather than a value invented for comparison.
  let loudest = levels[0]
  for (const level of levels) {
    if (loudest === undefined || level.db > loudest.db) loudest = level
  }
  if (loudest === undefined) return null

  return <div className={css.curve}>
    <div className={css.curveBars}>
      {levels.map(level => <button
        key={level.startUS}
        type="button"
        className={css.curveBar}
        style={{ height: `${String(8 + 92 * ((level.db - bottom) / span))}%` }}
        data-peak={level.startUS === loudest.startUS || undefined}
        title={`${clock(level.startUS)} · ${level.db.toFixed(1)} dBFS`}
        aria-label={`${clock(level.startUS)} 音量 ${level.db.toFixed(1)} dBFS`}
        onClick={() => { onPick(level.startUS) }}
      />)}
    </div>
    <div className={css.curveFoot}>
      <span className={css.dim}>最响 {clock(loudest.startUS)} · {loudest.db.toFixed(1)} dBFS</span>
      <span className={css.dim}>范围 {(top - bottom).toFixed(1)} dB</span>
    </div>
  </div>
}

/**
 * Choose a still to stand for a finished cut before it plays.
 *
 * A `<video>` with no poster shows an empty rectangle until the browser has
 * decoded a frame, which makes a list of finished cuts look like a list of
 * failures. The still is the frame the cut opens on, which the service decodes
 * from the clip's own in-point: only the service holds the render plan, and
 * working the source frame out here would mean guessing which of an asset's
 * sampled frames corresponds to a given instant.
 *
 * @param job - the finished render.
 * @returns the poster URL.
 */
function posterFor(job: Job): string {
  return `${SERVICE}/v1/artifacts/${job.id}/poster.jpg`
}

/**
 * Render the video workbench.
 * @returns the panel: a project picker, its footage, its timelines, its cuts.
 */
export function Workbench() {
  const [projects, setProjects] = useState<readonly Project[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [assets, setAssets] = useState<readonly Asset[]>([])
  const [timelines, setTimelines] = useState<readonly Timeline[]>([])
  const [jobs, setJobs] = useState<readonly Job[]>([])
  const [levels, setLevels] = useState<readonly Level[]>([])
  const [busy, setBusy] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<{ readonly src: string; readonly label: string } | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadProjects = useCallback(async (): Promise<readonly Project[]> => {
    const list = await call<readonly Project[]>('project_list', {})
    if (!alive.current) return []
    setProjects(list)
    return list
  }, [])

  const loadProject = useCallback(async (projectId: string): Promise<void> => {
    const [assetMap, timelineList] = await Promise.all([
      call<Record<string, Asset>>('assets_list', { project_id: projectId }),
      call<readonly Timeline[]>('timeline_list', { project_id: projectId }),
    ])
    const allJobs = await call<readonly Job[]>('jobs_list', {})
    // The curve comes from the measurement itself rather than from keyword
    // retrieval: retrieval caps a page at 100 rows, which silently shortened the
    // picture of any asset longer than a hundred seconds. `level_curve` answers
    // for the whole asset, and it is the same series the model reads.
    const windows: Level[] = []
    for (const asset of Object.values(assetMap)) {
      const curve = await call<{ readonly seconds?: readonly CurveSecond[] }>(
        'level_curve', { project_id: projectId, asset_id: asset.id })
      for (const second of curve.seconds ?? []) {
        windows.push({ startUS: second.start_us, db: second.dbfs })
      }
    }
    windows.sort((a, b) => a.startUS - b.startUS)
    if (!alive.current) return
    const timelineIds = new Set(timelineList.map(t => t.id))
    setAssets(Object.values(assetMap))
    setTimelines(timelineList)
    setJobs(allJobs.filter(j => j.timeline_id !== undefined && timelineIds.has(j.timeline_id)))
    setLevels(windows)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const list = await loadProjects()
      const target = active ?? list.find(p => (p.asset_count ?? 0) > 0)?.id ?? list[0]?.id ?? null
      setActive(target)
      if (target !== null) await loadProject(target)
      else {
        setAssets([])
        setTimelines([])
        setJobs([])
      }
    } catch (error) {
      if (alive.current) setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [active, loadProject, loadProjects])

  useEffect(() => { void refresh() }, [refresh])

  // A render that is still running is the only thing worth polling for; stop as
  // soon as nothing is pending so an idle panel issues no requests at all.
  const pending = useMemo(
    () => jobs.some(j => j.status === 'queued' || j.status === 'running'),
    [jobs],
  )
  useEffect(() => {
    if (!pending || active === null) return undefined
    const timer = setInterval(() => { void loadProject(active).catch(() => {}) }, 3000)
    return () => { clearInterval(timer) }
  }, [pending, active, loadProject])

  const finished = jobs.filter(j => j.status === 'completed')
  const failed = jobs.filter(j => j.status === 'failed' || j.status === 'canceled')

  /**
   * Import one file into the open project and re-read the project afterwards, so
   * the new footage appears without a manual refresh.
   * @param file - the picked or dropped file.
   */
  const importFile = useCallback(async (file: File): Promise<void> => {
    if (active === null) {
      setNotice('先选一个项目，再导入素材。')
      return
    }
    setImporting(file.name)
    setNotice(null)
    setProblem(null)
    try {
      await ingest(active, file)
      await loadProject(active)
      if (alive.current) setNotice(`已导入 ${file.name}`)
    } catch (error) {
      if (alive.current) setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      if (alive.current) setImporting(null)
    }
  }, [active, loadProject])

  return <div
    className={css.shell}
    data-dragging={dragging || undefined}
    onDragOver={(event) => {
      event.preventDefault()
      setDragging(true)
    }}
    onDragLeave={(event) => {
      // Only clear when the pointer actually left the panel, not when it crossed
      // an inner element.
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setDragging(false)
    }}
    onDrop={(event) => {
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer.files[0]
      if (file !== undefined) void importFile(file)
    }}
  >
    <header className={css.bar}>
      <span className={css.brand}><IconPlayOutlineRegular size={16} />剪辑工作台</span>
      <label className={css.picker}>
        <IconFolderOpenOutlineRegular size={14} />
        <select
          className={css.select}
          value={active ?? ''}
          onChange={(event) => {
            setActive(event.target.value)
            void loadProject(event.target.value).catch(() => {})
          }}
        >
          {projects.length === 0 ? <option value="">（还没有项目）</option> : null}
          {projects.map(p => <option key={p.id} value={p.id}>
            {p.name}（{p.asset_count ?? 0} 个素材）
          </option>)}
        </select>
        <IconChevronDownOutlineRegular size={12} className={css.selectCaret} />
      </label>
      <input
        ref={picker}
        className={css.fileInput}
        type="file"
        accept="video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file !== undefined) void importFile(file)
          event.target.value = ''
        }}
      />
      <button
        type="button"
        className={css.action}
        onClick={() => { picker.current?.click() }}
        disabled={active === null || importing !== null}
      >
        <IconFolderOpenOutlineRegular size={14} />
        {importing === null ? '导入素材' : '导入中…'}
      </button>
      <button type="button" className={css.action} onClick={() => { void refresh() }} disabled={busy}>
        <IconRefreshOutlineRegular size={14} />刷新
      </button>
    </header>

    {problem === null ? null : <div className={css.problem} role="alert">
      <strong>连接不上剪辑服务</strong>
      <p>{problem}</p>
      <p className={css.problemHint}>
        在终端里启动它：<code>video-agent --data &lt;数据目录&gt; serve --addr 127.0.0.1:8090</code>
      </p>
    </div>}

    {notice === null ? null : <p className={css.notice} role="status">{notice}</p>}

    <div className={css.columns}>
      <section className={css.pane} aria-label="素材">
        <h2 className={css.paneHead}>素材 <span className={css.count}>{assets.length}</span></h2>
        {assets.length === 0
          ? <p className={css.empty}>这个项目还没有素材。在对话里让我导入，或把视频拖到对话窗口。</p>
          : <ul className={css.assetList}>
            {assets.map(asset => <li key={asset.id} className={css.asset}>
              <video
                className={css.thumb}
                src={`${SERVICE}/v1/assets/${asset.id}/file#t=0.5`}
                poster={`${SERVICE}/v1/assets/${asset.id}/thumbnail.jpg`}
                preload="metadata"
                muted
                playsInline
              />
              <div className={css.assetMeta}>
                <span className={css.assetName} title={asset.path ?? ''}>
                  {(asset.path ?? asset.id).replace(/\\/g, '/').split('/').pop()}
                </span>
                <span className={css.dim}>
                  {clock(asset.duration_us)} · {asset.width}×{asset.height}
                  {asset.has_audio === true ? ' · 有声' : ' · 无声'}
                </span>
                <button
                  type="button"
                  className={css.linkButton}
                  onClick={() => {
                    setPreview({ src: `${SERVICE}/v1/assets/${asset.id}/file`, label: asset.id })
                  }}
                >播放原片</button>
              </div>
            </li>)}
          </ul>}
      </section>

      <section className={css.pane} aria-label="时间线">
        <h2 className={css.paneHead}>时间线 <span className={css.count}>{timelines.length}</span></h2>
        {timelines.length === 0
          ? <p className={css.empty}>还没有时间线。让我先给出一版剪辑方案，确认后就有了。</p>
          : <ul className={css.timelineList}>
            {timelines.map(line => <li key={line.id} className={css.timeline}>
              <div className={css.timelineHead}>
                <span className={css.assetName}>{line.id}</span>
                <span className={css.dim}>v{line.revision ?? 1} · {line.items?.length ?? 0} 段</span>
              </div>
              <div className={css.strip} aria-hidden>
                {(line.items ?? []).map((clip, index) => {
                  const span = Math.max(1, (clip.source_out_us ?? 0) - (clip.source_in_us ?? 0))
                  return <span
                    key={clip.id ?? `${String(index)}`}
                    className={css.segment}
                    style={{ flexGrow: span }}
                    title={`${clock(clip.source_in_us)}–${clock(clip.source_out_us)}`}
                  />
                })}
              </div>
            </li>)}
          </ul>}
      </section>

      <section className={css.pane} aria-label="音量">
        <h2 className={css.paneHead}>音量曲线 <span className={css.count}>{levels.length}s</span></h2>
        {levels.length === 0
          ? <p className={css.empty}>还没有音量数据。让我对素材做一次内容理解，就会量出逐秒的音量。</p>
          : <LoudnessCurve levels={levels} onPick={(at) => {
            const asset = assets[0]
            if (asset !== undefined) {
              setPreview({
                src: `${SERVICE}/v1/assets/${asset.id}/file#t=${(at / 1_000_000).toFixed(1)}`,
                label: `${clock(at)} 起`,
              })
            }
          }} />}
      </section>

      <section className={css.pane} aria-label="成片">
        <h2 className={css.paneHead}>成片 <span className={css.count}>{finished.length}</span></h2>
        {pending ? <p className={css.running}>
          <TextShimmer active>正在渲染…</TextShimmer>
        </p> : null}
        {failed.length > 0 ? <ul className={css.failList}>
          {failed.map(job => <li key={job.id} className={css.fail}>
            <span className={css.failTitle}>{job.status === 'canceled' ? '已取消' : '渲染失败'}</span>
            <span className={css.dim}>{job.error ?? job.id}</span>
          </li>)}
        </ul> : null}
        {finished.length === 0 && !pending
          ? <p className={css.empty}>还没有成片。确认方案后我就能导出 MP4。</p>
          : <ul className={css.outputList}>
            {finished.map(job => <li key={job.id} className={css.output}>
              <video
                className={css.player}
                src={`${SERVICE}/v1/artifacts/${job.id}`}
                poster={posterFor(job)}
                controls
                preload="metadata"
                playsInline
              />
              <div className={css.outputMeta}>
                <span className={css.assetName} title={job.output ?? ''}>
                  {(job.output ?? job.id).replace(/\\/g, '/').split('/').pop()}
                </span>
                {typeof job.progress === 'number' ? <span className={css.dim}>{job.progress}%</span> : null}
              </div>
            </li>)}
          </ul>}
      </section>
    </div>

    {preview === null ? null : <div
      className={css.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label="预览"
      onClick={() => { setPreview(null) }}
    >
      <video className={css.lightboxPlayer} src={preview.src} controls autoPlay playsInline />
      <button type="button" className={css.lightboxClose} onClick={() => { setPreview(null) }}>关闭</button>
    </div>}
  </div>
}
