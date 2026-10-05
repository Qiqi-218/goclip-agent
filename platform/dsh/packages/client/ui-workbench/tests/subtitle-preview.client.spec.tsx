/**
 * The subtitle preview: which words belong at a moment of the film, and how the stored style
 * becomes something a browser can draw.
 *
 * The projection is the part that can be silently wrong. A cue placed by its recording time looks
 * plausible in a preview and is then missing from the export, or drawn while nothing is said — and
 * the mistake survives every check that only asks "did a subtitle appear". So the cases below pin
 * the conversion, the two appearances of reused material, and the boundary between two cues.
 */
import { describe, expect, it } from 'vitest'
import { cueAt, filmSecondsOf, previewCues, previewStyle, projectOntoFilm } from '../src/client/subtitle-preview.ts'
import type { ClipSpan } from '../src/client/timing.ts'

/**
 * One clip.
 * @param start - start in recording seconds.
 * @param end - end in recording seconds.
 * @param speed - playback rate.
 * @returns the clip.
 */
function clip(start: number, end: number, speed = 1): ClipSpan {
  return { start_us: start * 1e6, end_us: end * 1e6, speed, muted: false, name: null }
}

/** The real fast cut's first three clips: 0→7.72s, then 7.72→11.72s, then 11.72→14.56s at 2×. */
const CLIPS = [clip(21.74, 29.46), clip(272.49, 276.49), clip(296.58, 302.26, 2)]

describe('placing a span of the recording on the film', () => {
  it('moves a recording position to where the film uses it', () => {
    // 素材 22.74s 落在第 1 段里，而第 1 段在成片 0s 起 → 成片 1.00s。
    // 直接拿素材秒数当位置会让每一句都跑到成片最右端，看上去像个有意的位置。
    expect(projectOntoFilm(CLIPS, 22_740_000, 24_740_000)).toEqual([{ start: 1, end: 3 }])
  })

  it('accounts for the clip playback rate', () => {
    // 第 3 段是 2 倍速、素材 296.58s 起、成片 11.72s 起。素材里过 2 秒 = 成片里过 1 秒。
    //
    // 用 closeTo 而不是相等：成片位置是「前面各段之和 + 段内偏移」，实算得到
    // 12.719999999999999。那不是错，是浮点；要求精确相等只会让这条断言时红时绿，
    // 而它要守的是「倍率参与了换算」，不是小数点后第 15 位。
    const placed = projectOntoFilm(CLIPS, 298_580_000, 300_580_000)
    expect(placed).toHaveLength(1)
    expect(placed[0]?.start).toBeCloseTo(12.72, 6)
    expect(placed[0]?.end).toBeCloseTo(13.72, 6)
  })

  it('gives one entry per use when the cut uses the same stretch twice', () => {
    // 成片里真的有两处这段话，所以预览也要有两处。只留一处会让第二处没有字幕。
    const twice = [clip(10, 20), clip(10, 20)]
    expect(projectOntoFilm(twice, 12_000_000, 14_000_000)).toEqual([{ start: 2, end: 4 }, { start: 12, end: 14 }])
  })

  it('clips a span to the part of it the cut actually uses', () => {
    // 素材 10–20s 里只用了 12–14s，所以成片里只有那 2 秒。
    expect(projectOntoFilm([clip(12, 14)], 10_000_000, 20_000_000)).toEqual([{ start: 0, end: 2 }])
  })

  it('reports nothing for a stretch the cut does not use', () => {
    // 没被用上的素材在成片上没有位置。硬塞一个位置会让预览显示一句成片里没有的话。
    expect(projectOntoFilm(CLIPS, 100_000_000, 101_000_000)).toEqual([])
  })

  it('reports nothing for a span that touches a clip only at its edge', () => {
    expect(projectOntoFilm([clip(10, 20)], 20_000_000, 21_000_000)).toEqual([])
  })
})

describe('the cues a preview draws', () => {
  const LINES = [
    { start_us: 22_740_000, end_us: 24_740_000, text: '第一句' },
    { start_us: 273_490_000, end_us: 275_490_000, text: '第二句' },
  ]

  it('sorts the cues along the film rather than leaving them in recording order', () => {
    // 片段顺序与素材顺序不同时，按素材顺序排会让 cueAt 的「后者优先」选错。
    const reversed = [clip(272.49, 276.49), clip(21.74, 29.46)]
    expect(previewCues(reversed, LINES).map(cue => cue.text)).toEqual(['第二句', '第一句'])
  })

  it('keeps the words with the span they came from', () => {
    const cues = previewCues(CLIPS, LINES)
    expect(cues.map(cue => cue.text)).toEqual(['第一句', '第二句'])
    // 同样是 closeTo：成片位置累加前面各段，末位会有浮点尾巴。
    expect(cues[0]?.startFilmSeconds).toBeCloseTo(1, 6)
    expect(cues[0]?.endFilmSeconds).toBeCloseTo(3, 6)
    expect(cues[1]?.startFilmSeconds).toBeCloseTo(8.72, 6)
    expect(cues[1]?.endFilmSeconds).toBeCloseTo(10.72, 6)
  })

  it('reports the film length the cues are placed against', () => {
    // 7.72 + 4 + 2.84
    expect(filmSecondsOf(CLIPS)).toBeCloseTo(14.56, 5)
  })
})

