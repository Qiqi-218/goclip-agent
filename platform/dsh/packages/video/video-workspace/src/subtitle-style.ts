/**
 * Subtitle appearance: what a spoken description of a style turns into.
 *
 * A person asks for "yellow bold subtitles with a black outline, centred at the bottom", and the
 * model turns that into the fields below. The fields are not free-form: each one is a closed set
 * this module validates, because a colour spelled `黃色` or a position spelled `bottom-centre`
 * reaches ffmpeg as an unparsable argument and the burn fails after a full re-encode.
 *
 * Two decisions worth stating:
 *
 * - **The nine-grid position is `alignment` plus margins, not coordinates.** Subtitles have to
 *   survive a change of aspect ratio: a style pinned to "x=640" breaks the moment the film goes
 *   from 16:9 to 9:16, while "bottom centre with a 28px margin" lands correctly in both.
 * - **Font metrics are proportional to the film's height.** `size` is a share of the picture
 *   height, not a pixel count, for the same reason: 28px is readable at 1080p and huge at 360p.
 */

/** Where the text sits, in the nine-grid sense every subtitle format uses. */
export type SubtitleAlignment =
  | 'bottom-left' | 'bottom-center' | 'bottom-right'
  | 'middle-left' | 'middle-center' | 'middle-right'
  | 'top-left' | 'top-center' | 'top-right'

/** Every alignment, in the order a nine-grid reads. */
export const SUBTITLE_ALIGNMENTS: readonly SubtitleAlignment[] = [
  'bottom-left', 'bottom-center', 'bottom-right',
  'middle-left', 'middle-center', 'middle-right',
  'top-left', 'top-center', 'top-right',
]

/** Which evidence the words come from. */
export type SubtitleSource = 'transcript' | 'screen-text'

/** How a style is described. Every field is optional; an omitted one keeps its default. */
export interface SubtitleStyleInput {
  /** Font family name as the system knows it. */
  readonly font?: string
  /** Text height as a share of the picture height, 0.01–0.5. */
  readonly size?: number
  /** Weight. */
  readonly bold?: boolean
  /** Slant. */
  readonly italic?: boolean
  /** Text colour, as `#rrggbb`. */
  readonly color?: string
  /** Outline colour, as `#rrggbb`. */
  readonly outlineColor?: string
  /** Outline thickness as a share of the text height, 0–0.5. Zero removes the outline. */
  readonly outlineWidth?: number
  /** Where the text sits. */
  readonly alignment?: SubtitleAlignment
  /** Distance from the nearest horizontal edge, as a share of the picture height. */
  readonly marginVertical?: number
  /** Distance from the nearest vertical edge, as a share of the picture width. */
  readonly marginHorizontal?: number
  /** Background box colour, as `#rrggbb`, or null for no box. */
  readonly backgroundColor?: string | null
  /** Background opacity, 0–1. Only meaningful with a background colour. */
  readonly backgroundOpacity?: number
  /** Shadow colour, as `#rrggbb`, or null for none. */
  readonly shadowColor?: string | null
  /** Shadow offset as a share of the text height. */
  readonly shadowOffset?: number
  /** Shadow blur as a share of the text height. Blur beyond a couple of pixels is not portable. */
  readonly shadowBlur?: number
  /** Which evidence the words come from. */
  readonly source?: SubtitleSource
}

/**
 * A style with every field resolved.
 *
 * Spelled out rather than derived from the input by a mapped type: `Required<{ [K]: NonNullable<…> }>`
 * keeps `null` in the two fields that allow it, and reads as though the nullable ones had become
 * mandatory. Naming each field here is what makes "resolved" actually mean resolved.
 */
export interface SubtitleStyle {
  readonly font: string
  readonly size: number
  readonly bold: boolean
  readonly italic: boolean
  readonly color: string
  readonly outlineColor: string
  readonly outlineWidth: number
  readonly alignment: SubtitleAlignment
  readonly marginVertical: number
  readonly marginHorizontal: number
  readonly backgroundColor: string | null
  readonly backgroundOpacity: number
  readonly shadowColor: string | null
  readonly shadowOffset: number
  readonly shadowBlur: number
  readonly source: SubtitleSource
}

/** What an unspecified field becomes. Chosen to match the burn step's previous hardcoded values. */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
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
  backgroundColor: null,
  backgroundOpacity: 0.5,
  shadowColor: null,
  shadowOffset: 0,
  shadowBlur: 0,
  source: 'transcript',
}

/** A field the caller got wrong, named so the model can correct just that field. */
export interface StyleProblem {
  /** Which field. */
  readonly field: string
  /** What was supplied, rendered for reading. */
  readonly value: string
  /** What would have been accepted. */
  readonly expected: string
}

