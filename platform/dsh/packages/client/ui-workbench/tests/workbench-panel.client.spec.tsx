import { useSyncExternalStore } from 'react'
// @vitest-environment jsdom
/**
 * The workbench surface: what it shows, the asset it chooses, and the loop between the surface
 * and the player.
 *
 * The layout assertions are about the shape an editor needs rather than about columns: the
 * picture takes the leftover width, the timeline runs beneath the whole thing, and the clip list
 * and film list sit at the edges. That ordering is what the previous equal-split layout got
 * wrong, so it is what these tests hold.
 *
 * The address contract is what lets a link open the workbench on an asset at all, since the
 * slot's owner passes no props.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { WorkbenchPanel } from '../src/client/WorkbenchPanel.tsx'
import type {} from '../src/client/index.ts'
import { createWorkbenchLayoutStore, type LayoutState } from '../src/client/layout-store.ts'
import { assetFromAddress, mediaUrl } from '../src/client/read.ts'
import { en, zh } from '../src/client/locales.ts'

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 })
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

type Dict = typeof zh

/** The panel does not read the global session/workspace seats; keep those framework props inert. */
const unusedHook = (() => { throw new Error('工作台测试不应读取全局席位') }) as never

/**
 * Render the panel with one dictionary and an optional asset.
 * @param dict - the dictionary to answer keys with.
 * @param asset - the asset to show, or null for the unselected state.
 * @returns the testing-library render result.
 */
function renderPanel(dict: Dict = zh, asset: { projectId: string, assetId: string } | null = null) {
  const t = (key: keyof Dict, params?: Record<string, unknown>): string => {
    const template = dict[key]
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }
  /*
   * store 用真实的那个，不用替身：这个 spec 要断言的正是「拖出来的尺寸真的改变了布局」，
   * 替身只能证明「有人被调用」。`create()` 是测试里被允许的那条零机器路径。
   *
   * `useStore` 在框架里由渲染器在绑定处合成（`observableHook(store)`），所以这里也照
   * 契约自己接一次：读 `getSnapshot`、订阅 `subscribe`。用 `useSyncExternalStore` 而不是
   * `useState`，因为拖动的每一次移动都要立刻反映出来。
   */
  const store = createWorkbenchLayoutStore().create()
  const useStore = ((selector: (state: LayoutState) => unknown) =>
    useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))) as never
  return render(
    <WorkbenchPanel
      actions={store.actions} asset={asset} t={t as never} useStore={useStore}
      usePanelInfo={unusedHook} useSessions={unusedHook} useSessionStatus={unusedHook}
      useSessionRetainInfo={unusedHook} useWorkspaces={unusedHook} useResource={unusedHook}
    />,
  )
}

/** One measurement, shaped as the route serialises it. */
const CURVE = {
  duration_us: 60_000_000,
  samples: [{ at: 0, db: -30 }, { at: 0.5, db: -10 }, { at: 1, db: -20 }],
  floor_dbfs: -30,
  peak_dbfs: -10,
  loud_dbfs: -20,
  audio_end_at: 1,
}

/** Two clips, shaped as the route serialises them. */
const TIMELINES = {
  duration_us: 60_000_000,
  timelines: [{
    id: 'tl-1',
    name: '初剪',
    revision: 2,
    clips: [
      // 一段有名字、一段没有：界面要能区分「人给它起了名」与「它就是第 N 段」，
      // 两段都写 null 的话那条区分就没有任何断言走到。
      { ordinal: 0, start_us: 0, end_us: 10_000_000, start: 0, end: 1 / 6, speed: 1, muted: false, name: '开场' },
      { ordinal: 1, start_us: 30_000_000, end_us: 45_000_000, start: 0.5, end: 0.75, speed: 2, muted: true, name: null },
    ],
    output_seconds: 17.5,
  }],
}

/** One finished film, shaped as the route serialises it. */
const RENDERS = {
  renders: [{ job_id: 'job-abcdef123', status: 'done', timeline_id: 'tl-1', timeline_name: '初剪', url: '/goclip-media/proj/asset/render/job-abcdef123' }],
}

/** Measured evidence, shaped as the host normalises it: two tracks, two tracks absent. */
const EVIDENCE = {
  duration_us: 60_000_000,
  tracks: {
    transcript: [{ start_us: 0, end_us: 5_000_000, text: '第一句' }],
    // 章节与高光都给：两者来自同一份分析片段，而界面要分别列出它们的开关。
    // 夹具只给高光时，「面板会不会把章节也列出来」这件事就没有被走到。
    chapters: [{ start_us: 0, end_us: 8_000_000, summary: '开场与塔', is_highlight: false }],
    highlights: [{ start_us: 2_000_000, end_us: 6_000_000, reason: '画面最好的一段', confidence: 0.8 }],
  },
}

