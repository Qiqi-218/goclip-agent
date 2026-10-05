// @vitest-environment jsdom
/**
 * Dragging a division actually changes the layout.
 *
 * The store's own spec covers the bounds; this one covers the wire between the divider and the
 * store, which is where the two plausible mistakes live:
 *
 * - **A drag that reports movement instead of position.** Accumulating deltas lets the clamp at one
 *   end swallow movement that is then never given back, so dragging past a limit and back leaves
 *   the column short of where the hand is. The cases below drag past a limit and back and assert
 *   the column returns to where the pointer actually is.
 * - **A key press that is read as a position.** Arrow keys have no pointer position, so a divider
 *   that funnels both through one number jumps the column to 10 pixels on the first press.
 */
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { WorkbenchPanel } from '../src/client/WorkbenchPanel.tsx'
import type {} from '../src/client/index.ts'
import { createWorkbenchLayoutStore, DEFAULT_LAYOUT, LAYOUT_LIMITS, type LayoutState } from '../src/client/layout-store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** The stage's box, which the drag math resolves pointer positions against. */
const STAGE = { left: 300, right: 1300, top: 100, bottom: 700 }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  })
  /*
   * jsdom 不做布局，`getBoundingClientRect` 全返回 0，而拖动换算全靠它。
   *
   * 舞台按**结构**认出来：它是那个装着分隔条的容器。给产品代码加一个测试用的属性会省事，
   * 但那等于把测试的方便塞进产品，所以这里宁可多写一行。
   */
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isStage = this.querySelector(':scope > [data-divider]') !== null
    const box = isStage ? STAGE : { left: 0, right: 0, top: 0, bottom: 0 }
    return {
      ...box,
      width: box.right - box.left,
      height: box.bottom - box.top,
      x: box.left,
      y: box.top,
      toJSON: () => box,
    } as DOMRect
  })
  // 面板从这几个地址读五个维度；这个 spec 只关心布局，给一个空应答即可。
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 404 })))
})

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

/** The panel does not read the global session/workspace seats; keep those framework props inert. */
const unusedHook = (() => { throw new Error('布局测试不应读取全局席位') }) as never

/**
 * Render the panel against a real layout store.
 * @param asset - the asset to open, or null for the empty state.
 * @returns the render result and the store.
 */
function renderPanel(asset: { projectId: string, assetId: string } | null) {
  const store = createWorkbenchLayoutStore().create()
  const useStore = ((selector: (state: LayoutState) => unknown) =>
    useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))) as never
  const result = render(
    <WorkbenchPanel
      actions={store.actions} asset={asset} t={t as never} useStore={useStore}
      usePanelInfo={unusedHook} useSessions={unusedHook} useSessionStatus={unusedHook}
      useSessionRetainInfo={unusedHook} useWorkspaces={unusedHook} useResource={unusedHook}
    />,
  )
  return { ...result, store }
}

/**
 * Find one divider by its axis.
 * @param container - the rendered tree.
 * @param axis - `row` for the columns, `column` for the timeline.
 * @returns the separator element.
 */
function divider(container: HTMLElement, axis: 'row' | 'column'): HTMLElement {
  const found = container.querySelector(`[data-divider="${axis}"]`)
  if (found === null) throw new Error(`没有 ${axis} 分界线`)
  return found as HTMLElement
}

/**
 * Press a divider and move the pointer, as a browser would.
 *
 * The move listener is installed on the window, so the event has to be dispatched there rather than
 * on the element — firing it on the divider would test a path the browser never takes.
 *
 * @param element - the divider to press.
 * @param to - client coordinates to move to.
 * @param axis - which coordinate matters.
 */
function dragTo(element: HTMLElement, to: number, axis: 'row' | 'column'): void {
  fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
  fireEvent.pointerMove(window, axis === 'row' ? { pointerId: 1, clientX: to } : { pointerId: 1, clientY: to })
  fireEvent.pointerUp(window, { pointerId: 1 })
}

const ASSET = { projectId: 'proj', assetId: 'asset' }

describe('the divisions the surface offers', () => {
  it('offers one divider between the columns and one above the timeline', () => {
    const { container } = renderPanel(ASSET)
    expect(container.querySelectorAll('[data-divider="row"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-divider="column"]')).toHaveLength(1)
  })

  it('labels each divider, so it is reachable without a pointer', () => {
    // 一条只能拖的分界线对键盘与读屏用户等于不存在。
    const { container } = renderPanel(ASSET)
    for (const node of container.querySelectorAll('[data-divider]')) {
      expect(node.getAttribute('aria-label')).toBeTruthy()
      expect(node.getAttribute('tabindex')).toBe('0')
    }
  })

  it('puts the two column dividers the right way round', () => {
    const { container } = renderPanel(ASSET)
    const rows = [...container.querySelectorAll('[data-divider="row"]')]
    expect(rows[0]?.getAttribute('aria-label')).toBe(zh['layout.leftSplit'])
    expect(rows[1]?.getAttribute('aria-label')).toBe(zh['layout.rightSplit'])
  })
})

