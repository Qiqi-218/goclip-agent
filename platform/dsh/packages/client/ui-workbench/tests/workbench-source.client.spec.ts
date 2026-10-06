// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkbenchController } from '../src/client/workbench-source.ts'

const STORAGE_KEY = 'goclip.workbench.last-context'

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})

afterEach(() => { window.history.replaceState(null, '', '/') })

describe('workbench selection from an address', () => {
  it('prefers a linked project and asset to previously saved context', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ projectId: 'saved-project', assetId: 'saved-asset' }))
    window.history.replaceState(null, '', '/#project=linked-project&asset=linked-asset')

    const workbench = createWorkbenchController()

    expect(workbench.hooks.state.getSnapshot()).toMatchObject({ projectId: 'linked-project', assetId: 'linked-asset' })
    expect(window.location.hash).toBe('#project=linked-project&asset=linked-asset')
  })

  it('restores the exact timeline named by a deep link or model open instruction', () => {
    window.history.replaceState(null, '', '/#project=linked-project&asset=linked-asset&timeline=tl-cut-v3')

    const workbench = createWorkbenchController()

    expect(workbench.hooks.state.getSnapshot()).toMatchObject({
      projectId: 'linked-project', assetId: 'linked-asset', timelineId: 'tl-cut-v3',
    })
    workbench.open({ projectId: 'linked-project', assetId: 'linked-asset', timelineId: 'tl-cut-v4' })
    expect(workbench.hooks.state.getSnapshot().timelineId).toBe('tl-cut-v4')
    expect(window.location.hash).toContain('timeline=tl-cut-v4')
  })

  it('steps back from an asset to its project and then to the project home', () => {
    const workbench = createWorkbenchController()
    workbench.open({ projectId: 'project-a', assetId: 'asset-a' })

    workbench.selectProject('project-a')
    expect(workbench.hooks.state.getSnapshot()).toMatchObject({ projectId: 'project-a', assetId: null })

    workbench.showProjectHome()
    expect(workbench.hooks.state.getSnapshot()).toMatchObject({ projectId: null, assetId: null })
  })

  it('keeps a user-selected timeline in the durable workbench context', () => {
    const workbench = createWorkbenchController()
    workbench.open({ projectId: 'project-a', assetId: 'asset-a', timelineId: 'tl-a' })
    workbench.selectTimeline('tl-b')

    expect(workbench.hooks.state.getSnapshot()).toMatchObject({ timelineId: 'tl-b' })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ timelineId: 'tl-b' })
  })
})