/** Recorded revisions, shaped as the host reports them: newest first. */
const HISTORY = {
  timeline_id: 'tl-1',
  entries: [
    { revision: 2, segment_count: 2, note: '追加一段', at: 1_700_000_000_000 },
    { revision: 1, segment_count: 1, note: '创建', at: 1_699_999_000_000 },
  ],
  note: null,
}

/**
 * Answer the reads by the dimension each address names.
 *
 * Routing by URL rather than answering everything with one body matters here: the panel reads five
 * dimensions whose payloads have nothing in common, so a single-payload stub hands the revision
 * reader a loudness curve — and the assertion then fails because the component choked on a payload
 * shaped like something else, not because the behaviour under test is wrong.
 *
 * History is recognised by its extra path segment, since the dimension is still the last one.
 *
 * @param overrides - per-dimension bodies or statuses to use instead of the defaults.
 */
function stubReads(overrides: Partial<Record<'loudness' | 'timelines' | 'renders' | 'evidence' | 'history', { body?: unknown, status?: number }>> = {}): void {
  const defaults = {
    loudness: { body: CURVE, status: 200 },
    timelines: { body: TIMELINES, status: 200 },
    renders: { body: RENDERS, status: 200 },
    evidence: { body: EVIDENCE, status: 200 },
    history: { body: HISTORY, status: 200 },
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    // `/history` 前面多一段时间线 id，所以不能只按后缀认。
    const dimension = (['loudness', 'timelines', 'renders', 'evidence', 'history'] as const)
      .find(name => url.endsWith(`/${name}`)) ?? 'loudness'
    const answer = overrides[dimension] ?? defaults[dimension]
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
}

describe('workbench layout', () => {
  it('gives the picture the leftover width, with the lists at the edges', () => {
    stubReads()
    // 布局只在有素材时才画出来；未选中素材时只给那句说明。
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    const areas = [...container.querySelectorAll('[data-area]')].map(node => node.getAttribute('data-area'))
    // 顺序是「片段 · 画面 · 成片」，画面在中间那一档并吃掉剩余宽度。
    expect(areas).toEqual(['clips', 'viewer', 'output', 'timeline'])
  })

  it('explains itself instead of drawing the surface when no asset is named', () => {
    const { container, getByText } = renderPanel()
    expect(container.querySelector('[data-workbench-empty]')).not.toBeNull()
    expect(container.querySelector('[data-area]')).toBeNull()
    expect(getByText(zh['source.none'])).toBeDefined()
  })

  it('renders the headings in the active language', () => {
    stubReads()
    const { container, getByText } = renderPanel(en, { projectId: 'proj', assetId: 'asset' })
    // 「Picture」在片段列标题和时间线轨道名上各出现一次，所以按区域断言而不是按文本。
    expect(container.querySelector('[data-area="clips"] h2')?.textContent).toBe('Picture')
    // 成片只有一处，用文本断言即可。
    expect(getByText('Output')).toBeDefined()
  })

  it('renders the timeline beside the picture rather than only the clip list', async () => {
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelectorAll('[data-list-clip]')).toHaveLength(2))
    // 面板这一层只需要保证时间线被挂上；片段怎么画、怎么拖由 Timeline 自己的 spec 守。
    expect(container.querySelector('[data-timeline]')).not.toBeNull()
    expect(container.querySelector('[data-zoom-range]')).not.toBeNull()
  })
})

