/**
 * The evidence lanes: what was measured over the recording, drawn where the film uses it.
 *
 * Every lane answers one question about a stretch of the cut — was this said, was this on screen,
 * was the camera moving, was this quiet, was this loud, is this the part the analysis called a
 * highlight — and they answer it on the **film's** axis, beside the clip they are about. That
 * placement is the point: a reason you have to translate in your head is not a reason you can
 * check.
 *
 * Each lane is drawn inside one full-width action rather than as a row of spans, because the lane
 * content is positioned as a share of the film. Spans would put a text line at its own start and
 * then measure percentages against that span instead of against the film.
 */
import type { ReactNode } from 'react'
import type { TimelineAction } from '@xzdarcy/timeline-engine'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClipSpan } from './timing.ts'
import type { EvidenceSpan } from './read.ts'
import type { EvidencePayload } from './read.ts'
import { loudnessColumns, toUsedSpans, type EvidenceLaneKey } from './evidence-model.ts'
import styles from './EvidenceLanes.module.css'

/** The effect id the evidence rows carry. */
export const EVIDENCE_EFFECT = 'evidence'

/** Row height per lane, in pixels. */
const LANE_HEIGHT: Readonly<Record<EvidenceLaneKey, number>> = {
  transcript: 34,
  screenText: 34,
  shots: 22,
  silences: 18,
  loudness: 44,
  chapters: 34,
  highlights: 20,
}

/** How many columns the loudness lane may be reduced to. */
const LOUDNESS_BUCKETS = 220

/** What one lane needs to draw itself. */
export interface LaneProps {
  /** The lane's key; also its row id. */
  readonly lane: EvidenceLaneKey
  /** Measured evidence for the recording, or null when none was read. */
  readonly tracks: EvidencePayload['tracks'] | null
  /** The clips, in output order, so source time can be placed on the film axis. */
  readonly clips: readonly ClipSpan[]
  /** Length of the recording, in microseconds. */
  readonly assetDurationUs: number
  /** Total film length in seconds; the lane's width maps onto it. */
  readonly filmSeconds: number
  /** Called with an asset position when a mark is chosen. */
  readonly onSeek: (assetUs: number) => void
}

/**
 * Build the editor rows for the enabled evidence lanes.
 *
 * Each lane gets one action covering the film, and the content positions itself as a share of that
 * action.
 *
 * The action's end is the **film length in seconds**, which is not a guess: the library converts a
 * position to pixels as `startLeft + position / scale * scaleWidth`, so with the timeline's
 * `scale: 1` the action's pixel width is `end * scaleWidth`. Naming the film length therefore makes
 * the action exactly as wide as the film, and a mark's share of the film is its share of the action.
 *
 * Two earlier attempts got this wrong and both produced a lane that looked empty:
 * `end: 1` made the action one second wide, flattening every mark to its minimum width, and a
 * nominal "very large" end made the row millions of pixels wide, which pushed the film down to a
 * sliver instead.
 *
 * @param lanes - the lanes to build, in stacking order.
 * @param filmSeconds - total length of the film on the editor's axis.
 * @returns One row per lane.
 */
export function evidenceRows(lanes: readonly EvidenceLaneKey[], filmSeconds: number): { id: string, rowHeight: number, actions: TimelineAction[] }[] {
  // 成片长度为 0 时给一个极小的非零宽度：宽度为 0 的动作库不会渲染，轨道会整个消失。
  const span = filmSeconds > 0 ? filmSeconds : 0.001
  return lanes.map(lane => ({
    id: lane,
    rowHeight: LANE_HEIGHT[lane],
    actions: [{ id: `lane-${lane}`, start: 0, end: span, effectId: EVIDENCE_EFFECT, movable: false, flexible: false }],
  }))
}

/** Position one lane's content on the film as a percentage. */
function place(at: number, filmSeconds: number): string {
  return filmSeconds <= 0 ? '0%' : `${Math.min(100, Math.max(0, (at / filmSeconds) * 100))}%`
}

/**
 * Width of a mark as a percentage of the film, with a floor so a short one stays visible.
 *
 * The floor is applied here rather than in CSS. `width: max(0.4%, 12%)` is invalid — `max()`
 * requires its arguments to share a unit — and an invalid value makes React drop the whole `style`
 * attribute, taking the valid `left` with it. The mark then lands wherever the stylesheet puts it
 * instead of at its position, and the lane still renders, so nothing else looks wrong.
 *
 * @param seconds - how long the mark lasts.
 * @param filmSeconds - total film length.
 * @param floorPercent - narrowest a mark may be drawn.
 * @returns A value for the `width` property.
 */
function widthOf(seconds: number, filmSeconds: number, floorPercent: number): string {
  if (filmSeconds <= 0) return `${floorPercent}%`
  return `${Math.max(floorPercent, (seconds / filmSeconds) * 100)}%`
}

/**
 * Draw text marks: one block per measured line, over the stretch it covers.
 *
 * The marks carry **recording** times and the lane's axis is the **film**, so each one is placed
 * through the same conversion the other lanes use. Drawing a recording position straight onto the
 * film axis puts it past the end of the film, where it clamps to the right edge — a position that
 * looks deliberate and is entirely wrong.
 *
 * @param props - the lane's marks and axis.
 * @returns The blocks.
 */
