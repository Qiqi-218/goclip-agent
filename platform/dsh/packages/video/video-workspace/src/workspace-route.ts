import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, rename } from 'node:fs/promises'
import { execFile as nodeExecFile } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { VideoWorkspace } from './runtime.ts'

const PREFIX = '/goclip-workspace'
const execFile = promisify(nodeExecFile)
const MAX_MULTIPART_METADATA_BYTES = 64 * 1024

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.byteLength), 'Cache-Control': 'no-store' })
  res.end(body)
}

async function body(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function multipartBoundary(req: IncomingMessage): Buffer {
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(req.headers['content-type'] ?? '')
  const boundary = match?.[1] ?? match?.[2]
  if (boundary === undefined || boundary === '') throw new RouteError(400, 'a multipart video upload is required')
  return Buffer.from(`--${boundary}`, 'utf8')
}

async function writeChunk(output: ReturnType<typeof createWriteStream>, bytes: Buffer, size: number, limit: number): Promise<number> {
  const nextSize = size + bytes.byteLength
  if (nextSize > limit) throw new RouteError(413, 'video is larger than the configured import limit')
  if (bytes.byteLength > 0 && !output.write(bytes)) await once(output, 'drain')
  return nextSize
}

/** Stream exactly one browser file part to disk, retaining only multipart delimiters in memory. */
async function streamMultipartFile(req: IncomingMessage, tempDir: string, limit: number): Promise<{ name: string, path: string }> {
  const contentLength = Number(req.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > limit + MAX_MULTIPART_METADATA_BYTES) {
    throw new RouteError(413, 'video is larger than the configured import limit')
  }
  const boundary = multipartBoundary(req)
  const opening = Buffer.concat([boundary, Buffer.from('\r\n')])
  const delimiter = Buffer.concat([Buffer.from('\r\n'), boundary])
  let pending = Buffer.alloc(0)
  let fileName = 'video.mp4'
  let fileSize = 0
  let parsingHeaders = true
  const path = join(tempDir, `${randomUUID()}.upload`)
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 })

  try {
    for await (const chunk of req) {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      if (parsingHeaders) {
        if (pending.length < opening.length) continue
        if (!pending.subarray(0, opening.length).equals(opening)) throw new RouteError(400, 'malformed multipart upload')
        const headerEnd = pending.indexOf('\r\n\r\n')
        if (headerEnd === -1) {
          if (pending.length > MAX_MULTIPART_METADATA_BYTES) throw new RouteError(400, 'multipart metadata is too large')
          continue
        }
        const disposition = pending.subarray(opening.length, headerEnd).toString('utf8')
        const field = /(?:^|;)\s*name="([^"]+)"/i.exec(disposition)
        const name = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)
        if (field?.[1] !== 'file' || name === null) throw new RouteError(400, 'one video file is required')
        const suppliedName = name[1]
        if (suppliedName !== undefined && suppliedName !== '') fileName = suppliedName
        pending = pending.subarray(headerEnd + 4)
        parsingHeaders = false
      }
      const end = pending.indexOf(delimiter)
      if (end !== -1) {
        const trailer = pending.subarray(end + delimiter.length)
        if (trailer.length < 2) continue
        if (!trailer.subarray(0, 2).equals(Buffer.from('--')) && !trailer.subarray(0, 2).equals(Buffer.from('\r\n'))) {
          throw new RouteError(400, 'malformed multipart upload')
        }
        await writeChunk(output, pending.subarray(0, end), fileSize, limit)
        output.end()
        await finished(output)
        return { name: fileName, path }
      }
      const tailLength = Math.min(pending.length, delimiter.length - 1)
      const data = pending.subarray(0, pending.length - tailLength)
      fileSize = await writeChunk(output, data, fileSize, limit)
      pending = pending.subarray(pending.length - tailLength)
    }
    throw new RouteError(400, 'malformed multipart upload')
  } catch (error) {
    output.destroy()
    await rm(path, { force: true })
    throw error
  }
}