describe('which cue is due at a moment', () => {
  const CUES = [
    { text: '第一句', startFilmSeconds: 1, endFilmSeconds: 3 },
    { text: '第二句', startFilmSeconds: 3, endFilmSeconds: 4 },
  ]

  it('draws nothing before the first cue', () => {
    expect(cueAt(CUES, 0.5)).toBeNull()
  })

  it('draws the cue whose span contains the moment', () => {
    expect(cueAt(CUES, 2)?.text).toBe('第一句')
    expect(cueAt(CUES, 3.5)?.text).toBe('第二句')
  })

  it('treats the end of a cue as the start of the next, not as the old one', () => {
    // 边界上两句都「够格」。取后一句：正在画的那一帧是新句的第一帧，
    // 多留一帧旧句读起来像字幕比说话慢半拍。
    expect(cueAt(CUES, 3)?.text).toBe('第二句')
  })

  it('draws nothing after the last cue ends', () => {
    expect(cueAt(CUES, 4)).toBeNull()
    expect(cueAt(CUES, 99)).toBeNull()
  })

  it('reports nothing when there are no cues at all', () => {
    expect(cueAt([], 1)).toBeNull()
  })
})

describe('the style the browser draws', () => {
  const PICTURE = { width: 1280, height: 720 }

  it('turns the size share into pixels for the picture it is given', () => {
    // 占比是相对画面的：同一份样式在 720p 与 1080p 下得到不同的像素值 —— 这正是要的。
    expect(previewStyle({ size: 0.05 }, PICTURE).text.fontSize).toBe('36px')
    expect(previewStyle({ size: 0.05 }, { width: 1920, height: 1080 }).text.fontSize).toBe('54px')
  })

  it('uses the burn defaults when the timeline has no style', () => {
    const { text } = previewStyle(null, PICTURE)
    // 宿主默认：微软雅黑、白色、0.04 画面高、黑描边。
    expect(text.fontFamily).toBe('Microsoft YaHei')
    expect(text.color).toBe('#ffffff')
    expect(text.fontSize).toBe('29px')
    expect(text.textShadow).toContain('#000000')
  })

  it('expresses the nine-grid position as alignment plus margins, never as coordinates', () => {
    const { box } = previewStyle({ alignment: 'top-left', marginVertical: 0.1, marginHorizontal: 0.05 }, PICTURE)
    expect(box.top).toBe('10%')
    expect(box.justifyContent).toBe('flex-start')
    expect(box.paddingLeft).toBe('5%')
    // 坐标会在换画幅时失效，所以预览也不该用坐标。
    expect(box.left).toBe('0')
    expect(box.right).toBe('0')
  })

  it('centres vertically without a margin when the style asks for the middle', () => {
    const { box } = previewStyle({ alignment: 'middle-center' }, PICTURE)
    expect(box.top).toBe('50%')
    expect(box.transform).toBe('translateY(-50%)')
    expect(box.justifyContent).toBe('center')
  })

  it('draws no outline when the width is zero', () => {
    expect(previewStyle({ outlineWidth: 0 }, PICTURE).text.textShadow).toBe('none')
  })

  it('gives the text no box unless a background colour was chosen', () => {
    expect(previewStyle({}, PICTURE).text.background).toBeUndefined()
    expect(previewStyle({ backgroundColor: '#112233', backgroundOpacity: 0.5 }, PICTURE).text.background)
      .toBe('rgba(17, 34, 51, 0.5)')
  })

  it('reports bold and italic as weight and slant', () => {
    const plain = previewStyle({}, PICTURE).text
    expect(plain.fontWeight).toBe('400')
    expect(plain.fontStyle).toBe('normal')
    const styled = previewStyle({ bold: true, italic: true }, PICTURE).text
    expect(styled.fontWeight).toBe('700')
    expect(styled.fontStyle).toBe('italic')
  })

  it('keeps the text readable at a tiny picture', () => {
    // 占比乘出来可能是 4 像素，那样的字谁也看不见；给一个下限，而不是画出来才发现。
    expect(previewStyle({ size: 0.01 }, { width: 320, height: 240 }).text.fontSize).toBe('8px')
  })
})
