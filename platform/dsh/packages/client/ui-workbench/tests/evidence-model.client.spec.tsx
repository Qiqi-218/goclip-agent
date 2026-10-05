// @vitest-environment jsdom
/**
 * Placing the recording's evidence on the film's axis.
 *
 * Evidence is measured against the recording; the editor's axis is the film. The cases here are
 * chosen around the places where a plausible conversion is wrong:
 *
 * - a moment the cut does **not** use has no place on the film, and must not be pinned to an end;
 * - a stretch the cut uses **twice** has to appear twice, not once at an averaged position;
 * - a clip at 2× compresses its evidence into half the film time.
 *
 * Numbers come from the real fast cut: asset 2584.13s, ten clips, 86.21s of film.
 */
import { describe, expect, it } from 'vitest'
import { filmPositionOf, loudnessColumns, toFilmSpans } from '../src/client/evidence-model.ts'

/** Three clips, in film order: 0→7.72s draws 21.74→29.46s of the recording. */
const CLIPS = [
  { ordinal: 0, start_us: 21_740_000, end_us: 29_460_000, speed: 1, muted: false },
  { ordinal: 1, start_us: 272_490_000, end_us: 276_490_000, speed: 1, muted: false },
  { ordinal: 2, start_us: 296_580_000, end_us: 302_260_000, speed: 2, muted: false },
]

describe('one moment in the recording', () => {
  it('lands where the film uses it', () => {
    // 素材 21.74s 是第 1 段的开头，所以在成片 0 秒处。
    expect(filmPositionOf(CLIPS, 21_740_000)).toBeCloseTo(0, 6)
    // 素材 25.60s 在成片里是 0 + (25.60 − 21.74) = 3.86 秒。
    expect(filmPositionOf(CLIPS, 25_600_000)).toBeCloseTo(3.86, 6)
    // 第 2 段从成片 7.72 秒开始。
    expect(filmPositionOf(CLIPS, 272_490_000)).toBeCloseTo(7.72, 6)
  })

  it('compresses time inside a clip that plays faster', () => {
    // 第 3 段 2 倍速：素材里过 4 秒，成片里只占 2 秒。
    // 它从成片 11.72 秒开始，素材 296.58s 起；素材 300.58s 应对应成片 11.72 + 4/2 = 13.72。
    expect(filmPositionOf(CLIPS, 300_580_000)).toBeCloseTo(13.72, 6)
  })

  it('has no place when the cut does not use that moment', () => {
    // 素材 100s 处没有被任何一段取用 —— 它在这条成片上没有位置。
    expect(filmPositionOf(CLIPS, 100_000_000)).toBeNull()
  })
})

describe('placing a measured span', () => {
  it('keeps a span that sits inside one clip', () => {
    const placed = toFilmSpans(CLIPS, [{ start_us: 22_740_000, end_us: 24_740_000 }])
    expect(placed).toHaveLength(1)
    expect(placed[0]?.start).toBeCloseTo(1, 6)
    expect(placed[0]?.end).toBeCloseTo(3, 6)
  })

  it('drops a span the cut never uses instead of pinning it to an end', () => {
    // 把没有位置的标记塞到端点，会让人以为成片里有这段内容。
    expect(toFilmSpans(CLIPS, [{ start_us: 90_000_000, end_us: 95_000_000 }])).toEqual([])
  })

  it('keeps only the part of a span that falls inside a clip', () => {
    // 29.46s 之后素材不再被第 1 段取用，所以 29.00→30.00 只剩 29.00→29.46。
    const placed = toFilmSpans(CLIPS, [{ start_us: 29_000_000, end_us: 30_000_000 }])
    expect(placed).toHaveLength(1)
    expect(placed[0]?.sourceStartUs).toBe(29_000_000)
    expect(placed[0]?.sourceEndUs).toBe(29_460_000)
    expect(placed[0]?.end).toBeCloseTo(7.72, 6)
  })

  it('splits a span that crosses a clip boundary', () => {
    // 素材 274→298 秒跨在第 2 段（272.49→276.49）与第 3 段（296.58→302.26）之间，
    // 两段之间那段素材没有被取用。于是它必须在成片里断成两截。
    const placed = toFilmSpans(CLIPS, [{ start_us: 274_000_000, end_us: 298_000_000 }])
    expect(placed).toHaveLength(2)
    // 第 2 段：成片 7.72 + (274 − 272.49) = 9.23 起，到该段结束 11.72。
    expect(placed[0]?.start).toBeCloseTo(9.23, 6)
    expect(placed[0]?.end).toBeCloseTo(11.72, 6)
    // 第 3 段：从段落起点 11.72 起，走 (298 − 296.58)/2 = 0.71 秒。
    expect(placed[1]?.start).toBeCloseTo(11.72, 6)
    expect(placed[1]?.end).toBeCloseTo(12.43, 6)
  })

  it('shows a stretch twice when the cut uses it twice', () => {
    const repeated = [
      { ordinal: 0, start_us: 0, end_us: 10_000_000, speed: 1, muted: false },
      { ordinal: 1, start_us: 50_000_000, end_us: 60_000_000, speed: 1, muted: false },
      { ordinal: 2, start_us: 2_000_000, end_us: 8_000_000, speed: 1, muted: false },
    ]
    // 素材 2→8 秒被第 1 段与第 3 段各用了一次，所以它必须在成片里出现两次。
    const placed = toFilmSpans(repeated, [{ start_us: 2_000_000, end_us: 8_000_000 }])
    expect(placed).toHaveLength(2)
    expect(placed[0]?.start).toBeCloseTo(2, 6)
    expect(placed[1]?.start).toBeCloseTo(20, 6)
  })

  it('reports spans in film order even when given out of order', () => {
    const placed = toFilmSpans(CLIPS, [
      { start_us: 297_580_000, end_us: 299_580_000 },
      { start_us: 22_000_000, end_us: 23_000_000 },
    ])
    expect(placed.map(span => Math.round(span.start * 100) / 100)).toEqual([0.26, 12.22])
  })
})

