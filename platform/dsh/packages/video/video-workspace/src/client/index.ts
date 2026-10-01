/**
 * Browser half of the video workspace: a tool card for the visual lookup, and
 * the project workbench behind a sidebar panel.
 *
 * @module dsh-video-workspace/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the SlotRegistry service merge and the toolview slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { FindInVideoCard } from './FrameCard.tsx'
import { RenderJobCard, TimelineCard } from './JobCard.tsx'
import { Workbench } from './Workbench.tsx'
import { WorkbenchIcon } from './WorkbenchIcon.tsx'

/** Services required by the browser half. */
export const inject = ['slots', 'layout']

/** This panel's id; the sidebar row and the central panel share it by design. */
export const WORKBENCH_PANEL = 'video-workbench' as MainPanelId

/** The wire tool names this bundle renders with a dedicated card. */
const CARD_FOR: Record<string, typeof FindInVideoCard> = {
  video_find_in_video: FindInVideoCard,
  video_render_submit: RenderJobCard,
  video_timeline_get: TimelineCard,
}

/**
 * Register the tool cards and the workbench panel.
 * @param ctx - browser services these contributions read.
 */
export function apply(ctx: ClientContext): void {
  for (const [toolName, Card] of Object.entries(CARD_FOR)) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: toolName,
    }, Card))
  }

  // A sidebar row's id IS its main-panel key, so one id binds the icon to the
  // page it opens.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: WORKBENCH_PANEL,
  }, Workbench))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: WORKBENCH_PANEL,
    order: 20,
    label: () => '剪辑',
  }, WorkbenchIcon))
}

export type { FrameMatch, FindResult } from './FrameCard.tsx'
export { FindInVideoCard, readResult } from './FrameCard.tsx'
export { RenderJobCard, TimelineCard } from './JobCard.tsx'
export { Workbench, SERVICE } from './Workbench.tsx'
