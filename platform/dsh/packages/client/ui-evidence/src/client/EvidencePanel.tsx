/**
 * Evidence track renderer and the state it derives from one settled
 * `video_evidence_view` call.
 *
 * The whole panel is a projection of the result the call already returned: the
 * tool projects its six dimensions onto one shared time axis, and every track
 * here draws those same positions, so the tracks can be read against each other
 * and nothing is fetched a second time.
 * @module
 */
import { useState } from 'react'
import { DisclosureRow, IconDeliverDocRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { evidenceViewModel, isEvidenceDimension, type EvidenceDimension, type EvidenceMark, type EvidenceTextMark, type EvidenceViewModel, type TimelineMark } from './evidence-model.ts'
import { NS, type EvidenceKey } from './locales.ts'
import css from './EvidencePanel.module.css'

type PanelProps = ToolCallViewProps & PropsLocale<typeof NS>
type Translate = PropsLocale<typeof NS>['t']

/**
 * What the row shows for the call's current stage.
 *
 * `payload` is the drawing model; `missing` and `counts` are its own summary.
 * Absent payload plus a settled call means the projection produced nothing
 * drawable — either the call failed, or this build of the tool does not project
 * one — and the row says so instead of rendering an empty frame.
 */
export type EvidencePanelState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'payload'; readonly view: EvidenceViewModel }
  | { readonly kind: 'empty' }

/** The dBFS span the loudness curve is drawn against. */
const DB_FLOOR = -60
/** The dBFS value the curve tops out at. */
const DB_CEIL = 0
/** The loudness plot's own coordinate space; the SVG scales to the track box. */
const PLOT_WIDTH = 1000
/** Plot height in the same coordinate space. */
const PLOT_HEIGHT = 100

/**
 * Project one call's persisted result metadata onto the panel state.
 *
 * @param phase - the call's current stage.
 * @param meta - persisted result metadata, present once the call settled.
 * @returns the state the row renders.
 */
export function evidencePanelState(phase: ToolCallViewProps['phase'], meta: unknown): EvidencePanelState {
  if (phase !== 'result') return { kind: 'pending' }
  const view = evidenceViewModel(meta)
  return view === null ? { kind: 'empty' } : { kind: 'payload', view }
}

/** A position on the shared 0–1 axis, as a CSS percentage. */
function axisPercent(value: number): string {
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(4)}%`
}

/**
 * Vertical placement of one dBFS level, in the plot's own coordinate space.
 *
 * The curve is drawn against a fixed {@link DB_FLOOR}–{@link DB_CEIL} span
 * rather than the asset's own range: a recording whose whole dynamic range is
 * a few decibels would otherwise fill the track and read as if it were loud
 * everywhere, and two assets could not be compared by eye.
 * @param db - level in dBFS.
 * @returns 0 at the plot floor, {@link PLOT_HEIGHT} at the ceiling.
 */
export function dbY(db: number): number {
  const clamped = Math.min(DB_CEIL, Math.max(DB_FLOOR, db))
  return PLOT_HEIGHT - ((clamped - DB_FLOOR) / (DB_CEIL - DB_FLOOR)) * PLOT_HEIGHT
}

/**
 * Format an absolute time as `m:ss` or `h:mm:ss`.
 * @param us - time in microseconds.
 * @returns the clock text.
 */
export function clockText(us: number): string {
  const total = Math.max(0, Math.round(us / 1e6))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  return hours > 0
    ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}`
    : `${mm}:${String(seconds).padStart(2, '0')}`
}

/** Localized copy for one evidence dimension identifier, including an unrecognized one. */
function dimensionText(kind: string, t: Translate): string {
  return isEvidenceDimension(kind) ? t(dimensionLabelKey(kind)) : kind
}

/** The dictionary key naming one dimension. */
function dimensionLabelKey(kind: EvidenceDimension): EvidenceKey {
  return `dimension.${kind}`
}

/** One labelled track on the shared axis. */
function Track({ label, aside, children }: {
  readonly label: string
  readonly aside?: string | undefined
  readonly children: React.ReactNode
}) {
  return <>
    <div className={css.label}>
      <span className={css.labelText}>{label}</span>
      {aside !== undefined && <span className={css.labelAside}>{aside}</span>}
    </div>
    <div className={css.track}>{children}</div>
  </>
}

