import { DatabaseSync } from 'node:sqlite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { VideoWorkspace } from '../src/runtime.ts'
import { mediaRoute, type MediaSource } from '../src/media-route.ts'
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
    })
    db.close()
  })
})
