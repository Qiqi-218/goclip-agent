/**
 * Reading a render attempt's stored detail, and the stages a failure reports.
 *
 * A job's `detail` column holds two different things depending on when it was written: a sentence
 * for a film that finished, and a JSON record of the error plus the stages reached, for a failure.
 * Reading it as though it were always JSON loses the note on every film rendered before that
 * change; reading it as though it were always text loses the stage a failure died at. Both cases
 * are pinned here because the column is history and cannot be migrated in place.
 */
import { describe, expect, it } from 'vitest'
import { renderDetail } from '../src/runtime.ts'

describe('reading what a render attempt stored', () => {
  it('recovers the stage a failure died at', () => {
    const detail = JSON.stringify({
      error: 'ffmpeg exited 1',
      failed_stage: '烧录字幕',
      stages: [
        { stage: '切割', ms: 12, outcome: 'ok' },
        { stage: '烧录字幕', ms: 30, outcome: 'failed', reason: 'ffmpeg exited 1' },
      ],
    })
    const parsed = renderDetail(detail)
    expect(parsed.failed_stage).toBe('烧录字幕')
    expect(parsed.note).toBe('ffmpeg exited 1')
    expect(Array.isArray(parsed.stages)).toBe(true)
    expect((parsed.stages as unknown[]).length).toBe(2)
  })

  it('treats a plain-text detail as a note rather than trying to parse it', () => {
    // 这个字段是历史列：里面可能是 JSON 之前写下的纯文本。把它当 JSON 读会连备注一起丢掉。
    const parsed = renderDetail('共 10 段；关键帧间隔约 0.30 秒在容差内，保留原始编码')
    expect(parsed.note).toContain('共 10 段')
    expect(parsed.failed_stage).toBeNull()
    expect(parsed.stages).toEqual([])
  })

  it('does not claim a stage when a failure recorded none', () => {
    // 阶段为 null 是「宿主没说」，不是「第一步」；编一个出来会让界面指向错误的地方。
    const parsed = renderDetail(JSON.stringify({ error: '磁盘满了', failed_stage: null, stages: [] }))
    expect(parsed.failed_stage).toBeNull()
    expect(parsed.stages).toEqual([])
  })

  it('reports nothing at all for a job with no detail', () => {
    for (const detail of [null, '']) {
      const parsed = renderDetail(detail)
      expect(parsed).toEqual({ note: null, failed_stage: null, stages: [] })
    }
  })

  it('refuses a stages value that is not a list rather than passing it to the renderer', () => {
    // 这不是「信任同进程类型」的场合：这个值来自上一次进程写进 SQLite 的文本。
    const parsed = renderDetail(JSON.stringify({ error: 'x', failed_stage: '切割', stages: 'nope' }))
    expect(parsed.stages).toEqual([])
    expect(parsed.failed_stage).toBe('切割')
  })

  it('ignores a detail whose error is not a string', () => {
    const parsed = renderDetail(JSON.stringify({ error: { nested: true }, failed_stage: '切割' }))
    expect(parsed.note).toBeNull()
  })
})
