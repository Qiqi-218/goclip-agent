// @vitest-environment jsdom
/**
 * The action bar for the selected clip: which controls it offers, when they are usable, and what
 * each one reports.
 *
 * Two failure modes drive these cases. A control that is offered when the host will refuse it
 * teaches the wrong thing about the operation — merging across a gap looks possible and then
 * errors. And a control that reports the wrong arguments is worse than one that is missing: a
 * rename that carries the previous clip's name, or a split whose cut point is computed from the
 * wrong clip, both produce a plausible edit in the wrong place.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ClipActions } from '../src/client/ClipActions.tsx'
import type {} from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import type { EditableClip } from '../src/client/editor-model.ts'

afterEach(cleanup)

/**
 * Dictionary lookup with the `{name}` substitution the locale seat performs.
 * @param key - dictionary key.
 * @param params - placeholder values.
 * @returns the rendered string.
 */
const t = (key: keyof typeof zh, params?: Record<string, unknown>): string => {
  const template = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/**
 * One clip.
 * @param ordinal - its position.
 * @param start - start in asset seconds.
 * @param end - end in asset seconds.
 * @param extra - fields to override.
 * @returns the clip.
 */
function clip(ordinal: number, start: number, end: number, extra: Partial<EditableClip> = {}): EditableClip {
  return { ordinal, start_us: start * 1e6, end_us: end * 1e6, speed: 1, muted: false, name: null, ...extra }
}

/** Two clips that continue each other, so every control is usable. */
const CONTIGUOUS = [clip(0, 10, 20, { name: '开场' }), clip(1, 20, 30)]

/**
 * Render the bar.
 * @param overrides - props to replace.
 * @returns the render result plus the intent spy.
 */
function renderBar(overrides: Partial<Parameters<typeof ClipActions>[0]> = {}) {
  const onIntent = vi.fn()
  const result = render(
    <ClipActions
      baseRevision={4}
      clip={CONTIGUOUS[0] as EditableClip}
      clips={CONTIGUOUS}
      onIntent={onIntent}
      t={t as never}
      timelineId="tl-1"
      {...overrides}
    />,
  )
  return { ...result, onIntent }
}

/**
 * Find one control by its action name.
 * @param container - the rendered tree.
 * @param action - the action's name.
 * @returns the element.
 */
function action(container: HTMLElement, name: string): HTMLElement {
  const found = container.querySelector(`[data-clip-action="${name}"]`)
  if (found === null) throw new Error(`没有 ${name} 这个控件`)
  return found as HTMLElement
}

describe('what the bar offers', () => {
  it('shows a hint instead of controls when nothing is selected', () => {
    const { container } = renderBar({ clip: null })
    expect(container.querySelector('[data-clip-actions-hint]')).not.toBeNull()
    expect(container.querySelector('[data-clip-action="split"]')).toBeNull()
  })

  it('names the clip it is about', () => {
    const { container } = renderBar()
    expect(container.querySelector('[data-clip-actions-for]')?.textContent).toContain('第 1 段')
  })

  it('offers the rates and marks the one in use', () => {
    const { container } = renderBar({ clip: clip(0, 10, 20, { speed: 1.5 }) })
    const rates = [...container.querySelectorAll('[data-clip-speed]')]
    expect(rates.map(node => node.getAttribute('data-clip-speed'))).toEqual(['0.5', '1', '1.5', '2', '3'])
    expect(container.querySelector('[data-clip-speed="1.5"]')?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('what the bar refuses to offer', () => {
  it('does not offer a merge the host would reject', () => {
    // 两段在素材上不相接时合并会把缺口也算进成片，宿主拒绝 —— 按钮就不该可用。
    const apart = [clip(0, 10, 20), clip(1, 25, 30)]
    const { container } = renderBar({ clips: apart, clip: apart[0] as EditableClip })
    const merge = action(container, 'merge') as HTMLButtonElement
    expect(merge.disabled).toBe(true)
    // 灰掉的按钮要说明缺什么，否则用户以为是自己点错了。
    expect(merge.getAttribute('title')).toContain('首尾相接')
  })

  it('allows removing the final clip, which leaves an empty timeline rather than deleting source media', () => {
    const only = [clip(0, 10, 20)]
    const { container } = renderBar({ clips: only, clip: only[0] as EditableClip })
    expect((action(container, 'remove') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not offer to move the first clip earlier or the last one later', () => {
    const { container } = renderBar()
    expect((action(container, 'earlier') as HTMLButtonElement).disabled).toBe(true)
    expect((action(container, 'later') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not offer to split a clip too short to cut in two', () => {
    const tiny = [clip(0, 10, 10.4)]
    const { container } = renderBar({ clips: tiny, clip: tiny[0] as EditableClip })
    expect((action(container, 'split') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('what each control reports', () => {
  it('cuts at the middle of the clip, in asset time', () => {
    const { container, onIntent } = renderBar()
    fireEvent.click(action(container, 'split'))
    // 第 1 段取素材 10–20s，中点 15s。给成片时间或另一段的中点都会切错地方。
    expect(onIntent).toHaveBeenCalledWith({
      tool: 'video_timeline_split',
      args: { timeline_id: 'tl-1', base_revision: 4, ordinal: 0, asset_time_us: 15_000_000 },
    })
  })

  it('moves a clip one position and says which clip it is that moves', () => {
    // 重排的 from 是「被挪走的那一段」。写成 to 会让相邻的另一段被搬走。
    // 用三段：只有两段时最后一段的「后移」是禁用的，那条断言就测不到东西。
    const three = [clip(0, 10, 20), clip(1, 20, 30), clip(2, 30, 40)]
    const { container, onIntent } = renderBar({ clips: three, clip: three[1] as EditableClip })
    fireEvent.click(action(container, 'later'))
    expect(onIntent).toHaveBeenCalledWith({
      tool: 'video_timeline_reorder',
      args: { timeline_id: 'tl-1', base_revision: 4, from: 1, to: 2 },
    })
  })

  it('reports the same pair in the other direction when moving a clip earlier', () => {
    // 两个方向的参数各自要断言。只测「后移」时，把「前移」的 from/to 写反不会被发现 ——
    // 实测：把 from 换成 to 的那次改动，只有这一条能红。
    const three = [clip(0, 10, 20), clip(1, 20, 30), clip(2, 30, 40)]
    const { container, onIntent } = renderBar({ clips: three, clip: three[1] as EditableClip })
    fireEvent.click(action(container, 'earlier'))
    expect(onIntent).toHaveBeenCalledWith({
      tool: 'video_timeline_reorder',
      args: { timeline_id: 'tl-1', base_revision: 4, from: 1, to: 0 },
    })
  })

  it('sends only the field being changed when the rate changes', () => {
    const { container, onIntent } = renderBar()
    fireEvent.click(container.querySelector('[data-clip-speed="2"]') as Element)
    const sent = onIntent.mock.calls[0]?.[0] as { args: Record<string, unknown> }
    expect(sent.args).toEqual({ timeline_id: 'tl-1', base_revision: 4, ordinal: 0, speed: 2 })
    // 没提到 muted，所以已静音的片段不会被调倍速顺手恢复声音。
    expect('muted' in sent.args).toBe(false)
  })

  it('toggles mute without touching the rate', () => {
    const { container, onIntent } = renderBar({ clip: clip(0, 10, 20, { muted: true }) })
    fireEvent.click(action(container, 'mute'))
    const sent = onIntent.mock.calls[0]?.[0] as { args: Record<string, unknown> }
    expect(sent.args).toEqual({ timeline_id: 'tl-1', base_revision: 4, ordinal: 0, muted: false })
  })
})

describe('renaming', () => {
  it('starts from the name the clip already has', () => {
    // 空白起步会让人以为这一段没名字，随手一填就把原来的名字冲掉。
    const { container } = renderBar()
    const input = container.querySelector('[data-clip-rename]') as HTMLInputElement
    expect(input.value).toBe('开场')
  })

  it('reports the typed name on submit, not the stored one', () => {
    const { container, onIntent } = renderBar()
    const input = container.querySelector('[data-clip-rename]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '塔的特写' } })
    fireEvent.submit(container.querySelector('[data-clip-rename-form]') as Element)
    expect(onIntent).toHaveBeenCalledWith({
      tool: 'video_timeline_name_segment',
      args: { timeline_id: 'tl-1', base_revision: 4, ordinal: 0, name: '塔的特写' },
    })
  })

  it('does not send anything while the name is being typed', () => {
    // 每一次按键都发一条编辑会让版本号被敲字推着往前走。
    const { container, onIntent } = renderBar()
    fireEvent.change(container.querySelector('[data-clip-rename]') as Element, { target: { value: '塔' } })
    expect(onIntent).not.toHaveBeenCalled()
  })

  it('clears the field when a different clip is selected', () => {
    // 留着上一段的名字，按回车就会把它写到这一段上。
    const { container, rerender } = render(
      <ClipActions baseRevision={4} clip={CONTIGUOUS[0] as EditableClip} clips={CONTIGUOUS} onIntent={vi.fn()} t={t as never} timelineId="tl-1" />,
    )
    rerender(
      <ClipActions baseRevision={4} clip={CONTIGUOUS[1] as EditableClip} clips={CONTIGUOUS} onIntent={vi.fn()} t={t as never} timelineId="tl-1" />,
    )
    expect((container.querySelector('[data-clip-rename]') as HTMLInputElement).value).toBe('')
  })
})