/** Whether a string is a `#rrggbb` colour. */
function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value)
}

/** Whether a number is finite and within a range. */
function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max
}

/**
 * Check one requested style and resolve it against the defaults.
 *
 * Returns every problem at once rather than the first: a model that gets three fields wrong
 * should be told all three, not sent round the loop three times.
 *
 * @param input - the requested fields; omitted ones take their defaults.
 * @returns The resolved style, or the list of fields that cannot be accepted.
 */
export function resolveSubtitleStyle(input: SubtitleStyleInput): { style: SubtitleStyle } | { problems: StyleProblem[] } {
  const problems: StyleProblem[] = []
  const check = (ok: boolean, field: string, value: unknown, expected: string): void => {
    if (!ok) problems.push({ field, value: JSON.stringify(value ?? null) ?? 'undefined', expected })
  }

  check(input.font === undefined || input.font.trim() !== '', 'font', input.font, '非空字体名')
  check(input.size === undefined || inRange(input.size, 0.01, 0.5), 'size', input.size, '0.01–0.5（画面高度的占比）')
  check(input.color === undefined || isHexColor(input.color), 'color', input.color, '#rrggbb')
  check(input.outlineColor === undefined || isHexColor(input.outlineColor), 'outlineColor', input.outlineColor, '#rrggbb')
  check(input.outlineWidth === undefined || inRange(input.outlineWidth, 0, 0.5), 'outlineWidth', input.outlineWidth, '0–0.5')
  check(input.alignment === undefined || SUBTITLE_ALIGNMENTS.includes(input.alignment), 'alignment', input.alignment, SUBTITLE_ALIGNMENTS.join(' / '))
  check(input.marginVertical === undefined || inRange(input.marginVertical, 0, 0.5), 'marginVertical', input.marginVertical, '0–0.5')
  check(input.marginHorizontal === undefined || inRange(input.marginHorizontal, 0, 0.5), 'marginHorizontal', input.marginHorizontal, '0–0.5')
  check(input.backgroundColor === undefined || input.backgroundColor === null || isHexColor(input.backgroundColor), 'backgroundColor', input.backgroundColor, '#rrggbb 或 null')
  check(input.backgroundOpacity === undefined || inRange(input.backgroundOpacity, 0, 1), 'backgroundOpacity', input.backgroundOpacity, '0–1')
  check(input.shadowColor === undefined || input.shadowColor === null || isHexColor(input.shadowColor), 'shadowColor', input.shadowColor, '#rrggbb 或 null')
  // ASS 的阴影模糊在现代 libass 里被忽略，允许一个小的值但不假装它有效。
  check(input.shadowOffset === undefined || inRange(input.shadowOffset, 0, 0.5), 'shadowOffset', input.shadowOffset, '0–0.5')
  check(input.shadowBlur === undefined || inRange(input.shadowBlur, 0, 0.1), 'shadowBlur', input.shadowBlur, '0–0.1')
  check(input.source === undefined || input.source === 'transcript' || input.source === 'screen-text', 'source', input.source, 'transcript / screen-text')

  // 背景透明度只在有背景色时才有意义；给了透明度却没给底色，说明少说了一项。
  if (input.backgroundOpacity !== undefined && input.backgroundOpacity > 0
    && input.backgroundColor !== undefined && input.backgroundColor === null) {
    problems.push({ field: 'backgroundColor', value: 'null', expected: '给了 backgroundOpacity 就要给一个背景色，或把 backgroundOpacity 设为 0' })
  }

  if (problems.length > 0) return { problems }

  // 逐字段落定，而不是展开合并：`Object.fromEntries` 的结果是 Record<string, …>，
  // 再断言成 SubtitleStyle 就把「每个字段都解析过」这件事交给了断言，而不是交给类型。
  return {
    style: {
      font: input.font ?? DEFAULT_SUBTITLE_STYLE.font,
      size: input.size ?? DEFAULT_SUBTITLE_STYLE.size,
      bold: input.bold ?? DEFAULT_SUBTITLE_STYLE.bold,
      italic: input.italic ?? DEFAULT_SUBTITLE_STYLE.italic,
      color: input.color ?? DEFAULT_SUBTITLE_STYLE.color,
      outlineColor: input.outlineColor ?? DEFAULT_SUBTITLE_STYLE.outlineColor,
      outlineWidth: input.outlineWidth ?? DEFAULT_SUBTITLE_STYLE.outlineWidth,
      alignment: input.alignment ?? DEFAULT_SUBTITLE_STYLE.alignment,
      marginVertical: input.marginVertical ?? DEFAULT_SUBTITLE_STYLE.marginVertical,
      marginHorizontal: input.marginHorizontal ?? DEFAULT_SUBTITLE_STYLE.marginHorizontal,
      backgroundColor: input.backgroundColor === undefined ? DEFAULT_SUBTITLE_STYLE.backgroundColor : input.backgroundColor,
      backgroundOpacity: input.backgroundOpacity ?? DEFAULT_SUBTITLE_STYLE.backgroundOpacity,
      shadowColor: input.shadowColor === undefined ? DEFAULT_SUBTITLE_STYLE.shadowColor : input.shadowColor,
      shadowOffset: input.shadowOffset ?? DEFAULT_SUBTITLE_STYLE.shadowOffset,
      shadowBlur: input.shadowBlur ?? DEFAULT_SUBTITLE_STYLE.shadowBlur,
      source: input.source ?? DEFAULT_SUBTITLE_STYLE.source,
    },
  }
}

