/**
 * Subtitle style: what a spoken description becomes, and what reaches ffmpeg.
 *
 * Two failure modes drive these cases, and both are silent:
 *
 * - **A field that never reaches ffmpeg.** An unknown `force_style` key is ignored by libass, so a
 *   style that "looks right" in the tool's reply produces a film with none of it applied. The
 *   assertions therefore read the generated string, not the object it came from.
 * - **A colour with its channels swapped.** ASS writes colours as `&HAABBGGRR` — alpha first, then
 *   the channels reversed against the `#rrggbb` a person writes. Swapping red and blue reads as
 *   "the colour is wrong", not as a bug, so the conversion is pinned here.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_ALIGNMENTS,
  resolveSubtitleStyle,
  toAssStyle,
  type SubtitleStyleInput,
} from '../src/subtitle-style.ts'

/**
 * Resolve a style, failing the test rather than returning a union.
 * @param input - the requested fields.
 * @returns the resolved style.
 */
function resolve(input: SubtitleStyleInput) {
  const result = resolveSubtitleStyle(input)
  if ('problems' in result) throw new Error(`预料之外的拒绝：${JSON.stringify(result.problems)}`)
  return result.style
}

/** 1080p, the size the shares are documented against. */
const HEIGHT = 1080
const WIDTH = 1920

describe('resolving a requested style', () => {
  it('keeps every default when nothing is asked for', () => {
    expect(resolve({})).toEqual(DEFAULT_SUBTITLE_STYLE)
  })

  it('applies only the fields that were given', () => {
    const style = resolve({ color: '#ffd700', bold: true })
    expect(style.color).toBe('#ffd700')
    expect(style.bold).toBe(true)
    // 没提到的字段保持默认 —— 否则每次改颜色都会把其它设置冲掉。
    expect(style.font).toBe(DEFAULT_SUBTITLE_STYLE.font)
    expect(style.alignment).toBe(DEFAULT_SUBTITLE_STYLE.alignment)
  })

  it('accepts the whole nine-grid', () => {
    for (const alignment of SUBTITLE_ALIGNMENTS) {
      expect(resolve({ alignment }).alignment).toBe(alignment)
    }
  })

  it('accepts an explicit null for a colour, which means "none"', () => {
    // null 与「没提」是两件事：前者是「不要背景」，后者是「保持原样」。
    const style = resolve({ backgroundColor: null })
    expect(style.backgroundColor).toBeNull()
  })
})

describe('refusing what cannot be drawn', () => {
  it('names every bad field at once instead of the first', () => {
    // 一次只报一个错会让模型来回三轮；三个错要一次说清。
    const result = resolveSubtitleStyle({ color: '黄色', size: 9, alignment: 'bottom-centre' as never })
    expect('problems' in result).toBe(true)
    if (!('problems' in result)) return
    expect(result.problems.map(problem => problem.field).sort()).toEqual(['alignment', 'color', 'size'])
  })

  it('says what would have been accepted', () => {
    const result = resolveSubtitleStyle({ color: 'yellow' })
    if (!('problems' in result)) throw new Error('应当被拒绝')
    expect(result.problems[0]?.expected).toContain('#rrggbb')
  })

  it('refuses a size that is a pixel count rather than a share', () => {
    // 22 是「22 像素」的写法；这里要的是占比。收下它会让字号变成画面高度的 22 倍。
    expect('problems' in resolveSubtitleStyle({ size: 22 })).toBe(true)
  })

  it('refuses a colour without the leading hash', () => {
    expect('problems' in resolveSubtitleStyle({ color: 'ffd700' })).toBe(true)
  })

  it('refuses an opacity with no colour to apply it to', () => {
    // 「半透明背景」但没给背景色：少说了一项，猜一个颜色不如问清楚。
    const result = resolveSubtitleStyle({ backgroundColor: null, backgroundOpacity: 0.5 })
    expect('problems' in result).toBe(true)
    if (!('problems' in result)) return
    expect(result.problems[0]?.field).toBe('backgroundColor')
  })

  it('refuses an empty font name', () => {
    expect('problems' in resolveSubtitleStyle({ font: '   ' })).toBe(true)
  })
})

