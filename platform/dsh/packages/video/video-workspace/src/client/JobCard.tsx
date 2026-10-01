/**
 * Cards for the two tools that move a project forward: reading a timeline, and
 * submitting a render.
 *
 * The workbench panel can show a finished cut, but the conversation is where the
 * model reports what it did, so a job's progress, failure reason and cancel
 * action belong beside the call that started it. A job card that only said
 * "submitted" would leave the operator guessing whether anything was happening.
 *
 * @module dsh-video-workspace/client/job-card
 */

import { useEffect, useState } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import css from './JobCard.module.css'

/** The video-agent service base URL; the panel exports the same constant. */
const SERVICE = 'http://127.0.0.1:8090'

/** One render job as `render_submit` and `jobs_get` report it. */
interface Job {
  readonly id?: string
  readonly timeline_id?: string
  readonly status?: string
  readonly progress?: number
  readonly output?: string
  readonly error?: string
  readonly preview?: boolean
}

/** One clip of a timeline revision. */
interface Clip {
  readonly id?: string
  readonly asset_id?: string
  readonly source_in_us?: number
  readonly source_out_us?: number
}

/** One timeline revision as `timeline_get` returns it. */
interface Timeline {
  readonly id?: string
  readonly revision?: number
  readonly items?: readonly Clip[]
  readonly width?: number
  readonly height?: number
  readonly fps_num?: number
  readonly fps_den?: number
}

/**
 * Read the first JSON object out of a settled call's text content.
 * @param props - the keyed toolview payload.
 * @returns the parsed payload, or null when this call carries none.
 */
function readJson<T>(props: ToolCallViewProps): T | null {
  if (props.phase === 'preparing') return null
  const block = props.block
  if (!('kind' in block)) return null
  for (const item of block.content) {
    if (item.type !== 'text') continue
    try {
      const parsed: unknown = JSON.parse(item.text)
      if (typeof parsed === 'object' && parsed !== null) return parsed as T
    } catch {
      // A streaming settle can expose a truncated prefix first.
    }
  }
  return null
}

/** Format a microsecond offset as `m:ss`. */
function clock(us: number | undefined): string {
  if (typeof us !== 'number' || !Number.isFinite(us) || us < 0) return '—'
  const total = Math.round(us / 1_000_000)
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`
}

/** The Chinese word for one job state, or the raw value when it is unfamiliar. */
function stateLabel(status: string | undefined): string {
  switch (status) {
    case 'queued': return '排队中'
    case 'running': return '渲染中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'canceled': return '已取消'
    default: return status ?? '未知'
  }
}

/** Ask the service to cancel one job. A refusal is reported, never swallowed. */
async function cancelJob(id: string): Promise<void> {
  const response = await fetch(`${SERVICE}/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  if (!response.ok) throw new Error(`取消失败（HTTP ${String(response.status)}）`)
}

/**
 * Render one `video_render_submit` call as a job card.
 *
 * A submitted render is followed here rather than left to the panel, because the
 * operator asked for it in the conversation. Polling stops the moment the job
 * settles, so a finished render costs nothing.
 *
 * @param props - keyed toolview payload for this call.
 * @returns the job card, or null when the payload is not readable.
 */