describe('workbench reads one asset', () => {
  it('plays the asset through the read-only route, not an object-store address', () => {
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    const video = container.querySelector('video')
    expect(video?.getAttribute('src')).toBe('/goclip-media/proj/asset')
    expect(video?.getAttribute('src')).not.toContain('OSSAccessKeyId')
  })

  it('lists the clips once the read answers', async () => {
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelectorAll('[data-list-clip]')).toHaveLength(2))
  })

  it('says the dimension is missing rather than drawing an empty curve', async () => {
    stubReads({ loudness: { status: 404 } })
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelector('[data-level]')).toBeNull())
    // 提示里点出是哪条素材，否则用户不知道该去算哪一条。
    expect(container.textContent).toContain('asset')
    expect(container.textContent).toContain('proj')
  })

  it('moves the playhead when a clip is chosen from the list', async () => {
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelectorAll('[data-list-clip]')).toHaveLength(2))
    const video = container.querySelector('video') as HTMLVideoElement
    // 第 2 段在原片 30 秒处开始。
    fireEvent.click(container.querySelectorAll('[data-list-clip]')[1] as Element)
    await waitFor(() => expect(video.currentTime).toBeCloseTo(30, 3))
  })

  it('plays every finished film from the read-only route', async () => {
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelector('[data-render]')).not.toBeNull())
    // 第一个 video 是素材播放器，第二个是成片。
    const rendered = [...container.querySelectorAll('video')][1]
    expect(rendered?.getAttribute('src')).toBe('/goclip-media/proj/asset/render/job-abcdef123')
    expect(rendered?.getAttribute('src')).not.toContain('OSSAccessKeyId')
  })

  it('keeps the picture and the timeline when the other dimensions are empty', async () => {
    stubReads({ timelines: { status: 404 }, renders: { status: 404 } })
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelector('[data-output="none"]')).not.toBeNull())
    // 三个维度各读各的：一条缺失不该把画面或时间轴一起带走。
    expect(container.querySelector('video')).not.toBeNull()
    expect(container.querySelector('[data-timeline]')).not.toBeNull()
  })
})

describe('address parsing', () => {
  it('reads a project and asset from the fragment', () => {
    expect(assetFromAddress('#project=proj&asset=asset', '')).toEqual({ projectId: 'proj', assetId: 'asset' })
  })

  it('accepts a fragment without its leading mark', () => {
    expect(assetFromAddress('project=proj&asset=asset', '')).toEqual({ projectId: 'proj', assetId: 'asset' })
  })

  it('prefers the fragment over the query string when both name one', () => {
    // 片段是那条能活过 303 重定向的通道，所以它说了算。
    expect(assetFromAddress('#project=from-hash&asset=a', '?project=from-query&asset=b'))
      .toEqual({ projectId: 'from-hash', assetId: 'a' })
  })

  it('falls back to the query string when the fragment names none', () => {
    expect(assetFromAddress('', '?project=proj&asset=asset')).toEqual({ projectId: 'proj', assetId: 'asset' })
  })

  it('returns null when neither names a complete pair', () => {
    expect(assetFromAddress('', '')).toBeNull()
    expect(assetFromAddress('#project=proj', '')).toBeNull()
    expect(assetFromAddress('#asset=asset', '')).toBeNull()
    expect(assetFromAddress('#project=&asset=asset', '')).toBeNull()
  })

  it('addresses the route for the pair it is given', () => {
    expect(mediaUrl({ projectId: 'a b', assetId: 'c/d' })).toBe('/goclip-media/a%20b/c%2Fd')
  })
})

