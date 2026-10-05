// @vitest-environment jsdom
/**
 * Evidence on the recording's axis: which marks the cut actually uses, and where they sit.
 *
 * The axis is the recording, so a mark's position is its own recording time — nothing is remapped.
 * What is left for this module to get right is the filtering and the splitting:
 *
 * - a mark the cut never uses must not be drawn, or the film appears to contain something it does
 *   not;
 * - a mark straddling the gap between two used stretches must be **split**, not carried across,
 *   because the film genuinely does not contain the seconds in between;
 * - a stretch used twice sits in one place, but must be reported once per use.
 *
 * Numbers come from the real fast cut: asset 2584.13s, ten clips, 86.21s of film.
 *
 * This replaces a version that remapped every mark onto the film's axis. That remapping made a
 * mark's position depend on how many clips preceded it, and it is why the timeline and the player
 * could name different moments for the same click.
 */
import { describe, expect, it } from 'vitest'
import { filmPositionOf, loudnessColumns, toUsedSpans } from '../src/client/evidence-model.ts'
import type { ClipSpan } from '../src/client/timing.ts'

/** Three clips of the real fast cut, in output order. */
const CLIPS: ClipSpan[] = [
  { start_us: 21_740_000, end_us: 29_460_000, speed: 1, muted: false, name: null },
  { start_us: 272_490_000, end_us: 276_490_000, speed: 1, muted: false, name: null },
  { start_us: 296_580_000, end_us: 302_260_000, speed: 2, muted: false, name: null },
]

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

describe('placing a measured span', () => {
  it('leaves a span where it already is', () => {
    // 素材 22.74→24.74 秒的标记就画在轴的 22.74→24.74 秒处。
    // 在成片轴上它会被挪到 1.00 秒处 —— 那个位置与它测量的时刻无关。
    const placed = toUsedSpans(CLIPS, [{ start_us: 22_740_000, end_us: 24_740_000 }])
    expect(placed).toHaveLength(1)
    expect(placed[0]?.start).toBeCloseTo(22.74, 6)
    expect(placed[0]?.end).toBeCloseTo(24.74, 6)
  })

  it('does not let the playback rate move a mark', () => {
    // 第 3 段是 2 倍速，但标记测的是**录制**里的 297.58→299.58 秒，画出来就是那两个时刻。
    const placed = toUsedSpans(CLIPS, [{ start_us: 297_580_000, end_us: 299_580_000 }])
    expect(placed).toHaveLength(1)
    expect(placed[0]?.start).toBeCloseTo(297.58, 6)
    expect(placed[0]?.end).toBeCloseTo(299.58, 6)
  })

  it('drops a span the cut never uses instead of pinning it to an end', () => {
    // 把没被取用的标记塞到端点，会让人以为成片里有这段内容。这条素材里有 944 秒没被用。
    expect(toUsedSpans(CLIPS, [{ start_us: 90_000_000, end_us: 95_000_000 }])).toEqual([])
  })

  it('keeps only the part of a span that falls inside a clip', () => {
    // 29.46 秒之后素材不再被第 1 段取用，所以 29.00→30.00 只剩 29.00→29.46。
    const placed = toUsedSpans(CLIPS, [{ start_us: 29_000_000, end_us: 30_000_000 }])
    expect(placed).toHaveLength(1)
    expect(placed[0]?.sourceStartUs).toBe(29_000_000)
    expect(placed[0]?.sourceEndUs).toBe(29_460_000)
    expect(placed[0]?.start).toBeCloseTo(29, 6)
    expect(placed[0]?.end).toBeCloseTo(29.46, 6)
  })

  it('splits a span that crosses the gap between two used stretches', () => {
    /*
     * 素材 274→298 秒落在第 2 段（272.49→276.49）与第 3 段（296.58→302.26）里，
     * 而 276.49→296.58 之间的 20 秒没有被取用。所以它断成两截，而不是跨过那段空隙连成一条 ——
     * 连成一条会画出成片里根本不存在的连续内容。
     */
    const placed = toUsedSpans(CLIPS, [{ start_us: 274_000_000, end_us: 298_000_000 }])
    expect(placed).toHaveLength(2)
    expect(placed[0]?.start).toBeCloseTo(274, 6)
    expect(placed[0]?.end).toBeCloseTo(276.49, 6)
    expect(placed[1]?.start).toBeCloseTo(296.58, 6)
    expect(placed[1]?.end).toBeCloseTo(298, 6)
  })

  it('reports spans in recording order even when given out of order', () => {
    const placed = toUsedSpans(CLIPS, [
      { start_us: 297_580_000, end_us: 299_580_000 },
      { start_us: 22_000_000, end_us: 23_000_000 },
    ])
    expect(placed.map(span => Math.round(span.start * 100) / 100)).toEqual([22, 297.58])
  })

  it('reports the stretch once per clip that uses it, though it sits in one place', () => {
    // 位置是素材的属性，所以两处取用画在同一个位置；条目数仍与取用次数一致，
    // 这样「这一刀用了它两次」不会被压成一次。
    const reused = [clip(0, 10), clip(50, 60), clip(2, 8)]
    const placed = toUsedSpans(reused, [{ start_us: 2_000_000, end_us: 8_000_000 }])
    expect(placed).toHaveLength(2)
    expect(placed.every(piece => piece.start === 2 && piece.end === 8)).toBe(true)
  })

  it('ignores a degenerate clip rather than drawing a zero-width mark', () => {
    expect(toUsedSpans([clip(10, 10)], [{ start_us: 0, end_us: 20_000_000 }])).toEqual([])
  })
})