/** A run of spans drawn as bars on the axis, in the caller's tone class. */
function BarTrack({ marks, className }: { readonly marks: readonly EvidenceMark[]; readonly className?: string | undefined }) {
  return <>{marks.map((mark, index) => (
    <span
      key={`${mark.startUs}-${index}`}
      className={className}
      style={{ left: axisPercent(mark.start), width: axisPercent(Math.max(0, mark.end - mark.start)) }}
    />
  ))}</>
}

/** A run of text spans; the text is available on the bar itself. */
function TextTrack({ marks }: { readonly marks: readonly EvidenceTextMark[] }) {
  return <>{marks.map((mark, index) => (
    <span
      key={`${mark.startUs}-${index}`}
      className={css.bar_text}
      title={mark.text}
      style={{ left: axisPercent(mark.start), width: axisPercent(Math.max(0, mark.end - mark.start)) }}
    />
  ))}</>
}

/**
 * The loudness curve, drawn as a filled line against a fixed dBFS scale.
 *
 * A column per sample looked like a solid comb on material whose whole range is
 * a few decibels — the shape of the curve is the information, so it is the shape
 * that gets drawn.
 */
function LoudnessTrack({ track, label, range }: {
  readonly track: NonNullable<EvidenceViewModel['loudness']>
  readonly label: string
  readonly range: string
}) {
  const samples = track.samples
  const first = samples[0]
  const last = samples[samples.length - 1]
  // Redundant against the reader's own guard, but `noUncheckedIndexedAccess` does
  // not carry a length check into an element read; this is what narrows them.
  if (first === undefined || last === undefined) return <span className={css.absent} />
  const x = (at: number): string => (Math.min(1, Math.max(0, at)) * PLOT_WIDTH).toFixed(2)
  const points = samples.map(sample => `${x(sample.at)},${dbY(sample.db).toFixed(2)}`).join(' ')
  const area = `${x(first.at)},${PLOT_HEIGHT} ${points} ${x(last.at)},${PLOT_HEIGHT}`
  return <svg className={css.plot}
    viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
    preserveAspectRatio="none"
    role="img"
    aria-label={`${label} ${range}`}>
    {track.loudDbfs !== null && (
      <line className={css.loudLine} x1={0} x2={PLOT_WIDTH} y1={dbY(track.loudDbfs)} y2={dbY(track.loudDbfs)} />
    )}
    <polygon className={css.loudArea} points={area} />
    <polyline className={css.loudStroke} points={points} />
  </svg>
}

/** The shot boundaries, drawn as a tick per cut. */
function ShotTrack({ marks }: { readonly marks: readonly EvidenceMark[] }) {
  return <>
    <span className={css.ruler} />
    {marks.map((mark, index) => (
      <span key={`${mark.startUs}-${index}`} className={css.tick} style={{ left: axisPercent(mark.start) }} />
    ))}
  </>
}

/** Segments of a timeline drawn on the asset's own axis. */
function TimelineTrackView({ view, t }: { readonly view: NonNullable<EvidenceViewModel['timeline']>; readonly t: Translate }) {
  return <>{view.segments.map((segment) => (
    <span
      key={segment.ordinal}
      className={segment.onThisAxis ? css.segment : css.segmentOffAxis}
      data-off-axis={segment.onThisAxis ? undefined : 'true'}
      title={segmentTitle(segment, t)}
      style={{ left: axisPercent(segment.start), width: axisPercent(Math.max(0, segment.end - segment.start)) }}
    />
  ))}</>
}

/** The hover text of one timeline segment. */
function segmentTitle(segment: TimelineMark, t: Translate): string {
  const parts = [`#${segment.ordinal + 1}`]
  if (segment.speed !== 1) parts.push(`${t('timeline.speed')} ${segment.speed}`)
  if (segment.muted) parts.push(t('timeline.muted'))
  return parts.join(' · ')
}

/** Counts of one text track, for the label's aside. */
function countText(count: number, t: Translate): string | undefined {
  return count === 0 ? undefined : `${count} ${t('unit.count')}`
}

/** The loudness track's range, shown beside the curve as its scale. */
function loudnessRange(track: NonNullable<EvidenceViewModel['loudness']>, t: Translate): string {
  return `${track.floorDbfs ?? '—'} … ${track.peakDbfs ?? '—'} ${t('unit.db')}`
}

/**
 * Render one `video_evidence_view` call as a read-only evidence panel.
 * @param props - the call's stage, persisted result metadata, and localized copy.
 * @returns the panel, a pending row, or the generic disclosure row.
 */
export function EvidencePanel(props: PanelProps) {
  return props.phase === 'preparing' ? <PendingRow {...props} /> : <SettledRow {...props} />
}

