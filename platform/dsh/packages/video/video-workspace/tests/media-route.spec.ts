import { DatabaseSync } from 'node:sqlite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { VideoWorkspace } from '../src/runtime.ts'
import { mediaRoute, type MediaSource } from '../src/media-route.ts'
import { workspaceRoute } from '../src/workspace-route.ts'
import type { Config } from '../src/config.ts'

function source(): MediaSource {
  return {
    resolve: vi.fn(async () => null),
    sign: vi.fn(() => ''),
    loudness: vi.fn(async () => null),
    timelines: vi.fn(async () => null),
    renders: vi.fn(async () => null),
    evidence: vi.fn(async () => null),
    history: vi.fn(async () => null),
  }
}

describe('media route path parsing', () => {
  it('returns 400 instead of throwing on malformed percent-encoding', () => {
    const route = mediaRoute(source(), '/goclip-media')
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse

    expect(() => route.handler(
      { method: 'GET', url: '/goclip-media/%ZZ' } as IncomingMessage,
      response,
    )).not.toThrow()
    expect(response.writeHead).toHaveBeenCalledWith(400, {})
    expect(response.end).toHaveBeenCalledOnce()
  })
})

describe('render media ownership', () => {
  it('does not resolve a job through the wrong asset path', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE assets(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL);
      CREATE TABLE timelines(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, asset_id TEXT NOT NULL, name TEXT);
      CREATE TABLE jobs(id TEXT PRIMARY KEY, timeline_id TEXT NOT NULL, output TEXT);
      INSERT INTO assets VALUES ('asset-a', 'project', 'oss://source-a.mp4');
      INSERT INTO assets VALUES ('asset-b', 'project', 'oss://source-b.mp4');
      INSERT INTO timelines VALUES ('timeline-a', 'project', 'asset-a', NULL);
      INSERT INTO jobs VALUES ('job-a', 'timeline-a', 'oss://render-a.mp4');
    `)
    const workspace = new VideoWorkspace({} as Config)
    ;(workspace as unknown as { open: () => Promise<DatabaseSync> }).open = async () => db

    await expect(workspace.resolveMedia(['project', 'asset-b', 'render', 'job-a'])).resolves.toBeNull()
    await expect(workspace.resolveMedia(['project', 'asset-a', 'render', 'job-a'])).resolves.toEqual({
      key: 'render-a.mp4',
      contentType: 'video/mp4',
      downloadName: 'goclip-export-job-a.mp4',
    })
    db.close()
  })
})

function uploadRequest(projectId: string, contents: string): IncomingMessage {
  const boundary = 'goclip-test-boundary'
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n${contents}\r\n--${boundary}--\r\n`)
  return Object.assign(Readable.from([body]), {
    method: 'POST',
    url: `/goclip-workspace/projects/${projectId}/import`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.byteLength) },
  }) as IncomingMessage
}

function response(): ServerResponse {
  return { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse
}

function jsonRequest(url: string, value: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), {
    method: 'POST', url, headers: { 'content-type': 'application/json' },
  }) as IncomingMessage
}

