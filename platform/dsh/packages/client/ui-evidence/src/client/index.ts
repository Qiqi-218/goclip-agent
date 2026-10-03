/**
 * Evidence panel plugin, browser half: the read-only panel that one
 * `video_evidence_view` call renders as its keyed Tool view.
 *
 * The view is registered under the wire name the video plugin exposes, so the
 * panel appears wherever that call settles — including when a session log is
 * reopened, because every track derives from the result metadata the call
 * persisted rather than from anything this plugin holds.
 *
 * Composing this plugin out leaves the generic Tool row in place: the keyed
 * seat falls back, and nothing else in the client refers to this package.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the keyed Tool-view seat and the composed props the panel receives.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { EvidencePanel } from './EvidencePanel.tsx'
import { en, NS, zh, type EvidenceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The evidence panel's track names, counts and units. */
    evidence: EvidenceKey
  }
}

/** The wire Tool name whose calls this panel renders. */
const TOOL_NAME = 'video_evidence_view'

/** Required services for the keyed Tool-view registration and its dictionary. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the evidence dictionary and the keyed Tool view.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-evidence: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: TOOL_NAME, locale: NS }, EvidencePanel,
  ))
}
