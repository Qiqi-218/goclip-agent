// @vitest-environment jsdom
/**
 * The revision list: which states exist, and what picking one does.
 *
 * An edit you cannot take back is an edit nobody makes, so the cases here are about the two ways
 * this surface could quietly fail to be that: a list that claims there is nothing to go back to,
 * and a click that produces no instruction. Both would look like "undo does not work" rather than
 * like a bug in a list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { RevisionList } from '../src/client/RevisionList.tsx'
import { zh } from '../src/client/locales.ts'
import { revertIntent } from '../src/client/editor-model.ts'

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

/** Two revisions, newest first, as the host reports them. */
const ENTRIES = [
  { revision: 3, segment_count: 4, note: '删掉停顿', at: 1_700_000_060_000 },
  { revision: 2, segment_count: 5, note: '追加一段', at: 1_700_000_000_000 },
  { revision: 1, segment_count: 1, note: '创建', at: 1_699_999_000_000 },
]

/**
 * Render the list.
 * @param overrides - props to replace.
 * @returns the render result plus the restore spy.
 */
function renderList(overrides: Partial<Parameters<typeof RevisionList>[0]> = {}) {
  const onRestore = vi.fn()
  const result = render(
    <RevisionList
      currentRevision={3}
      history={{ status: 'ok', value: { timeline_id: 'tl-1', entries: ENTRIES, note: null } }}
      onRestore={onRestore}
      proposed={null}
      t={t as never}
      {...overrides}
    />,
  )
  return { ...result, onRestore }
}

describe('what the list shows', () => {
  it('lists every recorded revision, newest first', () => {
    const { container } = renderList()
    const revisions = [...container.querySelectorAll('[data-revision]')].map(el => el.getAttribute('data-revision'))
    expect(revisions).toEqual(['3', '2', '1'])
  })

  it('says which one is the present', () => {
    const { container } = renderList()
    expect(container.querySelector('[data-revision="3"]')?.hasAttribute('data-revision-current')).toBe(true)
    expect(container.querySelector('[data-revision="2"]')?.hasAttribute('data-revision-current')).toBe(false)
    expect(container.querySelector('[data-revision-badge]')?.textContent).toBe(zh['revision.current'])
  })

  it('offers what each revision did and how big it was', () => {
    const { container } = renderList()
    const row = container.querySelector('[data-revision="2"]')
    expect(row?.textContent).toContain('追加一段')
    expect(row?.textContent).toContain('5 段')
  })

  it('says so when an edit left no note rather than showing a blank', () => {
    const { container } = renderList({
      history: { status: 'ok', value: { timeline_id: 'tl-1', entries: [{ revision: 1, segment_count: 1, note: null, at: 0 }], note: null } },
      currentRevision: 1,
    })
    // 空白的备注与「这次编辑没记下做了什么」看起来一样，但只有后者是真的。
    expect(container.textContent).toContain(zh['revision.unnamed'])
  })
})

describe('the ways there is nothing to go back to', () => {
  it('distinguishes a timeline with no history from a read that failed', () => {
    // 没有历史说明这是一条刚建的时间线；读不出来说明出了问题。
    // 合成一句话会把故障说成正常，用户就不会去查。
    const { container, unmount } = renderList({ history: { status: 'absent' } })
    expect(container.querySelector('[data-history-absent]')).not.toBeNull()
    unmount()
    const failed = renderList({ history: { status: 'failed' } })
    expect(failed.container.querySelector('[data-history-failed]')).not.toBeNull()
  })

  it('says it is still reading rather than that there is nothing', () => {
    const { container } = renderList({ history: { status: 'loading' } })
    expect(container.querySelector('[data-history-loading]')).not.toBeNull()
    expect(container.querySelector('[data-history]')).toBeNull()
  })

  it('survives a payload shaped like something else', () => {
    // 这个问题读的是网络应答，而网络应答是边界：一个读不懂的应答应当让这张卡片说读不出来，
    // 而不是把整页带走。实测 stub 路由写错时，渲染期抛错会连片段列表一起弄没。
    const { container } = renderList({ history: { status: 'ok', value: { timeline_id: 'tl-1' } as never } })
    expect(container.querySelector('[data-history-empty]')).not.toBeNull()
  })
})

describe('picking a revision', () => {
  it('reports the revision that was picked', () => {
    const { container, onRestore } = renderList()
    fireEvent.click(container.querySelector('[data-revision="1"]') as Element)
    expect(onRestore).toHaveBeenCalledWith(1)
  })

  it('does not offer to return to the revision already on screen', () => {
    // 按下去只会发出一次「回到原地」的编辑，那条编辑什么也不改却会推进版本号。
    const { container, onRestore } = renderList()
    const present = container.querySelector('[data-revision="3"]') as HTMLButtonElement
    expect(present.disabled).toBe(true)
    fireEvent.click(present)
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('marks a revision that has been proposed but not applied', () => {
    const { container } = renderList({ proposed: 2 })
    expect(container.querySelector('[data-revision="2"]')?.hasAttribute('data-revision-proposed')).toBe(true)
    expect(container.querySelector('[data-revision="1"]')?.hasAttribute('data-revision-proposed')).toBe(false)
  })
})

describe('the instruction a restore produces', () => {
  it('carries the revision the person was looking at', () => {
    // base_revision 就是「你看的是哪一版」；少了它，一次和别人并发的回滚会静默丢掉对方的工作。
    expect(revertIntent('tl-1', 5, 2)).toEqual({
      tool: 'video_timeline_revert',
      args: { timeline_id: 'tl-1', base_revision: 5, target_revision: 2 },
    })
  })

  it('is told apart from a trim by its tool name', () => {
    // 两种意图影响的不是同一样东西：裁剪标在某一段上，回滚标在某个版本上。
    // 判别字段存在，调用方才能各按各的读参数。
    expect(revertIntent('tl-1', 5, 2).tool).toBe('video_timeline_revert')
  })
})
