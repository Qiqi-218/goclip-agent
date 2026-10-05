/**
 * Workbench plugin, browser half: the sidebar entry that opens the workbench,
 * and the workbench itself as a central panel.
 *
 * The entry registers into `sidebar.panellist` with an `id` that is also the
 * `main` slot key, which is the whole wiring: the sidebar reads that id as the
 * panel it selects, and the frame renders `main` at the selected key. Nothing
 * here calls `selectPanel`, and nothing renders the workbench conditionally —
 * the panel appears exactly while the sidebar has its entry selected.
 *
 * Composing this plugin out removes both the entry and the panel: the keyed
 * `main` seat falls back, and nothing else in the client refers to this package.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the keyed central-panel seat and the sidebar's panel list.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkbenchPanel } from './WorkbenchPanel.tsx'
import { WorkbenchPanelIcon } from './WorkbenchPanelIcon.tsx'
import { en, zh, type WorkbenchKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The workbench's column headings and empty-state copy. */
    workbench: WorkbenchKey
  }
}

/**
 * The panel id, the sidebar entry id, and the `main` slot key.
 *
 * One value for all three because the sidebar selects a central panel by the id
 * of its entry, so a separate name for the panel would be a second fact that
 * could disagree with the first.
 */
const PANEL_ID = 'workbench'

/** Required client services: the slot registry and this package's dictionary. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the workbench dictionary, its central panel, and the
 * sidebar entry that selects it.
 *
 * ## Why the Conversation is not hosted in the right column here
 *
 * The intended layout is the workbench in the centre with the Conversation beside it, and
 * the right column is where the Conversation sits today. That cannot be built from the
 * public surface, for two reasons that were each checked rather than assumed:
 *
 * 1. **A centre panel releases the right column's Session.** `ui-sidebar-right` computes
 *    its on-screen Session as `activePanelId === null ? selected.sessionId : undefined`, so
 *    selecting any centre panel — this one included — deliberately drops that binding. The
 *    right column is not a second copy of the Conversation; it is a viewer for the Session
 *    the centre is showing.
 * 2. **A right-Sidebar tab cannot bind a Session itself.** Hosting the Conversation needs
 *    `SessionProvider`, and `PropsRenderSlots` types that seat only where the entry declares
 *    session-scoped *children*. `sidebar.right.pane.tab` declares none, and its props carry
 *    `SessionStandardProps` instead — the compiler rejects the attempt outright. The one
 *    package that hosts a Conversation in that column reaches it through
 *    `sidebar.chat.conversation`, a slot `ui-subagent` declares for its own child-Session
 *    tabs, and a slot key has exactly one owner.
 *
 * So this panel keeps the centre and stands alone. Putting the two side by side needs either
 * `main` to accept a session-scoped key or `ui-sidebar-right` to keep its binding while a
 * centre panel is selected — both are changes to packages this plugin does not own.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('workbench', { zh, en }), 'ui-workbench: dictionaries')
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: 'workbench' }, WorkbenchPanel,
  ))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    // After the shipped entries, so the product's own surfaces keep their order.
    order: 100,
    label: () => ctx.locale.bind('workbench')('entry'),
    locale: 'workbench',
  }, WorkbenchPanelIcon))
}
