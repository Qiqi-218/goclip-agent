import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchAsset } from './read.ts'

/** Current workbench presentation and selection. */
export interface WorkbenchState {
  readonly open: boolean
  readonly expanded: boolean
  readonly projectId: string | null
  readonly assetId: string | null
  /** The sequence the caller explicitly asked to inspect; null means choose the first available. */
  readonly timelineId: string | null
}

/** Root-scoped controller shared by the sidebar launcher, overlay, and future chat actions. */
export interface WorkbenchController {
  readonly hooks: { readonly state: HostObservable<WorkbenchState> }
  open(context?: Partial<Pick<WorkbenchState, 'projectId' | 'assetId' | 'timelineId'>>): void
  close(): void
  expand(): void
  collapse(): void
  showProjectHome(): void
  selectProject(projectId: string): void
  selectAsset(asset: WorkbenchAsset): void
  selectTimeline(timelineId: string | null): void
}

const STORAGE_KEY = 'goclip.workbench.last-context'
let liveController: WorkbenchController | null = null

/** Used by the session-scoped tool view after the root controller has been created. */
export function openWorkbenchFromTool(context: Partial<Pick<WorkbenchState, 'projectId' | 'assetId' | 'timelineId'>>): void { liveController?.open(context) }

function readStoredContext(): Pick<WorkbenchState, 'projectId' | 'assetId' | 'timelineId'> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { projectId?: unknown, assetId?: unknown, timelineId?: unknown } | null
    return {
      projectId: typeof value?.projectId === 'string' ? value.projectId : null,
      assetId: typeof value?.assetId === 'string' ? value.assetId : null,
      timelineId: typeof value?.timelineId === 'string' ? value.timelineId : null,
    }
  } catch {
    return { projectId: null, assetId: null, timelineId: null }
  }
}

function readAddressContext(): Pick<WorkbenchState, 'projectId' | 'assetId' | 'timelineId'> {
  const params = new URLSearchParams(window.location.hash.slice(1))
  return {
    projectId: params.get('project'),
    assetId: params.get('asset'),
    timelineId: params.get('timeline'),
  }
}

function saveContext(projectId: string | null, assetId: string | null, timelineId: string | null): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ projectId, assetId, timelineId })) } catch { /* private browsing */ }
}

function publishHash(projectId: string | null, assetId: string | null, timelineId: string | null): void {
  const params = new URLSearchParams()
  if (projectId !== null) params.set('project', projectId)
  if (assetId !== null) params.set('asset', assetId)
  if (timelineId !== null) params.set('timeline', timelineId)
  const hash = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash === '' ? '' : `#${hash}`}`)
}

/** Create the one live workbench controller for the browser root. */
export function createWorkbenchController(): WorkbenchController {
  const stored = readStoredContext()
  const address = readAddressContext()
  const initial = address.projectId !== null || address.assetId !== null ? address : stored
  let state: WorkbenchState = { open: false, expanded: false, ...initial }
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  const setContext = (projectId: string | null, assetId: string | null, timelineId: string | null = null): void => {
    state = { ...state, projectId, assetId, timelineId }
    saveContext(projectId, assetId, timelineId)
    publishHash(projectId, assetId, timelineId)
    notify()
  }
  const controller: WorkbenchController = {
    hooks: {
      state: {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    },
    open: context => {
      const nextProject = context?.projectId ?? state.projectId
      const nextAsset = context?.assetId ?? state.assetId
      const nextTimeline = context?.timelineId ?? state.timelineId
      state = { ...state, open: true, projectId: nextProject ?? null, assetId: nextAsset ?? null, timelineId: nextTimeline ?? null }
      saveContext(state.projectId, state.assetId, state.timelineId)
      publishHash(state.projectId, state.assetId, state.timelineId)
      notify()
    },
    close: () => { if (state.open) { state = { ...state, open: false, expanded: false }; notify() } },
    expand: () => { if (!state.expanded) { state = { ...state, expanded: true }; notify() } },
    collapse: () => { if (state.expanded) { state = { ...state, expanded: false }; notify() } },
    showProjectHome: () => setContext(null, null),
    selectProject: projectId => setContext(projectId, null),
    selectAsset: asset => setContext(asset.projectId, asset.assetId),
    selectTimeline: timelineId => setContext(state.projectId, state.assetId, timelineId),
  }
  liveController = controller
  return controller
}