describe('workspace browser imports', () => {
  it('rejects a missing project before it consumes the uploaded body', async () => {
    const video = { projects: vi.fn(async () => []) } as unknown as VideoWorkspace
    const route = workspaceRoute(video, join(tmpdir(), 'goclip-route-unused'), 10)
    const res = response()

    await route.handler(uploadRequest('missing', '1234'), res)

    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object))
  })

  it('rejects an oversized multipart file before importing it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'goclip-route-'))
    const video = { projects: vi.fn(async () => [{ id: 'project' }]), import: vi.fn() } as unknown as VideoWorkspace
    const route = workspaceRoute(video, dataDir, 3)
    const res = response()
    try {
      await route.handler(uploadRequest('project', '1234'), res)
      expect(res.writeHead).toHaveBeenCalledWith(413, expect.any(Object))
      expect(video.import).not.toHaveBeenCalled()
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('workspace timeline operations', () => {
  it('applies an explicit workbench edit through the same revision-checked runtime method', async () => {
    const video = {
      assets: vi.fn(async () => [{ id: 'asset' }]),
      timelinesForAsset: vi.fn(async () => ({ timelines: [{ id: 'timeline' }] })),
      removeSegment: vi.fn(async () => ({ revision: 3 })),
    } as unknown as VideoWorkspace
    const route = workspaceRoute(video, join(tmpdir(), 'goclip-route-unused'), 10)
    const res = response()

    await route.handler(jsonRequest(
      '/goclip-workspace/projects/project/assets/asset/timeline/operations',
      { tool: 'video_timeline_remove', args: { timeline_id: 'timeline', base_revision: 2, ordinal: 1 } },
    ), res)

    expect(video.removeSegment).toHaveBeenCalledWith({ timeline_id: 'timeline', base_revision: 2, ordinal: 1 })
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
  })

  it('returns 409 rather than treating a stale revision as malformed input', async () => {
    const video = {
      assets: vi.fn(async () => [{ id: 'asset' }]),
      timelinesForAsset: vi.fn(async () => ({ timelines: [{ id: 'timeline' }] })),
      removeSegment: vi.fn(async () => { throw new Error('revision conflict: 当前是 3，你基于 2 在改。') }),
    } as unknown as VideoWorkspace
    const route = workspaceRoute(video, join(tmpdir(), 'goclip-route-unused'), 10)
    const res = response()

    await route.handler(jsonRequest('/goclip-workspace/projects/project/assets/asset/timeline/operations', { tool: 'video_timeline_remove', args: { timeline_id: 'timeline', base_revision: 2, ordinal: 1 } }), res)

    expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object))
  })

  it('returns the stored result for an operation-id retry without issuing a second edit', async () => {
    const video = {
      assets: vi.fn(async () => [{ id: 'asset' }]),
      timelinesForAsset: vi.fn(async () => ({ timelines: [{ id: 'timeline' }] })),
      operationResult: vi.fn(async () => ({ revision: 3, reused: true })),
      removeSegment: vi.fn(),
    } as unknown as VideoWorkspace
    const route = workspaceRoute(video, join(tmpdir(), 'goclip-route-unused'), 10)
    const res = response()

    await route.handler(jsonRequest('/goclip-workspace/projects/project/assets/asset/timeline/operations', { operation_id: 'op-123', tool: 'video_timeline_remove', args: { timeline_id: 'timeline', base_revision: 2, ordinal: 1 } }), res)

    expect(video.operationResult).toHaveBeenCalledOnce()
    expect(video.removeSegment).not.toHaveBeenCalled()
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
  })

  it('inserts a source selection at the requested timeline position', async () => {
    const video = {
      assets: vi.fn(async () => [{ id: 'asset' }]),
      timelinesForAsset: vi.fn(async () => ({ timelines: [{ id: 'timeline' }] })),
      insertSegment: vi.fn(async () => ({ revision: 4 })),
    } as unknown as VideoWorkspace
    const route = workspaceRoute(video, join(tmpdir(), 'goclip-route-unused'), 10)
    const res = response()

    await route.handler(jsonRequest(
      '/goclip-workspace/projects/project/assets/asset/timeline/operations',
      { tool: 'video_timeline_insert', args: { timeline_id: 'timeline', base_revision: 3, asset_id: 'asset', start_us: 5_000_000, end_us: 8_000_000, ordinal: 1, speed: 1 } },
    ), res)

    expect(video.insertSegment).toHaveBeenCalledWith({ timeline_id: 'timeline', base_revision: 3, asset_id: 'asset', start_us: 5_000_000, end_us: 8_000_000, ordinal: 1, speed: 1 })
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
  })
})

describe('workspace export submission', () => {
  it('creates a background render task and responds before video encoding', async () => {
    const video = {
      assets: vi.fn(async () => [{ id: 'asset' }]),
      timelinesForAsset: vi.fn(async () => ({ timelines: [{ id: 'timeline' }] })),
      submitRender: vi.fn(async () => ({ job_id: 'job-1', status: 'queued' })),
    } as unknown as VideoWorkspace
    const route = workspaceRoute(video, join(tmpdir(), 'goclip-route-unused'), 10)
    const res = response()

    await route.handler(jsonRequest(
      '/goclip-workspace/projects/project/assets/asset/timeline/timeline/render',
      { aspect: '9:16', burn_subtitles: 'transcript' },
    ), res)

    expect(video.submitRender).toHaveBeenCalledWith('timeline', undefined, { aspect: '9:16', burnSubtitles: 'transcript' })
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object))
  })

  it('cancels only the requested project-owned export', async () => {
    const video = { cancelRender: vi.fn(async () => ({ job_id: 'job-1', status: 'cancelling' })) } as unknown as VideoWorkspace
    const route = workspaceRoute(video, join(tmpdir(), 'goclip-route-unused'), 10)
    const res = response()

    await route.handler(jsonRequest('/goclip-workspace/projects/project/exports/job-1/cancel', {}), res)

    expect(video.cancelRender).toHaveBeenCalledWith('project', 'job-1')
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
  })
})