describe('dragging a column divider', () => {
  it('sets the column width from where the pointer is, not from how far it moved', () => {
    const { container, store } = renderPanel(ASSET)
    // 舞台左缘在 300；指针停在 500 就是「左栏 200 宽」。
    dragTo(divider(container, 'row'), 500, 'row')
    expect(store.getSnapshot().leftWidth).toBe(200)
  })

  it('follows the pointer back after being dragged past its limit', () => {
    // 累加位移的写法在这里会出错：拖过上限再拖回来，夹取吞掉的那段位移不会被还回来，
    // 于是栏目停在离手差一截的地方。按位置解就不会。
    const { container, store } = renderPanel(ASSET)
    const handle = divider(container, 'row')
    dragTo(handle, 60, 'row')
    expect(store.getSnapshot().leftWidth).toBe(LAYOUT_LIMITS.leftWidth.min)
    dragTo(handle, 560, 'row')
    expect(store.getSnapshot().leftWidth).toBe(260)
  })

  it('resizes the right column from its own edge', () => {
    const { container, store } = renderPanel(ASSET)
    // 舞台右缘在 1300；指针停在 1050 就是「右栏 250 宽」。
    dragTo(divider(container, 'row'), 500, 'row')
    dragTo([...container.querySelectorAll('[data-divider="row"]')][1] as HTMLElement, 1050, 'row')
    expect(store.getSnapshot().rightWidth).toBe(250)
  })

  it('never squeezes the picture out of the middle', () => {
    /*
     * 舞台从 300 到 1300，宽 1000。
     *
     * 左栏自身的上限是 420，比「让出中间之后剩下的 1000 − 240 − 260 = 500」还小 ——
     * 所以直接把左栏拖到底只会撞到它自己的上限 420，**中心那条约束根本没被走到**。
     * （第一版就是这么写的：断言 500 却得到 420，说明用例没测到它声称要测的东西。）
     * 要走到中心约束，得先把右栏加宽到让剩余空间小于 420。
     */
    const { container, store } = renderPanel(ASSET)
    dragTo([...container.querySelectorAll('[data-divider="row"]')][1] as HTMLElement, 600, 'row')
    expect(store.getSnapshot().rightWidth).toBe(460)
    // 此时剩下 1000 − 460 − 260 = 280，小于左栏自己的上限 420。
    dragTo(divider(container, 'row'), 1280, 'row')
    expect(store.getSnapshot().leftWidth).toBe(280)
  })

  it('ignores a drag that is not the primary button', () => {
    const { container, store } = renderPanel(ASSET)
    fireEvent.pointerDown(divider(container, 'row'), { button: 2, pointerId: 1 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700 })
    expect(store.getSnapshot().leftWidth).toBe(DEFAULT_LAYOUT.leftWidth)
  })
})

describe('dragging the timeline divider', () => {
  it('sets the timeline height from the pointer position', () => {
    const { container, store } = renderPanel(ASSET)
    // 往下拖是让时间线**变矮**：缝就是时间线的上缘，把它往下拉就是从下面拿走空间。
    const before = store.getSnapshot().lowerHeight
    fireEvent.pointerDown(divider(container, 'column'), { button: 0, pointerId: 1, clientY: 400 })
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 460 })
    expect(store.getSnapshot().lowerHeight).toBe(before - 60)
    // 反过来往上拖是变高。
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 340 })
    expect(store.getSnapshot().lowerHeight).toBe(before + 60)
    fireEvent.pointerUp(window, { pointerId: 1 })
  })
})

describe('moving a division without a pointer', () => {
  it('steps by a fixed amount for an arrow key', () => {
    // 把按键也当成「位置」会让第一下就把栏目跳到 10 像素。
    const { container, store } = renderPanel(ASSET)
    fireEvent.keyDown(divider(container, 'row'), { key: 'ArrowRight' })
    expect(store.getSnapshot().leftWidth).toBe(DEFAULT_LAYOUT.leftWidth + 10)
    fireEvent.keyDown(divider(container, 'row'), { key: 'ArrowLeft' })
    expect(store.getSnapshot().leftWidth).toBe(DEFAULT_LAYOUT.leftWidth)
  })

  it('steps further with shift held', () => {
    const { container, store } = renderPanel(ASSET)
    fireEvent.keyDown(divider(container, 'row'), { key: 'ArrowRight', shiftKey: true })
    expect(store.getSnapshot().leftWidth).toBe(DEFAULT_LAYOUT.leftWidth + 40)
  })

  it('ignores keys that do not move this axis', () => {
    const { container, store } = renderPanel(ASSET)
    fireEvent.keyDown(divider(container, 'row'), { key: 'ArrowDown' })
    expect(store.getSnapshot().leftWidth).toBe(DEFAULT_LAYOUT.leftWidth)
  })
})

describe('putting a division back', () => {
  it('restores the default on a double click', () => {
    const { container, store } = renderPanel(ASSET)
    dragTo(divider(container, 'row'), 560, 'row')
    expect(store.getSnapshot().leftWidth).not.toBe(DEFAULT_LAYOUT.leftWidth)
    fireEvent.doubleClick(divider(container, 'row'))
    expect(store.getSnapshot().leftWidth).toBe(DEFAULT_LAYOUT.leftWidth)
  })
})