function PendingRow({ t }: Extract<PanelProps, { phase: 'preparing' }>) {
  return <div data-tool="video_evidence_view" data-state="preparing">
    <DisclosureRow title={t('panel.title')} icon={<IconDeliverDocRegular size={14} />}
      open={false} expandable={false} onToggle={noop} running />
  </div>
}

function SettledRow({ block, t }: Exclude<PanelProps, { phase: 'preparing' }>) {
  const settled = 'kind' in block
  const state = evidencePanelState(settled ? 'result' : 'start', settled ? block.meta : undefined)
  const [open, setOpen] = useState(true)
  const failure = settled && block.error !== undefined ? `${block.error.name}: ${block.error.code}` : undefined
  const summary = state.kind === 'payload'
    ? `${t('panel.title')} · ${clockText(state.view.durationUs)}`
    : t('panel.empty')
  return <div data-tool="video_evidence_view" data-state={state.kind}>
    <DisclosureRow
      title={t('panel.title')}
      icon={<IconDeliverDocRegular size={14} />}
      open={open && state.kind === 'payload'}
      expandable={state.kind === 'payload'}
      expandOnRowClick
      keepContentWhenOpen
      onToggle={() => { setOpen(value => !value) }}
      collapsedContent={<span className={css.summary}>{summary}</span>}>
      {state.kind === 'payload' && <PanelBody view={state.view} t={t} />}
      {state.kind === 'empty' && <p className={css.note}>{failure ?? t('panel.empty')}</p>}
    </DisclosureRow>
  </div>
}

function PanelBody({ view, t }: { readonly view: EvidenceViewModel; readonly t: Translate }) {
  const counts = view.timeline === null ? null : view.timeline
  return <div className={css.panel}>
    <header className={css.head}>
      <h4 className={css.title}>{t('panel.title')}</h4>
      <span className={css.meta}>
        <span className={css.duration}>{clockText(view.durationUs)}</span>
        {view.missing === null
          ? null
          : <span className={view.missing.length === 0 ? css.complete : css.incomplete}>
            {view.missing.length === 0
              ? t('panel.missing.none')
              : `${t('panel.missing')}: ${view.missing.map(kind => dimensionText(kind, t)).join(' · ')}`}
          </span>}
      </span>
    </header>

    <div className={css.axis}>
      <Track label={t('track.loudness')}
        aside={view.loudness === null ? undefined : loudnessRange(view.loudness, t)}>
        {view.loudness === null
          ? <span className={css.absent} />
          : <LoudnessTrack track={view.loudness} label={t('track.loudness')} range={loudnessRange(view.loudness, t)} />}
      </Track>

      <Track label={t('track.shots')} aside={countText(view.shots.length, t)}>
        {view.shots.length === 0 ? <span className={css.absent} /> : <ShotTrack marks={view.shots} />}
      </Track>

      <Track label={t('track.silences')} aside={countText(view.silences.length, t)}>
        {view.silences.length === 0 ? <span className={css.absent} /> : <BarTrack marks={view.silences} className={css.silenceBar} />}
      </Track>

      <Track label={t('track.transcript')} aside={countText(view.transcript.length, t)}>
        {view.transcript.length === 0 ? <span className={css.absent} /> : <TextTrack marks={view.transcript} />}
      </Track>

      <Track label={t('track.screen_text')} aside={countText(view.screenText.length, t)}>
        {view.screenText.length === 0 ? <span className={css.absent} /> : <TextTrack marks={view.screenText} />}
      </Track>

      <Track label={t('track.scenes')} aside={countText(view.scenes.length, t)}>
        {view.scenes.length === 0 ? <span className={css.absent} /> : <TextTrack marks={view.scenes} />}
      </Track>

      <Track label={t('track.chapters')} aside={countText(view.chapters.length, t)}>
        {view.chapters.length === 0 ? <span className={css.absent} /> : <TextTrack marks={view.chapters} />}
      </Track>

      {counts !== null && <Track label={t('timeline.title')} aside={`${t('timeline.revision')} ${counts.revision}`}>
        <TimelineTrackView view={counts} t={t} />
      </Track>}
    </div>

    <footer className={css.footer}>
      <span>{t('panel.axis.start')} 0:00</span>
      <span>{t('panel.axis.end')} {clockText(view.durationUs)}</span>
    </footer>
  </div>
}

/* v8 ignore next -- a non-expandable row never invokes DisclosureRow's required toggle callback. */
function noop(): void {}
