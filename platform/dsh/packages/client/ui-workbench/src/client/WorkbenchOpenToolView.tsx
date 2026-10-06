import { useEffect } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { openWorkbenchFromTool } from './workbench-source.ts'

/** Narrow runtime shape of the keyed tool slot; avoid coupling this feature to ui-tool's source project. */
type ToolView = {
  readonly callId: string
  readonly phase: 'preparing' | 'start' | 'result'
  readonly block: { readonly isError?: boolean, readonly call?: { readonly argsRaw: string } | null }
}
type Props = ToolView & PropsLocale<'workbench'>

type Target = { projectId: string, assetId: string | null, timelineId: string | null }

function targetOf(props: ToolView): Target | null {
  if (props.phase !== 'result' || props.block.isError || props.block.call === null) return null
  try {
    const args = JSON.parse(props.block.call!.argsRaw) as { project_id?: unknown, asset_id?: unknown, timeline_id?: unknown }
    return typeof args.project_id === 'string' && args.project_id !== ''
      ? {
          projectId: args.project_id,
          assetId: typeof args.asset_id === 'string' && args.asset_id !== '' ? args.asset_id : null,
          timelineId: typeof args.timeline_id === 'string' && args.timeline_id !== '' ? args.timeline_id : null,
        }
      : null
  } catch { return null }
}

/**
 * Consume a model-issued open instruction exactly once in this browser profile.
 *
 * A tool result is durable and gets rendered again during log replay.  Persisting the
 * consumed call id is what distinguishes a new explicit instruction from an old transcript;
 * closing the workbench therefore remains a real user choice.
 */
export function WorkbenchOpenToolView(props: Props) {
  const target = targetOf(props)
  useEffect(() => {
    if (target === null) return
    const key = `goclip.workbench.consumed-open.${props.callId}`
    try {
      if (localStorage.getItem(key) !== null) return
      localStorage.setItem(key, '1')
    } catch { /* private browsing still opens once for this mounted call */ }
    openWorkbenchFromTool({ projectId: target.projectId, assetId: target.assetId, timelineId: target.timelineId })
  }, [props.callId, target?.projectId, target?.assetId, target?.timelineId])

  if (target === null) return <p>{props.t('tool.open.failed')}</p>
  return <p data-workbench-open-tool="">{props.t('tool.opened')}</p>
}