function pathParts(req: IncomingMessage, base: string): string[] {
  const pathname = new URL(req.url ?? '/', 'http://goclip.local').pathname
  const rest = pathname.slice(base.length).replace(/^\/+/, '')
  return rest === '' ? [] : rest.split('/').map(segment => decodeURIComponent(segment))
}

async function summaries(video: VideoWorkspace, projectId: string, dataDir: string): Promise<unknown[]> {
  const assets = await video.assets(projectId)
  return await Promise.all(assets.map(async asset => {
    const id = String(asset.id)
    const timeline = await video.timelinesForAsset(projectId, id)
    const evidence = await video.evidenceStatus(projectId, id)
    const done = Array.isArray(evidence.evidence_done) ? evidence.evidence_done.length : 0
    const missing = Array.isArray(evidence.evidence_not_computed) ? evidence.evidence_not_computed.length : 0
    const metadata = asset as { source_name?: unknown, duration_us?: unknown, width?: unknown, height?: unknown, fps?: unknown }
    const thumbnailPath = join(dataDir, 'thumbnails', `${id}.jpg`)
    const thumbnailReady = existsSync(thumbnailPath)
    return {
      id,
      project_id: projectId,
      projectId,
      assetId: id,
      source_name: typeof metadata.source_name === 'string' ? metadata.source_name : id,
      duration_us: Number(metadata.duration_us) || 0,
      width: Number(metadata.width) || 0,
      height: Number(metadata.height) || 0,
      fps: typeof metadata.fps === 'string' ? metadata.fps : '0/1',
      thumbnail_url: thumbnailReady ? `${PREFIX}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(id)}/thumbnail` : null,
      thumbnail_status: thumbnailReady ? 'ready' : 'pending',
      analysis_status: done === 0 ? 'none' : missing === 0 ? 'ready' : 'partial',
      timeline_count: Array.isArray(timeline?.timelines) ? timeline.timelines.length : 0,
    }
  }))
}

