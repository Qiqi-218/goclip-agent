/** Models section registration: slot declaration injection, the locale-following label thunk, and HMR recovery. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'
import { ok, RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, refreshIfLoaded } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'
import { DeepSeekOnboardingDialog } from '../src/client/DeepSeekOnboardingDialog.tsx'
import { WelcomeNotice } from '../src/client/WelcomeNotice.tsx'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as hostPlugin from '../src/index.ts'
import { ONBOARDING_CONFIG_GLOBAL } from '../src/onboarding-config.ts'

afterEach(() => { vi.unstubAllGlobals() })

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

async function bench(isLoopback = true, mock = RemoteMock.create().load(remoteDefaultResponses), services: object = {}) {
  onTestFinished(() => { mock.assertNoUnmatched() })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const remote = new TestRemote(ctx, {
    credentials: {
      describe: vi.fn(() => Promise.resolve({ ok: true, value: {} })),
      set: vi.fn(),
      unset: vi.fn(),
    },
    llm: {
      listProviders: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      listConfigurableProviders: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      discoverModels: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      ...services,
    },
    settings: mock.remote.settings,
    session: { initializeDefaultModel: vi.fn(async () => ({ ok: true, value: undefined })) },
  })
  // The fixed Host facts the settings provider reads its persistence from.
  remote.$host = { home: undefined, isLoopback }
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, remote }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.onboarding': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

describe('ui-settings-models apply', () => {
  it('keeps manual credential onboarding available when the native shell owns automatic onboarding', async () => {
    const { ctx, slots } = await bench()
    declare(slots)
    try {
      const host = ctx.plugin(hostPlugin, { credentialOnboarding: false })
      await host.await()
      const rows: IndexInjection[] = []
      ctx.emit('webserver/index-inject', rows)
      expect(rows).toEqual([{ kind: 'global', name: ONBOARDING_CONFIG_GLOBAL, value: { credentialOnboarding: false } }])
      for (const row of rows) if (row.kind === 'global') vi.stubGlobal(row.name, row.value)
      const plugin = ctx.plugin({ inject: [...inject], apply })
      await plugin.await()
      expect(slots.entries('settings.onboarding').map(entry => entry.options.id)).toEqual(['welcome-notice', 'deepseek-official'])
      const onboarding = slots.entries('settings.onboarding').find(entry => entry.options.id === 'deepseek-official')!
      expect((onboarding.inject as () => { automatic: boolean })().automatic).toBe(false)
      expect(slots.entries('settings.section')).toEqual([])
      await plugin.dispose()
      expect(slots.entries('settings.onboarding')).toEqual([])
      await host.dispose()
      const after: IndexInjection[] = []
      ctx.emit('webserver/index-inject', after)
      expect(after).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('defaults to browser onboarding and rejects malformed bootstrap options', async () => {
    expect(hostPlugin.Config({})).toEqual({ credentialOnboarding: true })
    expect(hostPlugin.Config['~standard'].validate({ credentialOnboarding: 'false' })).toHaveProperty('issues')
    const { ctx } = await bench()
    try {
      vi.stubGlobal(ONBOARDING_CONFIG_GLOBAL, { credentialOnboarding: 'false' })
      expect(() => { apply(ctx) }).toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings', 'remote.session',
      'configForms', 'settingsSchema',
    ])
  })

  it('locale change while the slot is undeclared stays a no-op', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    b.locale.setLocale('zh')
  })

  it('re-registers after an HMR collapse re-declares the slot (stale disposer must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    // Declarer unload: the cascade removes our entry while our local
    // disposer variable goes stale.
    redeclare()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(0)
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('settings.onboarding')).toHaveLength(2)
  })

  it('registers the zh/en nav dictionaries and disposes everything with the fiber', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.models')('nav')).toBe('模型')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(0)
    // The (ns, locale) seats are free again — the dictionary disposers ran.
    expect(() => b.locale.register('settings.models', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings.models', 'en', {})).not.toThrow()
  })

  it('keeps remote-browser acknowledgement in process memory', async () => {
    const b = await bench(false)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'welcome-notice')!
    const injected = (
      entry.inject as unknown as () => import('../src/client/WelcomeNotice.tsx').WelcomeNoticeInjected
    )()

    await injected.controller.load()
    expect(injected.controller.store.getSnapshot()).toEqual({
      status: 'ready', acknowledged: false, error: null,
    })
  })
})

describe('pushed invalidations', () => {
  it('ignores invalidations before the page ever loaded', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // The fake wire face has no methods: a fetch attempt would throw.
    b.remote.emit('settings/document-updated', ['llm-pi-ai', 1])
    b.remote.emit('credentials/reference-updated', ['OPENAI_API_KEY'])
    b.remote.emit('llm/adapters-updated', [])
    b.ctx.emit('connection/reset')
  })

  it('refreshes a loaded page and skips an idle one', () => {
    const loads: number[] = []
    const controller = {
      store: { getSnapshot: () => ({ status: 'ready' }) },
      load: () => { loads.push(1); return Promise.resolve() },
    }
    refreshIfLoaded(controller as import('../src/client/store.ts').ModelsSettingsStore)
    expect(loads).toHaveLength(1)
    const idle = {
      store: { getSnapshot: () => ({ status: 'idle' }) },
      load: () => { loads.push(2); return Promise.resolve() },
    }
    refreshIfLoaded(idle as import('../src/client/store.ts').ModelsSettingsStore)
    expect(loads).toHaveLength(1)
  })

  it('routes pushed credential invalidation into the shared onboarding join', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'deepseek-official')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/DeepSeekOnboardingDialog.tsx').DeepSeekOnboardingInjected
    )()
    injected.controller.store.update((state) => { state.status = 'ready' })
    const load = vi.spyOn(injected.controller, 'load').mockResolvedValue()
    b.remote.emit('credentials/reference-updated', ['DEEPSEEK_API_KEY'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('welcome state follows the shared mirror across document commits', async () => {
    // The welcome notice derives from its settings scope: a document commit
    // reaches it through the mirror's one refresh, with no routing here.
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const namespace = {
      ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
      schema: JSON.parse(JSON.stringify(Schema.object({ [WELCOME_NOTICE_ACK_FIELD]: Schema.string() }).toJSON())) as JsonValue,
      value: {},
      autoGenerate: true, applies: 'live' as const,
      secrets: [],
      revision: 0,
    }
    const document = { writable: true, hasDocument: false, namespaces: [namespace] }
    mock.remote.settings.describe.mockResolvedValue(ok(document))
    const b = await bench(true, mock)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'welcome-notice')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/WelcomeNotice.tsx').WelcomeNoticeInjected
    )()
    await injected.controller.load()
    await vi.waitFor(() => {
      expect(injected.hooks.welcome.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: false })
    })
    mock.remote.settings.describe.mockResolvedValue(ok({
      ...document,
      namespaces: [{ ...namespace, value: { [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION }, revision: 1 }],
    }))
    b.remote.emit('settings/document-updated', ['ui-settings-general', 1])
    await vi.waitFor(() => {
      expect(injected.hooks.welcome.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true })
    })
  })

})