describe('a render that failed', () => {
  /** One attempt that died during the burn, with the steps it got through. */
  const FAILED = {
    renders: [
      {
        job_id: 'job-failed0001',
        status: 'failed',
        timeline_id: 'tl-1',
        timeline_name: '初剪',
        url: null,
        note: 'ffmpeg exited 1',
        failed_stage: '烧录字幕',
        stages: [
          { stage: '切割', ms: 120, outcome: 'ok' },
          { stage: '拼接', ms: 40, outcome: 'ok' },
          { stage: '烧录字幕', ms: 30, outcome: 'failed', reason: 'ffmpeg exited 1' },
        ],
      },
    ],
  }

  it('is listed at all, rather than reported as no films', async () => {
    // 失败的任务曾被过滤掉，理由是「没有产物就没有可播的东西」。那对播放器成立，对人不成立：
    // 一次烧录中崩掉的渲染正是需要看见的东西，而列表漏掉它会把「渲染过三次」报成「没有成片」。
    stubReads({ renders: { body: FAILED } })
    const { container, getByText } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    // 读取是异步的：不等它落定就会断言到一个还在「没有成片」状态的界面。
    await waitFor(() => expect(container.querySelector('[data-render-failed]')).not.toBeNull())
    expect(getByText('这次渲染失败了。')).toBeTruthy()
    expect(container.querySelector('[data-output="none"]')).toBeNull()
  })

  it('names the step it died at', async () => {
    // 「在哪一步失败」是这一栏唯一能据以行动的信息：下载失败与烧录失败要做的事完全不同。
    stubReads({ renders: { body: FAILED } })
    const { getByText } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(getByText('死在「烧录字幕」这一步。')).toBeTruthy())
  })

  it('offers the steps that ran, with the failed one marked', async () => {
    stubReads({ renders: { body: FAILED } })
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelectorAll('[data-render-stage-row]')).toHaveLength(3))
    const rows = [...container.querySelectorAll('[data-render-stage-row]')]
    expect(rows.map(row => row.getAttribute('data-render-stage-row'))).toEqual(['切割', '拼接', '烧录字幕'])
    expect(container.querySelector('[data-render-stage-outcome="failed"]')?.getAttribute('data-render-stage-row')).toBe('烧录字幕')
  })

  it('does not list a film for an attempt with nothing to play', async () => {
    stubReads({ renders: { body: FAILED } })
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelectorAll('[data-render]')).toHaveLength(1))
    // 失败的那一次没有可播的东西，所以不该在**成片列里**出现一个空的播放器。
    // 断言限定在成片列内：面板中央那个预览播放器一直都在，按整页查 video 会查到它 ——
    // 第一版就是这么写的，于是断言测的是「面板有没有预览器」，而不是「失败项有没有播放器」。
    expect(container.querySelector('[data-area="output"] video')).toBeNull()
    expect(container.querySelectorAll('[data-render]')).toHaveLength(1)
  })
})
describe('naming and reordering a clip', () => {
  it('shows the name a person gave a clip, and shows nothing for one they did not', async () => {
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelectorAll('[data-list-clip]')).toHaveLength(2))
    // 名字是这一段「是什么」，序号只是它在哪儿；两者都要在，但只有起过名的那段有名字。
    expect(container.querySelector('[data-clip-name="0"]')?.textContent).toBe('开场')
    expect(container.querySelector('[data-clip-name="1"]')).toBeNull()
  })

  it('gives the action bar no clip to act on until one is selected', async () => {
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelectorAll('[data-list-clip]')).toHaveLength(2))
    // 这一层只保证动作条在、且没选中时不给控件。「选中之后给什么」由 ClipActions 自己的 spec
    // 覆盖 —— 片段块是编辑器库画的，而在这一层库被替身掉了，根本点不到。
    expect(container.querySelector('[data-clip-actions]')).not.toBeNull()
    expect(container.querySelector('[data-clip-rename]')).toBeNull()
  })
})
describe('the subtitle preview', () => {
  it('is off until somebody turns it on, and draws nothing while it is off', async () => {
    // 它覆盖在画面上，而画面的主要用途是看素材；默认打开会让每次播放都多一层文字。
    // 开着它是一次明确的选择，所以「默认关」本身就是要守的行为。
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelectorAll('[data-list-clip]')).toHaveLength(2))
    expect(container.querySelector('[data-subtitle-preview-toggle]')).not.toBeNull()
    expect(container.querySelector('[data-subtitle-overlay]')).toBeNull()
    expect(container.querySelector('[data-subtitle-stage]')).toBeNull()
  })

  it('offers a chapter track and a subtitle preview as separate controls', async () => {
    // 两者作用不同：一个改时间线上画什么，一个只改画面上多不多一层文字。
    // 混在一组里会让人以为字幕预览也会改时间线。
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelectorAll('[data-lane-toggle]').length).toBeGreaterThan(0))
    const toggles = [...container.querySelectorAll('[data-lane-toggle]')].map(node => node.getAttribute('data-lane-toggle'))
    expect(toggles).toContain('chapters')
    expect(toggles).not.toContain('subtitle.preview')
    expect(container.querySelector('[data-subtitle-preview-toggle]')).not.toBeNull()
  })
})
describe('keyboard shortcuts', () => {
  /**
   * Press a key on an element inside the panel.
   * @param container - the rendered tree.
   * @param init - the keyboard event's fields.
   */
  function press(container: HTMLElement, init: KeyboardEventInit): void {
    /*
     * 派发在面板**内部的真实控件**上，而不是容器本身。
     *
     * 真实事件里 `event.target` 是被聚焦的那个元素；派发在容器上会让 target 变成容器，
     * 而处理器只处理元素节点 —— 于是测出来的是「事件没到」而不是快捷键的行为。
     */
    const target = container.querySelector('[data-shortcut-anchor]')
      ?? container.querySelector('button')
      ?? container
    fireEvent.keyDown(target, init)
  }

  /**
   * Select the first clip, which every clip shortcut needs.
   *
   * The wait is for the **clip rows**, not for the action bar: the bar is in the tree from the first
   * render, so waiting on it returns immediately and the click then lands on nothing — which is how
   * this helper first failed, and it looked exactly like "the shortcut does not work".
   */
  async function selectFirst(container: HTMLElement): Promise<void> {
    await waitFor(() => expect(container.querySelectorAll('[data-list-clip]').length).toBeGreaterThan(0))
    fireEvent.click(container.querySelector('[data-list-clip="0"]') as Element)
  }

  it('copies the selected clip and pastes it as a new clip at the end', async () => {
    /*
     * 粘贴在宿主这里是**追加**：`video_timeline_add` 就是追加。
     * 声称「插入到某个位置」需要 add + reorder 两次调用，而第二次的序号要等第一次落地才知道 ——
     * 那属于掌握对话的 Agent，不属于一个快捷键。
     */
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await selectFirst(container)
    press(container, { key: 'c', ctrlKey: true })
    press(container, { key: 'v', ctrlKey: true })
    // 面板把提出的调用显示出来，而不是自己写数据。
    await waitFor(() => expect(container.querySelector('[data-pending-edit]')).not.toBeNull())
    expect(container.querySelector('[data-pending-edit]')?.textContent).toContain('video_timeline_add')
  })

  it('cuts by removing the clip as well as remembering it', async () => {
    // 剪切 = 复制 + 删除。只复制不删就只是复制，那是另一个快捷键。
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await selectFirst(container)
    press(container, { key: 'x', ctrlKey: true })
    await waitFor(() => expect(container.querySelector('[data-pending-edit]')).not.toBeNull())
    expect(container.querySelector('[data-pending-edit]')?.textContent).toContain('video_timeline_remove')
  })

  it('duplicates the selected clip without touching the clipboard', async () => {
    // Ctrl+D 用的是选中的那一段，不是剪贴板 —— 否则它会悄悄粘贴一段更早复制的东西。
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await selectFirst(container)
    press(container, { key: 'd', ctrlKey: true })
    await waitFor(() => expect(container.querySelector('[data-pending-edit]')).not.toBeNull())
    expect(container.querySelector('[data-pending-edit]')?.textContent).toContain('video_timeline_add')
  })

  it('does nothing when no clip is selected', async () => {
    // 没有选中时按复制，复制的是「什么都没有」；不该产生任何调用。
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelectorAll('[data-list-clip]')).toHaveLength(2))
    press(container, { key: 'c', ctrlKey: true })
    press(container, { key: 'v', ctrlKey: true })
    expect(container.querySelector('[data-pending-edit]')).toBeNull()
  })

  it('leaves the keys alone while a field has focus', async () => {
    /*
     * 这一条最要紧：给片段改名时打字，若快捷键还在监听，敲一个 c 就会去复制、
     * 敲 v 就会去粘贴 —— 打字变成了改时间线。
     */
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await selectFirst(container)
    const field = container.querySelector('[data-clip-rename]') as HTMLInputElement
    fireEvent.keyDown(field, { key: 'c', ctrlKey: true })
    fireEvent.keyDown(field, { key: 'v', ctrlKey: true })
    expect(container.querySelector('[data-pending-edit]')).toBeNull()
  })

  it('leaves the keys alone outside the panel', async () => {
    // 工作台是对话旁边的**一个**界面；在输入框里打字却删掉一个片段，是不能接受的。
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await selectFirst(container)
    const outside = document.createElement('div')
    document.body.append(outside)
    fireEvent.keyDown(outside, { key: 'x', ctrlKey: true })
    expect(container.querySelector('[data-pending-edit]')).toBeNull()
  })

  it('clears the selection on escape', async () => {
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await selectFirst(container)
    expect(container.querySelector('[data-clip-actions-for]')).not.toBeNull()
    press(container, { key: 'Escape' })
    await waitFor(() => expect(container.querySelector('[data-clip-actions-for]')).toBeNull())
    expect(container.querySelector('[data-clip-actions-hint]')).not.toBeNull()
  })

  it('names the shortcuts somewhere a person can find them', async () => {
    // 没有提示的快捷键等于不存在。这一行本来就空着，所以它不占新的高度。
    stubReads()
    const { container } = renderPanel(zh, { projectId: 'proj', assetId: 'asset' })
    await waitFor(() => expect(container.querySelector('[data-shortcuts]')).not.toBeNull())
    expect(container.querySelector('[data-shortcuts]')?.textContent).toContain('Ctrl')
  })
})
