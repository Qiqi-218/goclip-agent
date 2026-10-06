/**
 * The plugin's wiring, and its removal when the plugin goes.
 *
 * The registry and the navigation controller are real, because "provided"
 * means what those faces do; the slot, locale, frame, and resource faces are
 * recorders, because what matters here is what was handed to them — two seats
 * over one store, the guide's body under its own id, the frame reports, the
 * on-screen Session — and that every registration is gone after dispose, which
 * is what makes a reload safe. The seats' components have their own specs.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Shortcuts, ShortcutCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import { apply, inject } from '../src/client/index.ts'
import type { GuideInjected } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { SidebarRightController } from '../src/client/service.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import { ExpandButton } from '../src/client/shell/ExpandButton.tsx'
import { GuideBody } from '../src/client/tabs/guide/GuideBody.tsx'
import { GuideTitle } from '../src/client/tabs/guide/GuideTitle.tsx'
import { GUIDE_ID } from '../src/client/tabs/guide/definition.ts'
import { en, zh } from '../src/client/locales.ts'

const SHORTCUT_CATALOG: readonly never[] = []

const SESSION = 's-test' as SessionId

interface Recorded {
  name: string
  key?: string
  locale?: string
  store?: unknown
  children?: unknown
  inject?: (sessionId: SessionId) => unknown
  component: unknown
}

async function boot(shortcuts: Partial<Shortcuts> = {}) {
  const ctx = new Context()
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: Parameters<SlotRegistry['inject']>[1]) => ctx.effect(register)),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    // Copy is the dictionary's contract; the key stands in for the translation.
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const layout = {
    openRightbar: vi.fn(), closeRightbar: vi.fn(),
    panelInfo: createSnapshotStore<{ activePanelId: string | null }>({ activePanelId: null }),
  }
  const current = createSnapshotStore<{ key: SessionId | undefined }>({ key: undefined })
  const resources = { pin: vi.fn<(address: string, signal: AbortSignal) => void>() }
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('shortcuts', { runtime: 'web', register: () => () => {},
    catalog: { getSnapshot: () => SHORTCUT_CATALOG, subscribe: () => () => {} }, ...shortcuts } as never)
  ctx.provide('layout', layout as never)
  ctx.provide('resources', resources as never)
  ctx.provide('sessions', { retain: vi.fn(() => ({ ready: Promise.resolve(), release: vi.fn() })) } as never)
  ctx.provide('uiSession', { adapter: { current } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const seat = (name: string): Recorded => {
    const entry = registered.find(candidate => candidate.name === name)
    if (entry === undefined) throw new Error(`expected a registration into ${name}`)
    return entry
  }
  const injectedOf = (entry: Recorded): unknown => {
    if (entry.inject === undefined) throw new Error(`expected ${entry.name} to inject`)
    return entry.inject(SESSION)
  }
  return { ctx, registered, dictionaries, layout, current, resources, fiber, seat, injectedOf }
}

describe('ui-sidebar-right apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('routes native close through the shortcut service and contains bridge rejections', async () => {
    onTestFinished(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
    const closeWindow = vi.fn<() => Promise<void>>().mockResolvedValue()
    const commands = new Map<string, ShortcutCommand>()
    const h = await boot({ runtime: 'desktop',
      closeWindow,
      register: (command) => { commands.set(command.id, command); return () => { commands.delete(command.id) } },
    })
    onTestFinished(async () => { await h.ctx.fiber.dispose() })
    const close = commands.get('page.close')!.resolve({ region: 'page', modal: null, target: null })
    expect(close.status).toBe('handled')
    if (close.status !== 'handled') throw new Error('Expected native close')
    close.run()
    expect(closeWindow).toHaveBeenCalledExactlyOnceWith()
    const failure = new Error('Window unavailable')
    closeWindow.mockRejectedValueOnce(failure)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    close.run()
    await vi.waitFor(() => { expect(error).toHaveBeenCalledExactlyOnceWith('Window close failed', failure) })
  })

  it('provides both faces, and registers the guide through the same two-stage path as any other type', async () => {
    const { ctx, registered, dictionaries } = await boot()
    expect(ctx.sidebarRightTabs).toBeInstanceOf(SidebarRightTabRegistry)
    expect(ctx.sidebarRight).toBeInstanceOf(SidebarRightController)
    expect('adopt' in ctx.sidebarRight).toBe(false)
    expect(dictionaries.get('sidebarRight')).toEqual({ zh, en })
    const guide = ctx.sidebarRightTabs.get('guide')
    expect(guide?.id).toBe(GUIDE_ID)
    expect(guide?.priority).toBe('builtin')
    expect(guide?.title('sidebar://guide')).toBe('tab.guide.title')
    /*
     * Three registrations: the header's corner seat, and the guide's body and chip title under the
     * guide implementation's id. The root and panel seats used to be here and are gone — the workbench
     * registers the root `rightbar`, and the legacy detail surface is no longer mounted, so asserting
     * them would assert registrations the plugin deliberately stopped making.
     *
     * The guide draws no product copy of its own, so neither guide seat binds the dictionary.
     */
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['conversation.session.header.corner', undefined, 'sidebarRight', ExpandButton],
      ['sidebar.right.pane.tab', GUIDE_ID, undefined, GuideBody],
      ['sidebar.right.pane.tab.title', GUIDE_ID, undefined, GuideTitle],
    ])
    // The guide declares its own chain child, which is the one declaration left on this path.
    expect(registered.find(entry => entry.name === 'sidebar.right.pane.tab')?.children)
      .toMatchObject({ 'sidebar.right.tab.guide': { kind: 'chain', scope: 'session' } })
  })

  it('names the selected Session as on screen while the Conversation fills the main column', async () => {
    const { ctx, layout, current } = await boot()
    expect(ctx.sidebarRight.mounted.getSnapshot()).toBeUndefined()
    current.set({ key: SESSION })
    expect(ctx.sidebarRight.mounted.getSnapshot()).toBe(SESSION)
    layout.panelInfo.set({ activePanelId: 'plugins' })
    expect(ctx.sidebarRight.mounted.getSnapshot()).toBeUndefined()
    layout.panelInfo.set({ activePanelId: null })
    expect(ctx.sidebarRight.mounted.getSnapshot()).toBe(SESSION)
    current.set({ key: undefined })
    expect(ctx.sidebarRight.mounted.getSnapshot()).toBeUndefined()
  })

  it('hands the guide body the registry\'s entry boxes, observable', async () => {
    const { ctx, seat, injectedOf } = await boot()
    const { hooks: { guideEntries } } = injectedOf(seat('sidebar.right.pane.tab')) as GuideInjected
    expect(guideEntries.getSnapshot()).toEqual([])
    const seen = vi.fn()
    guideEntries.subscribe(seen)
    ctx.sidebarRightTabs.register({
      id: 'spec/files',
      kind: 'files',
      title: () => 'Files',
      guide: [{ id: 'default', order: 10, title: () => 'Files' }],
    })
    expect(seen).toHaveBeenCalledOnce()
    expect(guideEntries.getSnapshot().map(entry => entry.kind)).toEqual(['files'])
  })

})