function TextLane<M extends EvidenceSpan>({ marks, wordsOf, clips, filmSeconds, onSeek, t }: {
  marks: readonly M[]
  /**
   * Pull the words to draw out of one mark.
   *
   * An accessor rather than a field name: a field name reaches the payload with a string index,
   * which the compiler cannot check, so a typo would silently draw every block blank. Transcripts
   * and screen text carry `text`; chapters carry `summary`, and a chapter genuinely is a summary —
   * renaming it to `text` on the way in would make the two indistinguishable where they differ.
   */
  wordsOf: (mark: M) => string
  clips: readonly ClipSpan[]
  filmSeconds: number
  onSeek: (assetUs: number) => void
  t: PropsLocale<'workbench'>['t']
}): ReactNode {
  return (
    <>
      {toUsedSpans(clips, marks).map(piece => (
        <button
          key={`${piece.start}-${wordsOf(piece.value).slice(0, 12)}`}
          type="button"
          className={styles.textMark}
          data-evidence-text=""
          style={{ left: place(piece.start, filmSeconds), width: widthOf(piece.end - piece.start, filmSeconds, 0.4) }}
          title={`${t('timeline.seconds', { value: (piece.sourceStartUs / 1e6).toFixed(1) })} · ${wordsOf(piece.value)}`}
          onClick={() => onSeek(piece.sourceStartUs)}
        >
          {wordsOf(piece.value)}
        </button>
      ))}
    </>
  )
}

/**
 * Draw the loudness lane: one column per bucket of film time.
 *
 * `loudnessColumns` already places readings on the film, so the columns' `at` values are shares of
 * the film rather than of the recording. Passing them through the source-time conversion again
 * would move them a second time.
 *
 * @param props - the readings and axis.
 * @returns The columns.
 */
function LoudnessLane({ tracks, clips, filmSeconds }: {
  tracks: EvidencePayload['tracks']
  clips: readonly ClipSpan[]
  filmSeconds: number
}): ReactNode {
  const loudness = tracks.loudness
  if (loudness === undefined) return null
  const columns = loudnessColumns(loudness.levels_dbfs, loudness.window_us, LOUDNESS_BUCKETS)
  if (columns.length === 0) return null
  // 纵轴按本片实测动态范围；实测那条素材峰值只到 −12 dBFS，固定 −60…0 会让顶部一直空着。
  const floor = loudness.floor_dbfs ?? Math.min(...columns.map(column => column.db))
  const peak = loudness.peak_dbfs ?? Math.max(...columns.map(column => column.db))
  const spread = peak - floor
  // 「响」的区段仍以素材时间给出，所以它们要按素材坐标换算。
  const loudSpans = toUsedSpans(clips, loudness.loud_spans)
  return (
    <>
      {columns.map(column => (
        <span
          key={column.at}
          className={styles.loudnessColumn}
          data-evidence-loudness=""
          style={{
            left: place(column.at * filmSeconds, filmSeconds),
            // 柱宽按桶宽给，不设下限：设了下限会把相邻柱子放大到互相盖住。
            width: `${100 / LOUDNESS_BUCKETS}%`,
            height: `${spread <= 0 ? 100 : Math.max(4, ((column.db - floor) / spread) * 100)}%`,
          }}
        />
      ))}
      {loudSpans.map(piece => (
        <span
          key={piece.start}
          className={styles.loudSpan}
          data-evidence-loud-span=""
          style={{ left: place(piece.start, filmSeconds), width: widthOf(piece.end - piece.start, filmSeconds, 0.3) }}
        />
      ))}
    </>
  )
}

/**
 * Draw one evidence lane's content.
 *
 * @param props - the lane, its marks, and the axis to place them on.
 * @returns The lane's content, or null when the recording has nothing for it.
 */
export function EvidenceLane({ lane, tracks, clips, filmSeconds, onSeek, t }: LaneProps & PropsLocale<'workbench'>): ReactNode {
  if (tracks === null) return null

  if (lane === 'transcript' || lane === 'screenText') {
    const marks = lane === 'transcript' ? tracks.transcript : tracks.screen_text
    if (marks === undefined) return null
    return <TextLane wordsOf={mark => mark.text} marks={marks} clips={clips} filmSeconds={filmSeconds} onSeek={onSeek} t={t} />
  }

  if (lane === 'loudness') {
    return <LoudnessLane tracks={tracks} clips={clips} filmSeconds={filmSeconds} />
  }

  if (lane === 'chapters') {
    /*
     * 章节按跨度铺文字块，和台词一样 —— 它回答的是「这一整片讲了哪几段」，
     * 而一段话只有铺开才看得出边界在哪。高光反过来只画色块：它回答的是「哪几段值得挑」，
     * 位置本身就是答案。
     */
    const chapters = tracks.chapters ?? []
    if (chapters.length === 0) return null
    return <TextLane wordsOf={mark => mark.summary} marks={chapters} clips={clips} filmSeconds={filmSeconds} onSeek={onSeek} t={t} />
  }

  /** Stretches with a title, for the lanes that are just a list of them. */
  const spans: { start_us: number, end_us: number, title: string }[] =
    lane === 'shots'
      ? (tracks.shots ?? []).map(shot => ({ start_us: shot.start_us, end_us: shot.end_us, title: t('evidence.shot', { index: String(shot.index + 1) }) }))
      : lane === 'silences'
        ? (tracks.silences ?? []).map(span => ({ ...span, title: t('evidence.silence') }))
        : (tracks.highlights ?? []).map(span => ({ ...span, title: span.reason ?? t('evidence.highlight') }))

  const placed = toUsedSpans(clips, spans)
  if (placed.length === 0) return null
  return (
    <>
      {placed.map(piece => (
        <span
          key={`${piece.start}-${piece.value.title}`}
          className={lane === 'shots' ? styles.shotMark : lane === 'silences' ? styles.silenceMark : styles.highlightMark}
          data-evidence-mark={lane}
          style={{ left: place(piece.start, filmSeconds), width: widthOf(piece.end - piece.start, filmSeconds, 0.3) }}
          title={`${t('timeline.seconds', { value: (piece.sourceStartUs / 1e6).toFixed(1) })} · ${piece.value.title}`}
        />
      ))}
    </>
  )
}