/** The nine-grid alignment expressed the way ASS numbers them. */
const ASS_ALIGNMENT: Readonly<Record<SubtitleAlignment, number>> = {
  'bottom-left': 1, 'bottom-center': 2, 'bottom-right': 3,
  'middle-left': 4, 'middle-center': 5, 'middle-right': 6,
  'top-left': 7, 'top-center': 8, 'top-right': 9,
}

/**
 * Render a style as an ASS style record, which is what the burn filter reads.
 *
 * ASS carries colours as `&HAABBGGRR`: alpha first, then the channels **reversed** relative to the
 * `#rrggbb` a person writes. Getting that wrong swaps red and blue, which reads as "the colour is
 * wrong" rather than as a bug, so the conversion is done in one place.
 *
 * Sizes are absolute in ASS, so the caller supplies the picture height and the shares are turned
 * into pixels here.
 *
 * @param style - the resolved style.
 * @param pictureHeight - height of the film in pixels, used to turn shares into sizes.
 * @param pictureWidth - width of the film in pixels.
 * @returns A `force_style` value for ffmpeg's subtitles filter.
 */
export function toAssStyle(style: SubtitleStyle, pictureHeight: number, pictureWidth: number): string {
  /** `#rrggbb` plus an opacity into `&HAABBGGRR`. */
  const assColor = (hex: string, opacity: number): string => {
    const red = hex.slice(1, 3)
    const green = hex.slice(3, 5)
    const blue = hex.slice(5, 7)
    // ASS 的 alpha 是「不透明度」的补数：00 是全不透明，FF 是全透明。
    const alpha = Math.round((1 - opacity) * 255).toString(16).padStart(2, '0')
    return `&H${alpha}${blue}${green}${red}`.toUpperCase()
  }

  const parts = [
    `FontName=${style.font}`,
    `FontSize=${Math.max(8, Math.round(style.size * pictureHeight))}`,
    `Bold=${style.bold ? -1 : 0}`,
    `Italic=${style.italic ? -1 : 0}`,
    `PrimaryColour=${assColor(style.color, 1)}`,
    `OutlineColour=${assColor(style.outlineColor, 1)}`,
    `Outline=${style.outlineWidth <= 0 ? 0 : Math.max(1, Math.round(style.outlineWidth * style.size * pictureHeight))}`,
    /*
     * ASS 的 `Shadow` 只有一个**偏移量**，没有颜色 —— 阴影颜色跟着 `BackColour` 走。
     * 因此这里只能表达「有没有阴影、偏多远」，不能表达「阴影是什么颜色」：
     * 一个不存在的字段名会被 libass 当成未知样式直接忽略，看起来像「设置没生效」。
     * 有底色时 BorderStyle=3 会占用 BackColour，那时阴影与底框二者只能取一。
     */
    `Shadow=${style.shadowColor === null || style.shadowOffset <= 0 ? 0 : Math.max(1, Math.round(style.shadowOffset * style.size * pictureHeight))}`,
    `Alignment=${ASS_ALIGNMENT[style.alignment]}`,
    `MarginV=${Math.round(style.marginVertical * pictureHeight)}`,
    // 九宫格里左右两侧的边距在 ASS 里共用 MarginL / MarginR；居中时两者都不起作用。
    `MarginL=${Math.round(style.marginHorizontal * pictureWidth)}`,
    `MarginR=${Math.round(style.marginHorizontal * pictureWidth)}`,
    // BorderStyle=3 是「不透明底框」，1 是「描边+阴影」。有底色才用 3。
    `BorderStyle=${style.backgroundColor === null ? 1 : 3}`,
    `BackColour=${assColor(style.backgroundColor ?? style.shadowColor ?? '#000000', style.backgroundColor === null ? 1 : style.backgroundOpacity)}`,
  ]
  return parts.join(',')
}