describe('asking where a moment sits on the film', () => {
  it('reports the film position for a moment the cut uses', () => {
    // 这条换算仍然要有：导出与字幕烧录按成片时间走，它只是不再是时间线的轴。
    // 素材 22.74 秒在第 1 段（成片 0→7.72）里，落在成片 1.00 秒。
    expect(filmPositionOf(CLIPS, 22_740_000)).toBeCloseTo(1, 6)
  })

  it('reports nothing for a moment the cut leaves out', () => {
    // 素材 100 秒没有被任何一段取用 —— 它在成片里没有位置，返回 null 而不是端点。
    expect(filmPositionOf(CLIPS, 100_000_000)).toBeNull()
  })
})

describe('loudness readings on the recording axis', () => {
  /** One reading per second across the recording. */
  const levels = Array.from({ length: 300 }, (_, index) => -40 + (index % 20))
  const WINDOW_US = 1_000_000

  it('covers the whole recording, not just the used stretches', () => {
    // 曲线是素材的属性：把它裁到这一刀用到的部分，会让两刀不同的剪辑看起来音频不一样。
    const columns = loudnessColumns(levels, WINDOW_US, 40)
    expect(columns).toHaveLength(40)
    expect(columns[columns.length - 1]?.at).toBeGreaterThan(0.9)
  })

  it('reports the position as a share of the recording, so it does not need the clips', () => {
    /*
     * 只要读数与窗口，不需要片段 —— 这正是「轴是素材」带来的简化：每个读数都有位置，
     * 因为它就是素材的一部分。在成片轴上这里要先问「它落在哪一段里」，
     * 而没被取用的读数无位可放，只能被丢掉。
     */
    const columns = loudnessColumns(levels, WINDOW_US, 10)
    expect(columns[1]?.at).toBeCloseTo(0.15, 6)
  })

  it('keeps readings even with no clips at all', () => {
    // 上一条的另一面：没有片段也照样有曲线。
    expect(loudnessColumns(levels, WINDOW_US, 10).length).toBeGreaterThan(0)
  })

  it('takes the peak of a bucket rather than averaging the rise away', () => {
    // 取均值会把「这一秒突然响了」抹平，而那正是要看这条轨道的原因。
    const spike = [10, 10, 10, 10, -40, -40, -40, -40]
    const columns = loudnessColumns(spike, 1_000_000, 2)
    expect(columns[0]?.db).toBe(10)
    expect(columns[1]?.db).toBe(-40)
  })

  it('returns nothing when there is nothing to draw', () => {
    expect(loudnessColumns([], WINDOW_US, 40)).toEqual([])
    expect(loudnessColumns(levels, 0, 40)).toEqual([])
    expect(loudnessColumns(levels, WINDOW_US, 0)).toEqual([])
  })
})