/** Execute the small, explicitly supported set of edits the workbench exposes. */
async function applyTimelineOperation(video: VideoWorkspace, operation: unknown): Promise<unknown> {
  if (operation === null || typeof operation !== 'object') throw new RouteError(400, 'an edit operation is required')
  const candidate = operation as { tool?: unknown, args?: unknown }
  if (typeof candidate.tool !== 'string' || candidate.args === null || typeof candidate.args !== 'object') {
    throw new RouteError(400, 'an edit tool and arguments are required')
  }
  const args = candidate.args as Record<string, unknown>
  const timelineId = typeof args.timeline_id === 'string' ? args.timeline_id : ''
  const revision = Number(args.base_revision)
  const ordinal = Number(args.ordinal)
  const requiredRevision = (): { timeline_id: string, base_revision: number, ordinal: number } => {
    if (timelineId === '' || !Number.isInteger(revision) || !Number.isInteger(ordinal)) throw new RouteError(400, 'timeline_id, base_revision, and ordinal are required')
    return { timeline_id: timelineId, base_revision: revision, ordinal }
  }
  switch (candidate.tool) {
    case 'video_timeline_split': {
      const base = requiredRevision(); const assetTime = Number(args.asset_time_us)
      if (!Number.isFinite(assetTime)) throw new RouteError(400, 'asset_time_us is required')
      return video.splitSegment({ ...base, asset_time_us: assetTime })
    }
    case 'video_timeline_merge': return video.mergeSegments(requiredRevision())
    case 'video_timeline_remove': return video.removeSegment(requiredRevision())
    case 'video_timeline_trim': {
      const base = requiredRevision(); const edge = args.edge; const delta = Number(args.delta_us)
      if ((edge !== 'start' && edge !== 'end') || !Number.isFinite(delta)) throw new RouteError(400, 'edge and delta_us are required')
      return video.trimSegment({ ...base, edge, delta_us: delta })
    }
    case 'video_timeline_reorder': {
      if (timelineId === '' || !Number.isInteger(revision) || !Number.isInteger(Number(args.from)) || !Number.isInteger(Number(args.to))) throw new RouteError(400, 'timeline_id, base_revision, from, and to are required')
      return video.reorderSegment({ timeline_id: timelineId, base_revision: revision, from: Number(args.from), to: Number(args.to) })
    }
    case 'video_timeline_adjust': {
      const base = requiredRevision(); const speed = args.speed === undefined ? undefined : Number(args.speed); const muted = args.muted
      if ((speed !== undefined && !Number.isFinite(speed)) || (muted !== undefined && typeof muted !== 'boolean')) throw new RouteError(400, 'speed or muted is invalid')
      return video.adjustSegment({ ...base, ...(speed === undefined ? {} : { speed }), ...(muted === undefined ? {} : { muted }) })
    }
    case 'video_timeline_name_segment': {
      const base = requiredRevision(); if (typeof args.name !== 'string') throw new RouteError(400, 'name is required')
      return video.nameSegment({ ...base, name: args.name })
    }
    case 'video_timeline_add': {
      if (timelineId === '' || !Number.isInteger(revision) || typeof args.asset_id !== 'string') throw new RouteError(400, 'timeline_id, base_revision, and asset_id are required')
      const start = Number(args.start_us); const end = Number(args.end_us)
      const speed = args.speed === undefined ? undefined : Number(args.speed)
      if (!Number.isFinite(start) || !Number.isFinite(end) || (speed !== undefined && !Number.isFinite(speed))) throw new RouteError(400, 'start_us, end_us, or speed is invalid')
      return video.addSegment({ timeline_id: timelineId, base_revision: revision, asset_id: args.asset_id, start_us: start, end_us: end, ...(speed === undefined ? {} : { speed }) })
    }
    case 'video_timeline_insert': {
      if (timelineId === '' || !Number.isInteger(revision) || typeof args.asset_id !== 'string' || !Number.isInteger(ordinal)) throw new RouteError(400, 'timeline_id, base_revision, asset_id, and ordinal are required')
      const start = Number(args.start_us); const end = Number(args.end_us)
      const speed = args.speed === undefined ? undefined : Number(args.speed)
      if (!Number.isFinite(start) || !Number.isFinite(end) || (speed !== undefined && !Number.isFinite(speed))) throw new RouteError(400, 'start_us, end_us, or speed is invalid')
      return video.insertSegment({ timeline_id: timelineId, base_revision: revision, asset_id: args.asset_id, start_us: start, end_us: end, ordinal, ...(speed === undefined ? {} : { speed }) })
    }
    case 'video_timeline_revert': {
      const target = Number(args.target_revision)
      if (timelineId === '' || !Number.isInteger(revision) || !Number.isInteger(target)) throw new RouteError(400, 'timeline_id, base_revision, and target_revision are required')
      return video.revertTimeline({ timeline_id: timelineId, base_revision: revision, target_revision: target })
    }
    default: throw new RouteError(400, 'this edit is not supported by the workbench')
  }
}