describe('durable export snapshots', () => {
  it('persists the exact revision, plan, filename and options before queuing work', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'goclip-render-snapshot-'))
    const workspace = new VideoWorkspace({ dataDir } as Config)
    const privateWorkspace = workspace as unknown as {
      open: () => Promise<DatabaseSync>
      restore: () => Promise<void>
      manifest: () => Promise<void>
      enqueueRender: ReturnType<typeof vi.fn>
    }
    privateWorkspace.restore = async () => {}
    privateWorkspace.manifest = async () => {}
    privateWorkspace.enqueueRender = vi.fn()
    let db: DatabaseSync | undefined
    try {
      db = await privateWorkspace.open()
      db.prepare('INSERT INTO projects (id,name) VALUES (?,?)').run('project', 'Project')
      db.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('asset', 'project', '/tmp/asset.mp4', JSON.stringify({ duration_us: 60_000_000 }))
      await workspace.createTimeline({ id: 'timeline', project_id: 'project', asset_id: 'asset', start_us: 1_000_000, end_us: 20_000_000 })

      const submitted = await workspace.submitRender('timeline', 'travel-cut.mp4', { aspect: '9:16', burnSubtitles: 'transcript' })
      // `submitRender` declares `Promise<Data>`, and `Data` is `Record<string, unknown>`, so the
      // id arrives as `unknown` and cannot be bound as a SQL parameter. `String(...)` states the
      // value the host actually returns rather than casting the unknown away.
      const row = db.prepare('SELECT timeline_revision, input_snapshot, filename, render_options FROM jobs WHERE id=?').get(String(submitted.job_id)) as { timeline_revision: number, input_snapshot: string, filename: string, render_options: string }
      expect(row.timeline_revision).toBe(1)
      expect(JSON.parse(row.input_snapshot)).toMatchObject({ project_id: 'project', segments: [{ asset_id: 'asset', start_us: 1_000_000, end_us: 20_000_000 }] })
      expect(row.filename).toBe('travel-cut.mp4')
      expect(JSON.parse(row.render_options)).toEqual({ aspect: '9:16', burnSubtitles: 'transcript' })
      expect(privateWorkspace.enqueueRender).toHaveBeenCalledOnce()
    } finally {
      // A file with an open handle cannot be unlinked on Windows; close before removing.
      db?.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('stable timeline clip identities', () => {
  it('renumbers split, remove, and merge without hitting the ordinal uniqueness constraint', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'goclip-ordinal-renumber-'))
    const workspace = new VideoWorkspace({ dataDir } as Config)
    const privateWorkspace = workspace as unknown as { restore: () => Promise<void>, manifest: () => Promise<void> }
    privateWorkspace.restore = async () => {}
    privateWorkspace.manifest = async () => {}
    let db: DatabaseSync | undefined
    try {
      db = await (workspace as unknown as { open: () => Promise<DatabaseSync> }).open()
      db.prepare('INSERT INTO projects (id,name) VALUES (?,?)').run('project', 'Project')
      db.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('asset', 'project', '/tmp/asset.mp4', JSON.stringify({ duration_us: 60_000_000 }))
      await workspace.createTimeline({ id: 'timeline', project_id: 'project', asset_id: 'asset', start_us: 0, end_us: 40_000_000 })
      await workspace.splitSegment({ timeline_id: 'timeline', base_revision: 1, ordinal: 0, asset_time_us: 10_000_000 })
      await workspace.splitSegment({ timeline_id: 'timeline', base_revision: 2, ordinal: 0, asset_time_us: 5_000_000 })
      expect((await workspace.timeline('timeline') as { segments: Array<{ ordinal: number }> }).segments.map(segment => segment.ordinal)).toEqual([0, 1, 2])
      await workspace.mergeSegments({ timeline_id: 'timeline', base_revision: 3, ordinal: 0 })
      expect((await workspace.timeline('timeline') as { segments: Array<{ ordinal: number }> }).segments.map(segment => segment.ordinal)).toEqual([0, 1])
      await workspace.removeSegment({ timeline_id: 'timeline', base_revision: 4, ordinal: 0 })
      expect((await workspace.timeline('timeline') as { segments: Array<{ ordinal: number }> }).segments.map(segment => segment.ordinal)).toEqual([0])
    } finally {
      // A file with an open handle cannot be unlinked on Windows; close before removing.
      db?.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('inserts a selected source range without disturbing the existing clip identities', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'goclip-insert-'))
    const workspace = new VideoWorkspace({ dataDir } as Config)
    const privateWorkspace = workspace as unknown as { restore: () => Promise<void>, manifest: () => Promise<void> }
    privateWorkspace.restore = async () => {}
    privateWorkspace.manifest = async () => {}
    let db: DatabaseSync | undefined
    try {
      db = await (workspace as unknown as { open: () => Promise<DatabaseSync> }).open()
      db.prepare('INSERT INTO projects (id,name) VALUES (?,?)').run('project', 'Project')
      db.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('asset', 'project', '/tmp/asset.mp4', JSON.stringify({ duration_us: 60_000_000 }))
      await workspace.createTimeline({ id: 'timeline', project_id: 'project', asset_id: 'asset', start_us: 20_000_000, end_us: 30_000_000 })
      const original = (await workspace.timeline('timeline') as { segments: Array<{ clip_id: string }> }).segments[0]!.clip_id
      await workspace.insertSegment({ timeline_id: 'timeline', base_revision: 1, asset_id: 'asset', start_us: 0, end_us: 5_000_000, ordinal: 0 })
      const segments = (await workspace.timeline('timeline') as { segments: Array<{ ordinal: number, clip_id: string, start_us: number }> }).segments
      expect(segments.map(segment => segment.ordinal)).toEqual([0, 1])
      expect(segments[0]?.start_us).toBe(0)
      expect(segments[1]?.clip_id).toBe(original)
    } finally {
      // A file with an open handle cannot be unlinked on Windows; close before removing.
      db?.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps the original id through split, reorder, and history restoration', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'goclip-clip-id-'))
    const workspace = new VideoWorkspace({ dataDir } as Config)
    const privateWorkspace = workspace as unknown as {
      open: () => Promise<DatabaseSync>
      restore: () => Promise<void>
      manifest: () => Promise<void>
    }
    privateWorkspace.restore = async () => {}
    privateWorkspace.manifest = async () => {}
    let db: DatabaseSync | undefined
    try {
      db = await privateWorkspace.open()
      db.prepare('INSERT INTO projects (id,name) VALUES (?,?)').run('project', 'Project')
      db.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('asset', 'project', '/tmp/asset.mp4', JSON.stringify({ duration_us: 60_000_000 }))
      await workspace.createTimeline({ id: 'timeline', project_id: 'project', asset_id: 'asset', start_us: 0, end_us: 40_000_000 })
      const created = await workspace.timeline('timeline') as { segments: Array<{ clip_id: string }> }
      const originalId = created.segments[0]?.clip_id
      expect(originalId).toMatch(/^clip-/)

      await workspace.splitSegment({ timeline_id: 'timeline', base_revision: 1, ordinal: 0, asset_time_us: 20_000_000 })
      const split = await workspace.timeline('timeline') as { segments: Array<{ clip_id: string }> }
      expect(split.segments.map(segment => segment.clip_id)).toContain(originalId)
      expect(new Set(split.segments.map(segment => segment.clip_id)).size).toBe(2)

      await workspace.reorderSegment({ timeline_id: 'timeline', base_revision: 2, from: 1, to: 0 })
      const reordered = await workspace.timeline('timeline') as { segments: Array<{ clip_id: string }> }
      expect(reordered.segments.map(segment => segment.clip_id)).toContain(originalId)
      await workspace.revertTimeline({ timeline_id: 'timeline', base_revision: 3, target_revision: 1 })
      const restored = await workspace.timeline('timeline') as { segments: Array<{ clip_id: string }> }
      expect(restored.segments).toHaveLength(1)
      expect(restored.segments[0]?.clip_id).toBe(originalId)
    } finally {
      // A file with an open handle cannot be unlinked on Windows; close before removing.
      db?.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('allows the final clip to be removed and restored without inventing a phantom segment', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'goclip-empty-timeline-'))
    const workspace = new VideoWorkspace({ dataDir } as Config)
    const privateWorkspace = workspace as unknown as { restore: () => Promise<void>, manifest: () => Promise<void> }
    privateWorkspace.restore = async () => {}
    privateWorkspace.manifest = async () => {}
    let db: DatabaseSync | undefined
    try {
      db = await (workspace as unknown as { open: () => Promise<DatabaseSync> }).open()
      db.prepare('INSERT INTO projects (id,name) VALUES (?,?)').run('project', 'Project')
      db.prepare('INSERT INTO assets (id,project_id,path,meta) VALUES (?,?,?,?)').run('asset', 'project', '/tmp/asset.mp4', JSON.stringify({ duration_us: 60_000_000 }))
      await workspace.createTimeline({ id: 'timeline', project_id: 'project', asset_id: 'asset', start_us: 0, end_us: 10_000_000 })
      await workspace.removeSegment({ timeline_id: 'timeline', base_revision: 1, ordinal: 0 })
      const empty = await workspace.timeline('timeline') as { revision: number, segments: unknown[] }
      expect(empty.revision).toBe(2)
      expect(empty.segments).toEqual([])
      await expect(workspace.submitRender('timeline', undefined)).rejects.toThrow('没有任何片段')
      await workspace.revertTimeline({ timeline_id: 'timeline', base_revision: 2, target_revision: 1 })
      expect((await workspace.timeline('timeline') as { segments: unknown[] }).segments).toHaveLength(1)
    } finally {
      // A file with an open handle cannot be unlinked on Windows; close before removing.
      db?.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