describe('the style that reaches ffmpeg', () => {
  it('reverses the colour channels, because ASS writes them the other way round', () => {
    // #ffd700 是红 ff、绿 d7、蓝 00；ASS 要 &H00 00d7ff —— 蓝在前。
    const ass = toAssStyle(resolve({ color: '#ffd700' }), HEIGHT, WIDTH)
    expect(ass).toContain('PrimaryColour=&H0000D7FF')
  })

  it('puts the alpha first for the background box', () => {
    // 颜色用**不对称**的 #112233：用 #000000 时三条通道相同，通道顺序写反也看不出来，
    // 那条断言就成了摆设。
    // 不透明度 0.5 → alpha = 1 − 0.5 = 0.5 → 0x80；#112233 反转后是 332211。
    const ass = toAssStyle(resolve({ backgroundColor: '#112233', backgroundOpacity: 0.5 }), HEIGHT, WIDTH)
    expect(ass).toContain('BackColour=&H80332211')
  })

  it('turns the size share into pixels for the picture it is given', () => {
    // 占比是相对画面的，所以同一份样式在 1080p 与 720p 下得到不同的像素值 —— 这正是要的。
    const style = resolve({ size: 0.05 })
    expect(toAssStyle(style, 1080, 1920)).toContain('FontSize=54')
    expect(toAssStyle(style, 720, 1280)).toContain('FontSize=36')
  })

  it('expresses position as alignment plus margins, never as coordinates', () => {
    // 坐标会在换画幅时失效；九宫格加边距不会。
    const ass = toAssStyle(resolve({ alignment: 'top-left', marginVertical: 0.1, marginHorizontal: 0.05 }), HEIGHT, WIDTH)
    expect(ass).toContain('Alignment=7')
    expect(ass).toContain('MarginV=108')
    expect(ass).toContain('MarginL=96')
    expect(ass).not.toMatch(/\bPos\(/)
  })

  it('switches to a background box only when there is a background colour', () => {
    expect(toAssStyle(resolve({}), HEIGHT, WIDTH)).toContain('BorderStyle=1')
    expect(toAssStyle(resolve({ backgroundColor: '#000000' }), HEIGHT, WIDTH)).toContain('BorderStyle=3')
  })

  it('draws no outline when the width is zero', () => {
    expect(toAssStyle(resolve({ outlineWidth: 0 }), HEIGHT, WIDTH)).toContain('Outline=0')
  })

  it('draws no shadow unless a shadow colour was given', () => {
    // 只给偏移量会得到一个看不见的设置：ASS 的阴影颜色跟着 BackColour 走，
    // 没有颜色时应当如实报告「没有阴影」，而不是给一个 0 之外却没有效果的偏移。
    expect(toAssStyle(resolve({ shadowOffset: 0.1 }), HEIGHT, WIDTH)).toContain('Shadow=0')
    expect(toAssStyle(resolve({ shadowColor: '#000000', shadowOffset: 0.1 }), HEIGHT, WIDTH)).not.toContain('Shadow=0')
  })

  it('never emits a key the format does not define', () => {
    // 未知的 force_style 键会被 libass 静默忽略 —— 那看起来像「设置没生效」，
    // 所以样式里不许出现 ASS 没有的字段名。
    const known = new Set([
      'FontName', 'FontSize', 'Bold', 'Italic', 'PrimaryColour', 'OutlineColour', 'Outline',
      'Shadow', 'Alignment', 'MarginV', 'MarginL', 'MarginR', 'BorderStyle', 'BackColour',
    ])
    const ass = toAssStyle(resolve({
      backgroundColor: '#112233', shadowColor: '#445566', shadowOffset: 0.05, outlineWidth: 0.04,
    }), HEIGHT, WIDTH)
    for (const part of ass.split(',')) {
      expect(known.has(part.split('=')[0] as string)).toBe(true)
    }
  })

  it('keeps a font size readable even at a tiny picture', () => {
    // 占比乘出来可能是 3 像素，那样的字谁也看不见；给一个下限而不是画出来才发现。
    expect(toAssStyle(resolve({ size: 0.01 }), 240, 426)).toContain('FontSize=8')
  })
})