export function RenderJobCard(props: ToolCallViewProps) {
  const submitted = readJson<Job>(props)
  const id = submitted?.id
  const submittedStatus = submitted?.status
  const [job, setJob] = useState<Job | null>(submitted)
  const [problem, setProblem] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)

  // `readJson` parses the call's recorded text, so it returns a NEW object on
  // every render. Keying an effect on that object re-runs it forever; key it on
  // the identity and state, which are primitives.
  useEffect(() => {
    setJob(submitted)
  }, [id, submittedStatus])

  useEffect(() => {
    if (id === undefined || id === '') return undefined
    let alive = true
    const settled = (state: string | undefined): boolean =>
      state === 'completed' || state === 'failed' || state === 'canceled'
    if (settled(job?.status)) return undefined
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`${SERVICE}/v1/jobs/${encodeURIComponent(id)}`)
        const envelope = await response.json() as { ok?: boolean; result?: Job }
        if (!alive || envelope.ok !== true || envelope.result === undefined) return
        const next = envelope.result
        // Publish only a real change, so an unchanged poll does not re-render.
        setJob(current => current !== null && current.status === next.status
          && current.progress === next.progress ? current : next)
      } catch {
        // A transient read failure must not replace the card with an error; the
        // next tick retries and the job keeps running either way.
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 2500)
    return () => { alive = false; clearInterval(timer) }
  }, [id, submittedStatus, job])

  if (job === null || id === undefined) return null
  const status = job.status ?? 'queued'
  const running = status === 'queued' || status === 'running'
  const progress = typeof job.progress === 'number' ? Math.max(0, Math.min(100, job.progress)) : 0

  return <div className={css.card} data-tool="video_render_submit" data-state={status}>
    <div className={css.head}>
      <span className={css.title}>{job.preview === true ? '生成预览' : '导出成片'}</span>
      <span className={css.state} data-state={status}>{stateLabel(status)}</span>
      {running ? <button
        type="button"
        className={css.action}
        disabled={canceling}
        onClick={() => {
          setCanceling(true)
          setProblem(null)
          void cancelJob(id)
            .then(() => { setJob(current => current === null ? current : { ...current, status: 'canceled' }) })
            .catch((error: unknown) => {
              setProblem(error instanceof Error ? error.message : String(error))
            })
            .finally(() => { setCanceling(false) })
        }}
      >{canceling ? '取消中…' : '取消'}</button> : null}
    </div>

    <div className={css.track} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
      <span className={css.fill} style={{ width: `${String(progress)}%` }} data-state={status} />
    </div>

    {problem === null ? null : <p className={css.problem} role="alert">{problem}</p>}

    {job.error === undefined || job.error === ''
      ? null
      : <p className={css.error} role="alert">{job.error}</p>}

    {status !== 'completed' ? null : <video
      className={css.player}
      src={`${SERVICE}/v1/artifacts/${id}`}
      controls
      preload="metadata"
      playsInline
    />}
  </div>
}

/**
 * Render one `video_timeline_get` call as a proportional strip plus the clips it
 * holds. The strip is the same reading the workbench shows, so a model quoting a
 * clip range and an operator looking at the panel see one shape.
 * @param props - keyed toolview payload for this call.
 * @returns the timeline card, or null when the payload is not readable.
 */
export function TimelineCard(props: ToolCallViewProps) {
  const timeline = readJson<Timeline>(props)
  if (timeline === null || !Array.isArray(timeline.items)) return null
  const items = timeline.items
  if (items.length === 0) return null
  const total = items.reduce(
    (sum, clip) => sum + Math.max(1, (clip.source_out_us ?? 0) - (clip.source_in_us ?? 0)), 0)

  return <div className={css.card} data-tool="video_timeline_get">
    <div className={css.head}>
      <span className={css.title}>{timeline.id ?? '时间线'} · v{timeline.revision ?? 1}</span>
      <span className={css.meta}>
        {items.length} 段 · 共 {clock(total)}
        {timeline.width === undefined ? '' : ` · ${String(timeline.width)}×${String(timeline.height)}`}
      </span>
    </div>
    <div className={css.strip} aria-hidden>
      {items.map((clip, index) => {
        const span = Math.max(1, (clip.source_out_us ?? 0) - (clip.source_in_us ?? 0))
        return <span
          key={clip.id ?? String(index)}
          className={css.segment}
          style={{ flexGrow: span }}
          title={`${clock(clip.source_in_us)}–${clock(clip.source_out_us)}`}
        />
      })}
    </div>
    <ol className={css.clipList}>
      {items.map((clip, index) => <li key={`row-${clip.id ?? String(index)}`} className={css.clipRow}>
        <span className={css.clipIndex}>{index + 1}</span>
        <span className={css.clipRange}>{clock(clip.source_in_us)}–{clock(clip.source_out_us)}</span>
        <span className={css.clipAsset}>{(clip.asset_id ?? '').slice(0, 18)}</span>
      </li>)}
    </ol>
  </div>
}
