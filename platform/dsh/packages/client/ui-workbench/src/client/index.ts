/** Workbench browser plugin: a project-aware drawer that leaves the conversation mounted. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkbenchDrawer, WorkbenchLauncher } from './WorkbenchDrawer.tsx'
import { WorkbenchOpenToolView } from './WorkbenchOpenToolView.tsx'
import { createWorkbenchController } from './workbench-source.ts'
import { en, zh, type WorkbenchKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The workbench's project, asset, and editor copy. */
    workbench: WorkbenchKey
  }
  // Keep this optional enhancement independently buildable: the real ui-tool package
  // owns the richer contract at runtime, while this local shape only needs a keyed seat.
  interface SlotMap {
    'tool.call.toolview': { kind: 'keyed', scope: 'session', owner: { callId: string, phase: 'preparing' | 'start' | 'result', block: { isError?: boolean, call?: { argsRaw: string } | null } }, hookContext: unknown, inject: {} }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workbench: import('./workbench-source.ts').WorkbenchController
  }
}

const WORKBENCH_ID = 'workbench'

/** Required client services: the slot registry and this package's dictionary. */
export const inject = ['slots', 'locale', 'layout']

/** Register the project-aware overlay and persistent sidebar launcher. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('workbench', { zh, en }), 'ui-workbench: dictionaries')
  const t = ctx.locale.bind('workbench')
  const workbench = createWorkbenchController()
  ctx.reflect.provide('workbench', workbench)

  ctx.slots.inject('rightbar', () => ctx.slots.register({
    name: 'rightbar',
    locale: 'workbench',
    inject: () => ({
      t,
      hooks: workbench.hooks,
      close: workbench.close,
      showProjectHome: workbench.showProjectHome,
      selectProject: workbench.selectProject,
      selectAsset: workbench.selectAsset,
      selectTimeline: workbench.selectTimeline,
      syncPresentation: (shown: boolean) => {
        if (shown) ctx.layout.openRightbar(true, false)
        else ctx.layout.closeRightbar()
      },
    }),
  }, WorkbenchDrawer))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: WORKBENCH_ID,
    order: 10,
    locale: 'workbench',
    inject: () => ({ hooks: workbench.hooks, open: workbench.open }),
  }, WorkbenchLauncher))

  // The model opens the surface through a durable tool result, not by replaying a chat string.
  // `WorkbenchOpenToolView` consumes the call id once, so historic transcript rendering cannot
  // undo a person's explicit close action.
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'video_workbench_open', locale: 'workbench',
  }, WorkbenchOpenToolView))
}
