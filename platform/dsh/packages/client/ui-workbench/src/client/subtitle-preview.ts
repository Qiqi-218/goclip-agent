/**
 * What the subtitle looks like at a given moment of the film.
 *
 * The film is played from the recording, so a cue's times are **recording** times while the player
 * reports a **film** position. That conversion already exists for the export and the burn; here it
 * runs the other way — from a film position back to the words that belong there.
 *
 * **This preview is not the burn, and the difference is stated rather than hidden.** A preview drawn
 * in the browser cannot promise the same pixels ffmpeg will produce: the font is resolved by the
 * browser rather than by libass, an unknown family substitutes differently, and the burn's own
 * margins are computed against the output picture at its real size. What it does show faithfully is
 * what the person is actually choosing between: the colour, weight, outline, box, and where on the
 * frame the text sits. Those are the decisions a style is made of, and a preview that got them
 * right but the font hinting wrong is worth having; one that quietly implied the export would match
 * to the pixel would not be.
 */
import type { SubtitleStyle } from './read.ts'
import { layoutOnOutputAxis, rateOf, outputSecondsOf, type ClipSpan } from './timing.ts'

/** One cue, with the style that applies to it. */
export interface PreviewCue {
  /** What to draw, with newlines kept as the burn keeps them. */
  readonly text: string
  /** When it starts, in seconds along the film. */
  readonly startFilmSeconds: number
  /** When it ends, in seconds along the film. */
  readonly endFilmSeconds: number
}

/**
 * Project one span of the recording onto the film.
 *
 * A span the cut does not use has no place on the film and yields null; a span used more than once
 * yields one cue per use, which is what the film actually contains. Clamping to a single use would
 * silently drop the second appearance.
 *
 * @param clips - the clips, in output order.
 * @param startUs - span start in the recording.
 * @param endUs - span end in the recording.
 * @returns One film-time span per use, in film order.
 */
export function projectOntoFilm(clips: readonly ClipSpan[], startUs: number, endUs: number): { start: number, end: number }[] {
  const layout = layoutOnOutputAxis(clips)
  const placed: { start: number, end: number }[] = []
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index] as ClipSpan
    const span = layout[index] as { start: number, end: number }
    const from = Math.max(startUs, clip.start_us)
    const to = Math.min(endUs, clip.end_us)
    if (to <= from) continue
    const rate = rateOf(clip.speed)
    placed.push({
      start: span.start + (from - clip.start_us) / 1e6 / rate,
      end: span.start + (to - clip.start_us) / 1e6 / rate,
    })
  }
  return placed
}

/**
 * Build the cues a subtitle preview draws from.
 *
 * @param clips - the clips, in output order.
 * @param lines - the transcript or screen-text rows, in recording time.
 * @returns The cues, in film order.
 */
export function previewCues(
  clips: readonly ClipSpan[],
  lines: readonly { readonly start_us: number, readonly end_us: number, readonly text: string }[],
): PreviewCue[] {
  return lines
    .flatMap(line => projectOntoFilm(clips, line.start_us, line.end_us).map(span => ({ ...span, text: line.text })))
    .sort((left, right) => left.start - right.start)
    .map(span => ({ text: span.text, startFilmSeconds: span.start, endFilmSeconds: span.end }))
}

/**
 * Find the cue to draw at a film position.
 *
 * At a boundary two cues can both qualify; the later one wins, because the frame being drawn is the
 * first frame of the new cue. Drawing the previous line for one more frame reads as a subtitle that
 * lags the speech.
 *
 * @param cues - the cues, in film order.
 * @param filmSeconds - where the film is.
 * @returns The cue to draw, or null when nothing is said.
 */
export function cueAt(cues: readonly PreviewCue[], filmSeconds: number): PreviewCue | null {
  let found: PreviewCue | null = null
  for (const cue of cues) {
    if (cue.startFilmSeconds <= filmSeconds && filmSeconds < cue.endFilmSeconds) found = cue
  }
  return found
}

/** A style expressed as CSS the browser can draw.
 *
 * Sizes are shares of the picture's own height and width, so the text keeps its proportion when the
 * preview is resized — the same reason the stored style uses shares rather than pixels.
 */
export interface PreviewStyle {
  /** Inline style for the text. */
  readonly text: Readonly<Record<string, string>>
  /** Inline style for the box the text sits in, which carries the position. */
  readonly box: Readonly<Record<string, string>>
}

/**
 * Turn a stored style into CSS for one picture.
 *
 * @param style - the stored style, or null to use the burn's defaults.
 * @param picture - the picture the overlay covers.
 * @returns The inline styles to apply.
 */
