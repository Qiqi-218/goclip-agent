import type { ReactNode } from 'react'
import { useEffect, useRef, useState as useReactState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createProject, importAsset, readAssets, readProjects, readRecentAssets, type AssetSummary, type ProjectSummary } from './read.ts'
import { WorkbenchPanel } from './WorkbenchPanel.tsx'
import { createWorkbenchLayoutStore, type LayoutState } from './layout-store.ts'
import type { WorkbenchController } from './workbench-source.ts'
import css from './WorkbenchDrawer.module.css'

type WorkbenchInjected = Pick<WorkbenchController, 'hooks' | 'close' | 'showProjectHome' | 'selectProject' | 'selectAsset' | 'selectTimeline'> & {
  syncPresentation: (shown: boolean) => void
}

type DrawerProps = PropsLocale<'workbench'> & InjectFace<WorkbenchInjected>
type LauncherProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'workbench'> & InjectFace<Pick<WorkbenchController, 'hooks' | 'open'>>

type LoadState<T> = { status: 'idle' | 'loading' | 'failed', value: T }

const emptyProjects: ProjectSummary[] = []
const emptyAssets: AssetSummary[] = []

function formatDuration(durationUs: number): string {
  const seconds = Math.max(0, Math.round(durationUs / 1e6))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The left-rail action that opens the workbench without changing the conversation panel. */
export function WorkbenchLauncher({ wide, t, useState, open }: LauncherProps): ReactNode {
  const active = useState(state => state.open)
  return (
    <button
      type="button"
      className={css.launcher}
      aria-label={t('entry')}
      aria-current={active ? 'page' : undefined}
      data-workbench-launcher=""
      onClick={() => { open() }}
    >
      <span className={css.launcherIcon} aria-hidden="true">✂</span>
      {wide && <span>{t('entry')}</span>}
    </button>
  )
}

/** The product-facing workbench surface: project home, asset browser, or editor. */
export function WorkbenchDrawer({ t, useState, close, showProjectHome, selectProject, selectAsset, selectTimeline, syncPresentation }: DrawerProps): ReactNode {
  const state = useState(current => current)
  const [projects, setProjects] = useReactState<LoadState<ProjectSummary[]>>({ status: 'idle', value: emptyProjects })
  const [recentAssets, setRecentAssets] = useReactState<LoadState<AssetSummary[]>>({ status: 'idle', value: emptyAssets })
  const [assets, setAssets] = useReactState<LoadState<AssetSummary[]>>({ status: 'idle', value: emptyAssets })
  const [projectName, setProjectName] = useReactState('')
  const [busy, setBusy] = useReactState(false)
  const [error, setError] = useReactState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const layoutStore = useRef(createWorkbenchLayoutStore().create()).current
  const useLayoutStore = <T,>(selector: (state: LayoutState) => T): T => useSyncExternalStore(layoutStore.subscribe, () => selector(layoutStore.getSnapshot()))

  useEffect(() => {
    syncPresentation(state.open)
  }, [state.open, syncPresentation])

  useEffect(() => () => { syncPresentation(false) }, [syncPresentation])

  useEffect(() => {
    if (!state.open) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close, state.open])

  useEffect(() => {
    if (!state.open) return
    const controller = new AbortController()
    setProjects(current => ({ ...current, status: 'loading' }))
    setRecentAssets(current => ({ ...current, status: 'loading' }))
    void readProjects(controller.signal).then(result => {
      if (controller.signal.aborted) return
      if (result.status === 'ok') setProjects({ status: 'idle', value: result.value })
      else setProjects(current => ({ ...current, status: 'failed' }))
    })
    void readRecentAssets(controller.signal).then(result => {
      if (controller.signal.aborted) return
      if (result.status === 'ok') setRecentAssets({ status: 'idle', value: result.value })
      else setRecentAssets(current => ({ ...current, status: 'failed' }))
    })
    return () => controller.abort()
  }, [state.open])

  useEffect(() => {
    if (!state.open || state.projectId === null) { setAssets({ status: 'idle', value: emptyAssets }); return }
    const controller = new AbortController()
    setAssets(current => ({ ...current, status: 'loading' }))
    void readAssets(state.projectId, controller.signal).then(result => {
      if (controller.signal.aborted) return
      if (result.status === 'ok') setAssets({ status: 'idle', value: result.value })
      else setAssets(current => ({ ...current, status: 'failed' }))
    })
    return () => controller.abort()
  }, [state.open, state.projectId])

  if (!state.open) return null

  const activeProject = projects.value.find(project => project.id === state.projectId) ?? null
  const activeAsset = assets.value.find(asset => asset.id === state.assetId) ?? null
  const returnToAssets = state.projectId !== null && state.assetId !== null
  const returnToProjects = state.projectId !== null && state.assetId === null
  const create = async (): Promise<void> => {
    const name = projectName.trim()
    if (name === '') return
    setBusy(true); setError(null)
    try {
      const project = await createProject(name)
      setProjects(current => ({ status: 'idle', value: [project, ...current.value] }))
      setProjectName('')
      selectProject(project.id)
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  const chooseFile = async (file: File): Promise<void> => {
    if (state.projectId === null) return
    setBusy(true); setError(null)
    try {
      const asset = await importAsset(state.projectId, file)
      setAssets(current => ({ status: 'idle', value: [asset, ...current.value.filter(item => item.id !== asset.id)] }))
      selectAsset(asset)
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false); if (inputRef.current !== null) inputRef.current.value = '' }
  }

  return (
      <section
        className={css.drawer}
        data-workbench-drawer=""
        role="complementary"
        aria-label={t('entry')}
      >
        <header className={css.header}>
          <div className={css.breadcrumbs}>
            <strong>{t('entry')}</strong>
            {activeProject !== null && <><span aria-hidden="true">/</span><span>{activeProject.name}</span></>}
            {activeAsset !== null && <><span aria-hidden="true">/</span><span>{activeAsset.source_name}</span></>}
          </div>
          <div className={css.headerActions}>
            {returnToAssets && <button type="button" className={css.quietButton} onClick={() => { selectProject(state.projectId!) }}>{t('drawer.backToAssets')}</button>}
            {returnToProjects && <button type="button" className={css.quietButton} onClick={showProjectHome}>{t('drawer.backToProjects')}</button>}
            <button ref={closeRef} type="button" className={css.closeButton} aria-label={t('drawer.close')} onClick={close}>×</button>
          </div>
        </header>

        {error !== null && <div className={css.error} role="alert">{error}</div>}

        {state.projectId === null || activeProject === null
          ? <ProjectHome projects={projects} recentAssets={recentAssets} projectName={projectName} busy={busy} t={t} onName={setProjectName} onCreate={() => { void create() }} onOpen={selectProject} onAsset={selectAsset} />
          : state.assetId === null || activeAsset === null
            ? <AssetBrowser project={activeProject} assets={assets} busy={busy} t={t} onOpen={selectAsset} onImport={() => { inputRef.current?.click() }} />
            : <div className={css.editorBody}><WorkbenchPanel t={t} asset={{ projectId: state.projectId, assetId: state.assetId }} initialTimelineId={state.timelineId} onTimelineChange={selectTimeline} useStore={useLayoutStore} actions={layoutStore.actions} /></div>}

        <input ref={inputRef} className={css.hiddenInput} type="file" accept="video/*,.mkv,.mov,.webm" onChange={event => { const file = event.target.files?.[0]; if (file !== undefined) void chooseFile(file) }} />
      </section>
  )
}

function ProjectHome({ projects, recentAssets, projectName, busy, t, onName, onCreate, onOpen, onAsset }: {
  projects: LoadState<ProjectSummary[]>
  recentAssets: LoadState<AssetSummary[]>
  projectName: string
  busy: boolean
  t: (key: never, vars?: Record<string, string | number>) => string
  onName: (value: string) => void
  onCreate: () => void
  onOpen: (projectId: string) => void
  onAsset: (asset: AssetSummary) => void
}): ReactNode {
  return (
    <main className={css.home} data-workbench-home="">
      <div className={css.intro}>
        <span className={css.eyebrow}>{t('home.eyebrow' as never)}</span>
        <h1>{t('home.title' as never)}</h1>
        <p>{t('home.hint' as never)}</p>
      </div>
      <section className={css.section} aria-labelledby="workbench-projects-heading">
        <div className={css.sectionHeader}><h2 id="workbench-projects-heading">{t('home.projects' as never)}</h2><span>{projects.value.length}</span></div>
        {projects.status === 'loading' && <p className={css.note}>{t('home.loading' as never)}</p>}
        {projects.status === 'failed' && <p className={css.note}>{t('home.failed' as never)}</p>}
        {projects.status !== 'loading' && projects.value.length === 0 && <p className={css.note}>{t('home.empty' as never)}</p>}
        <div className={css.projectList}>
          {projects.value.map(project => (
            <button key={project.id} type="button" className={css.projectRow} onClick={() => { onOpen(project.id) }}>
              <span className={css.projectMark} aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
              <span className={css.projectText}><strong>{project.name}</strong><small>{t('home.assetCount' as never, { count: project.asset_count })}</small></span>
              <span aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      </section>
      {recentAssets.value.length > 0 && <section className={css.section} aria-labelledby="workbench-recent-assets-heading">
        <div className={css.sectionHeader}><h2 id="workbench-recent-assets-heading">{t('home.assets' as never)}</h2><span>{recentAssets.value.length}</span></div>
        <div className={css.assetList}>
          {recentAssets.value.slice(0, 6).map(asset => (
            <button key={`${asset.projectId}/${asset.id}`} type="button" className={css.assetRow} onClick={() => { onAsset(asset) }}>
              {asset.thumbnail_url === null ? <span className={css.thumbnailFallback} aria-hidden="true">▶</span> : <img className={css.thumbnail} src={asset.thumbnail_url} alt="" />}
              <span className={css.assetText}><strong>{asset.source_name}</strong><small>{formatDuration(asset.duration_us)} · {asset.width}×{asset.height}</small></span>
              <span className={css.assetStatus}>{asset.analysis_status === 'ready' ? t('assets.analysisReady' as never) : t('assets.analysisPending' as never)}</span>
            </button>
          ))}
        </div>
      </section>}
      <section className={css.create} aria-labelledby="workbench-create-heading">
        <h2 id="workbench-create-heading">{t('home.newProject' as never)}</h2>
        <div className={css.createRow}>
          <input value={projectName} onChange={event => { onName(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') onCreate() }} placeholder={t('home.projectPlaceholder' as never)} aria-label={t('home.projectName' as never)} />
          <button type="button" className={css.primaryButton} disabled={busy || projectName.trim() === ''} onClick={onCreate}>{busy ? t('home.creating' as never) : t('home.create' as never)}</button>
        </div>
      </section>
    </main>
  )
}

function AssetBrowser({ project, assets, busy, t, onOpen, onImport }: {
  project: ProjectSummary | null
  assets: LoadState<AssetSummary[]>
  busy: boolean
  t: (key: never, vars?: Record<string, string | number>) => string
  onOpen: (asset: AssetSummary) => void
  onImport: () => void
}): ReactNode {
  return (
    <main className={css.browser} data-workbench-assets="">
      <div className={css.browserHeading}>
        <div><span className={css.eyebrow}>{t('assets.eyebrow' as never)}</span><h1>{project?.name ?? t('assets.project' as never)}</h1></div>
        <button type="button" className={css.primaryButton} disabled={busy} onClick={onImport}>{busy ? t('assets.importing' as never) : t('assets.import' as never)}</button>
      </div>
      {assets.status === 'loading' && <p className={css.note}>{t('assets.loading' as never)}</p>}
      {assets.status === 'failed' && <p className={css.note}>{t('assets.failed' as never)}</p>}
      {assets.status !== 'loading' && assets.value.length === 0 && <div className={css.emptyState}><h2>{t('assets.empty' as never)}</h2><p>{t('assets.emptyHint' as never)}</p><button type="button" className={css.primaryButton} onClick={onImport}>{t('assets.import' as never)}</button></div>}
      <div className={css.assetList}>
        {assets.value.map(asset => (
          <button key={asset.id} type="button" className={css.assetRow} onClick={() => { onOpen(asset) }}>
            {asset.thumbnail_url === null ? <span className={css.thumbnailFallback} aria-hidden="true">▶</span> : <img className={css.thumbnail} src={asset.thumbnail_url} alt="" />}
            <span className={css.assetText}><strong>{asset.source_name}</strong><small>{formatDuration(asset.duration_us)} · {asset.width}×{asset.height}</small></span>
            <span className={css.assetStatus}>{asset.timeline_count > 0 ? t('assets.timelineReady' as never) : t('assets.timelineNone' as never)}</span>
          </button>
        ))}
      </div>
    </main>
  )
}