describe('loudness readings on the film axis', () => {
  /** One reading per second across the recording. */
  const levels = Array.from({ length: 300 }, (_, index) => -40 + (index % 20))
  const WINDOW_US = 1_000_000

  it('reduces to the requested number of columns', () => {
    const columns = loudnessColumns(CLIPS, levels, WINDOW_US, 60)
    expect(columns.length).toBeGreaterThan(0)
    expect(columns.length).toBeLessThanOrEqual(60)
    expect(columns.every(column => column.at >= 0 && column.at <= 1)).toBe(true)
  })

  it('keeps the peak of each column rather than averaging it away', () => {
    // 每个桶里最响的那个读数要留下来，否则一次突然的响度抬升会被平均掉 —— 而那正是要看它的理由。
    const columns = loudnessColumns(CLIPS, levels, WINDOW_US, 4)
    expect(columns.length).toBeGreaterThan(0)
    expect(Math.max(...columns.map(column => column.db))).toBe(-21)
  })

  it('leaves out readings from stretches the cut does not use', () => {
    // 断言的形状要一眼可读：**未被取用的整段都设成很响的 +10**，被取用的设成 −10。
    // 若前者被画进来，最大读数就会是 +10 而不是 −10。
    // 只用「100→200 秒」这种离任何片段都很远的区间，避免与时间窗边界较劲。
    const levels = Array.from({ length: 2584 }, () => -10)
    for (let index = 100; index < 200; index += 1) levels[index] = 10
    for (let index = 600; index < 700; index += 1) levels[index] = 10
    const columns = loudnessColumns(CLIPS, levels, WINDOW_US, 40)
    expect(columns.length).toBeGreaterThan(0)
    expect(Math.max(...columns.map(column => column.db))).toBe(-10)
  })

  it('does draw readings that the cut does use', () => {
    // 上一条证明「不该画的没画」，这一条证明「该画的画了」——
    // 只测前者的实现可以靠「什么都不画」通过。
    const levels = Array.from({ length: 2584 }, () => -80)
    // 25 秒落在第 1 段（21.74→29.46）内。
    levels[25] = -5
    const columns = loudnessColumns(CLIPS, levels, WINDOW_US, 40)
    expect(Math.max(...columns.map(column => column.db))).toBe(-5)
  })

  it('skips a bucket no used reading falls into instead of drawing a floor value', () => {
    // 桶数远多于「被取用的读数个数」时才会出现真正的空桶：400 个桶分 14.56 秒，
    // 每桶 0.036 秒，而读数分辨率是 1 秒 —— 于是只有 18 个桶会被填上。
    // 空桶必须被跳过；若填成最小读数，时间线上会出现一段看上去「这里很安静」的柱子，
    // 而那是**没测到**，不是安静。
    const levels = Array.from({ length: 2584 }, () => -80)
    levels[25] = -5
    const columns = loudnessColumns(CLIPS, levels, 1_000_000, 400)
    // 18 个被取用的读数各占一个桶，所以列数远小于 400 —— 中间的空桶没有变成柱子。
    expect(columns.length).toBeGreaterThan(1)
    expect(columns.length).toBeLessThan(400)
    expect(columns.filter(column => column.db === -5)).toHaveLength(1)
  })

  it('returns nothing when there is nothing to draw', () => {
    expect(loudnessColumns(CLIPS, [], WINDOW_US, 40)).toEqual([])
    expect(loudnessColumns([], levels, WINDOW_US, 40)).toEqual([])
    expect(loudnessColumns(CLIPS, levels, 0, 40)).toEqual([])
  })
})