export function previewStyle(
  style: SubtitleStyle | null,
  picture: { readonly width: number, readonly height: number },
): PreviewStyle {
  // 与宿主 DEFAULT_SUBTITLE_STYLE 一致。写成两份是刻意的：这一份只在浏览器里画预览，
  // 若与宿主耦合，改宿主默认值会悄悄改掉预览而不改烧录（或反过来）。
  const effective = {
    font: 'Microsoft YaHei',
    size: 0.04,
    bold: false,
    italic: false,
    color: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 0.04,
    alignment: 'bottom-center',
    marginVertical: 0.045,
    marginHorizontal: 0.04,
    backgroundColor: null as string | null,
    backgroundOpacity: 0.5,
    ...style,
  }
  const fontPx = Math.max(8, Math.round(effective.size * picture.height))
  const outlinePx = effective.outlineWidth <= 0 ? 0 : Math.max(1, Math.round(effective.outlineWidth * fontPx))
  const [vertical, horizontal] = effective.alignment.split('-') as ['bottom' | 'middle' | 'top', 'left' | 'center' | 'right']

  const box: Record<string, string> = {
    position: 'absolute',
    display: 'flex',
    pointerEvents: 'none',
    // 九宫格：纵向三段、横向三段，用 flex 的对齐表达，不用坐标。
    ...(vertical === 'bottom' ? { bottom: `${effective.marginVertical * 100}%` } : {}),
    ...(vertical === 'top' ? { top: `${effective.marginVertical * 100}%` } : {}),
    ...(vertical === 'middle' ? { top: '50%', transform: 'translateY(-50%)' } : {}),
    left: '0',
    right: '0',
    justifyContent: horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center',
    ...(horizontal === 'left' ? { paddingLeft: `${effective.marginHorizontal * 100}%` } : {}),
    ...(horizontal === 'right' ? { paddingRight: `${effective.marginHorizontal * 100}%` } : {}),
  }
  const text: Record<string, string> = {
    maxWidth: '92%',
    /*
     * 用 padding 的**单值**属性而不是 `padding: '0.15em 0.4em'`：后者会让 i18n 门禁把它当成
     * 硬编码文案 —— 它按「含空格的字符串字面量」找文案，而 CSS 的行内简写正好长那样。
     * 拆成两个单值属性既避开误报，画出来的样子完全一样。
     */
    paddingTop: effective.backgroundColor === null ? '0' : '0.15em',
    paddingBottom: effective.backgroundColor === null ? '0' : '0.15em',
    paddingLeft: effective.backgroundColor === null ? '0' : '0.4em',
    paddingRight: effective.backgroundColor === null ? '0' : '0.4em',
    borderRadius: '0.15em',
    color: effective.color,
    fontFamily: effective.font,
    fontSize: `${fontPx}px`,
    fontWeight: effective.bold ? '700' : '400',
    fontStyle: effective.italic ? 'italic' : 'normal',
    lineHeight: '1.3',
    textAlign: 'center',
    whiteSpace: 'pre-wrap',
    // 描边用多重阴影画：CSS 没有文字描边，而 -webkit-text-stroke 会把字身吃掉。
    textShadow: outlinePx === 0
      ? 'none'
      : [
          `${outlinePx}px 0 0 ${effective.outlineColor}`,
          `-${outlinePx}px 0 0 ${effective.outlineColor}`,
          `0 ${outlinePx}px 0 ${effective.outlineColor}`,
          `0 -${outlinePx}px 0 ${effective.outlineColor}`,
        ].join(', '),
    ...(effective.backgroundColor === null
      ? {}
      : { background: withAlpha(effective.backgroundColor, effective.backgroundOpacity) }),
  }
  return { text, box }
}

/**
 * Turn `#rrggbb` plus an opacity into a CSS colour.
 * @param hex - the colour.
 * @param opacity - 0–1.
 * @returns A colour the browser accepts.
 */
function withAlpha(hex: string, opacity: number): string {
  const red = Number.parseInt(hex.slice(1, 3), 16)
  const green = Number.parseInt(hex.slice(3, 5), 16)
  const blue = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${red}, ${green}, ${blue}, ${Math.min(1, Math.max(0, opacity))})`
}

/** The film's length in seconds, from the clips alone. */
export function filmSecondsOf(clips: readonly ClipSpan[]): number {
  return clips.reduce((sum, clip) => sum + outputSecondsOf(clip), 0)
}