/** Product-facing project, asset, and browser-import route. */
export function workspaceRoute(video: VideoWorkspace, dataDir: string, maxImportBytes: number): WebRoute {
  return {
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      try {
        const parts = pathParts(req, PREFIX)
        if (req.method === 'GET' && parts.length === 1 && parts[0] === 'projects') {
          json(res, 200, await video.projects())
          return
        }
        if (req.method === 'POST' && parts.length === 1 && parts[0] === 'projects') {
          const parsed = JSON.parse(await body(req)) as { name?: unknown }
          const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
          if (name === '') { json(res, 400, { error: 'project name is required' }); return }
          const id = `project-${randomUUID()}`
          json(res, 201, { ...(await video.createProject(id, name)), asset_count: 0 })
          return
        }
        if (req.method === 'GET' && parts.length === 2 && parts[0] === 'assets' && parts[1] === 'recent') {
          const projects = await video.projects()
          const recent = (await Promise.all(projects.map(project => summaries(video, String(project.id), dataDir)))).flat()
          json(res, 200, recent.slice(0, 20))
          return
        }
        if (parts.length === 3 && parts[0] === 'projects' && parts[2] === 'assets' && req.method === 'GET') {
          const projectId = parts[1]
          if (projectId === undefined) { json(res, 404, { error: 'project not found' }); return }
          const projects = await video.projects()
          if (!projects.some(project => String(project.id) === projectId)) { json(res, 404, { error: 'project not found' }); return }
          json(res, 200, await summaries(video, projectId, dataDir))
          return
        }
        if (parts.length === 5 && parts[0] === 'projects' && parts[2] === 'assets' && parts[4] === 'thumbnail' && req.method === 'GET') {
          const projectId = parts[1]
          const assetId = parts[3]
          if (projectId === undefined || assetId === undefined) { json(res, 404, { error: 'asset not found' }); return }
          const asset = (await video.assets(projectId)).find(item => String(item.id) === assetId)
          if (asset === undefined) { json(res, 404, { error: 'asset not found' }); return }
          const thumbnailPath = join(dataDir, 'thumbnails', `${assetId}.jpg`)
          if (!existsSync(thumbnailPath)) { json(res, 404, { error: 'thumbnail not ready' }); return }
          const image = await readFile(thumbnailPath)
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(image.byteLength), 'Cache-Control': 'public, max-age=3600' })
          res.end(image)
          return
        }
        if (parts.length === 5 && parts[0] === 'projects' && parts[2] === 'assets' && parts[4] === 'timeline' && req.method === 'POST') {
          const projectId = parts[1]
          const assetId = parts[3]
          if (projectId === undefined || assetId === undefined) { json(res, 404, { error: 'asset not found' }); return }
          const asset = (await video.assets(projectId)).find(item => String(item.id) === assetId) as { id?: unknown, duration_us?: unknown } | undefined
          if (asset === undefined) { json(res, 404, { error: 'asset not found' }); return }
          const durationUs = Number(asset.duration_us)
          if (!Number.isFinite(durationUs) || durationUs <= 0) { json(res, 422, { error: 'asset duration is not available' }); return }
          const timeline = await video.createTimeline({
            id: `timeline-${randomUUID()}`,
            name: '原片预览',
            project_id: projectId,
            asset_id: assetId,
            start_us: 0,
            end_us: Math.round(durationUs),
          })
          json(res, 201, timeline)
          return
        }
        if (parts.length === 6 && parts[0] === 'projects' && parts[2] === 'assets' && parts[4] === 'timeline' && parts[5] === 'operations' && req.method === 'POST') {
          const projectId = parts[1]
          const assetId = parts[3]
          if (projectId === undefined || assetId === undefined) throw new RouteError(404, 'asset not found')
          const asset = (await video.assets(projectId)).find(item => String(item.id) === assetId)
          if (asset === undefined) throw new RouteError(404, 'asset not found')
          const operation = JSON.parse(await body(req)) as { operation_id?: unknown, args?: { timeline_id?: unknown } }
          const timelineId = operation.args?.timeline_id
          if (typeof timelineId !== 'string' || timelineId === '') throw new RouteError(400, 'timeline_id is required')
          const owned = await video.timelinesForAsset(projectId, assetId) as { timelines?: Array<{ id?: unknown }> } | null
          if (owned?.timelines?.some(timeline => timeline.id === timelineId) !== true) throw new RouteError(404, 'timeline not found for this asset')
          const operationId = operation.operation_id
          if (operationId !== undefined && (typeof operationId !== 'string' || operationId.trim() === '' || operationId.length > 200)) throw new RouteError(400, 'operation_id is invalid')
          if (typeof operationId === 'string') {
            const previous = await video.operationResult(timelineId, operationId, operation)
            if (previous !== null) { json(res, 200, previous); return }
          }
          const result = await applyTimelineOperation(video, operation)
          if (typeof operationId === 'string') await video.rememberOperation(timelineId, operationId, operation, result as Record<string, unknown>)
          json(res, 200, result)
          return
        }
        if (parts.length === 7 && parts[0] === 'projects' && parts[2] === 'assets' && parts[4] === 'timeline' && parts[6] === 'render' && req.method === 'POST') {
          const projectId = parts[1]
          const assetId = parts[3]
          const timelineId = parts[5]
          if (projectId === undefined || assetId === undefined || timelineId === undefined) throw new RouteError(404, 'timeline not found')
          const asset = (await video.assets(projectId)).find(item => String(item.id) === assetId)
          if (asset === undefined) throw new RouteError(404, 'asset not found')
          const owned = await video.timelinesForAsset(projectId, assetId) as { timelines?: Array<{ id?: unknown }> } | null
          if (owned?.timelines?.some(timeline => timeline.id === timelineId) !== true) throw new RouteError(404, 'timeline not found for this asset')
          const options = JSON.parse(await body(req)) as { filename?: unknown, aspect?: unknown, burn_subtitles?: unknown }
          const aspect = options.aspect
          const subtitles = options.burn_subtitles
          if (aspect !== undefined && aspect !== 'keep' && aspect !== '16:9' && aspect !== '9:16' && aspect !== '1:1') throw new RouteError(400, 'aspect is invalid')
          if (subtitles !== undefined && subtitles !== 'transcript' && subtitles !== 'screen-text') throw new RouteError(400, 'burn_subtitles is invalid')
          json(res, 202, await video.submitRender(timelineId, typeof options.filename === 'string' ? options.filename : undefined, {
            ...(aspect === undefined ? {} : { aspect }),
            ...(subtitles === undefined ? {} : { burnSubtitles: subtitles }),
          }))
          return
        }
        if (parts.length === 5 && parts[0] === 'projects' && parts[2] === 'exports' && parts[4] === 'cancel' && req.method === 'POST') {
          const projectId = parts[1]
          const jobId = parts[3]
          if (projectId === undefined || jobId === undefined) throw new RouteError(404, 'export not found')
          json(res, 200, await video.cancelRender(projectId, jobId))
          return
        }
        if (parts.length === 3 && parts[0] === 'projects' && parts[2] === 'import' && req.method === 'POST') {
          const projectId = parts[1]
          if (projectId === undefined) { json(res, 404, { error: 'project not found' }); return }
          const projects = await video.projects()
          if (!projects.some(project => String(project.id) === projectId)) { json(res, 404, { error: 'project not found' }); return }
          const tempDir = join(dataDir, 'browser-imports')
          await mkdir(tempDir, { recursive: true, mode: 0o700 })
          const file = await streamMultipartFile(req, tempDir, maxImportBytes)
          const tempPath = join(tempDir, `${randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`)
          const previewPath = `${tempPath}.jpg`
          try {
            await rename(file.path, tempPath)
            try {
              await execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', tempPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', previewPath])
            } catch { /* the asset remains importable; the list falls back to a file icon */ }
            const imported = await video.import(projectId, tempPath)
            if (existsSync(previewPath)) {
              const thumbnailDir = join(dataDir, 'thumbnails')
              await mkdir(thumbnailDir, { recursive: true, mode: 0o700 })
              await rename(previewPath, join(thumbnailDir, `${String(imported.id)}.jpg`))
            }
            const records = await summaries(video, projectId, dataDir)
            const summary = records.find(record => (record as { id?: string }).id === imported.id)
            json(res, 201, summary ?? imported)
          } finally {
            await rm(tempPath, { force: true })
            await rm(previewPath, { force: true })
          }
          return
        }
        json(res, 404, { error: 'workspace route not found' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A stale timeline is not malformed input.  The client needs a distinct 409 so it
        // can reload the canonical timeline instead of showing a generic save failure.
        const status = error instanceof RouteError ? error.status : message.startsWith('revision conflict:') ? 409 : 400
        json(res, status, { error: message, ...(status === 409 ? { code: 'REVISION_CONFLICT' } : {}) })
      }
    },
  }
}
