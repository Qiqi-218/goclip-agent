/**
 * The read-only route that serves media bytes to the browser.
 *
 * The video workbench plays an asset in a `<video>` element, which needs an HTTP address it
 * can send `Range` requests against. Nothing else in the harness serves media, so this plugin
 * registers its own route through `webServer`, the documented route registration service.
 *
 * Two properties of OSS shape this implementation, both measured rather than assumed
 * (see `probe-oss-range.mjs`):
 *
 * - **A signature covers the HTTP method.** A URL signed for GET is refused with 403 when
 *   answered to HEAD, so a HEAD request needs its own signature.
 * - **OSS does not report an unsatisfiable range.** A `Range` whose start is at or past the
 *   object length is ignored and answered with the whole object at 200. Forwarding that
 *   unchanged would send a caller that asked for one kilobyte the entire file, so this route
 *   decides satisfiability itself and answers 416 without asking OSS.
 *
 * Addresses are resolved to object keys by the runtime, which looks the asset or render up in
 * the database first. A caller therefore cannot name an object outside its own project, and
 * an unknown project or asset is indistinguishable from one the caller may not read.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/** What one media request resolved to. */
export interface MediaTarget {
  /** OSS object key to stream. */
  readonly key: string
  /** Content type to report; OSS also sends one, which is preferred when present. */
  readonly contentType: string
}

/**
 * The workbench's read side: the measured curve, as JSON.
 *
 * The workbench is a root-scoped central panel and therefore holds no Session
 * binding, so it cannot read tool results the way a Session-scoped panel does. It
 * asks the host for what it draws instead, addressed by project and asset.
 */
export interface MediaData {
  /**
   * The loudness curve for one asset, or null when that dimension was not measured.
   *
   * @param path - path segments after the route prefix.
   * @returns The curve as the browser consumes it, or null when nothing matches.
   */
  loudness(path: readonly string[]): Promise<unknown | null>
  /**
   * The timelines cut from one asset, oldest first, with their clips.
   *
   * @param path - path segments after the route prefix.
   * @returns The timelines as the browser consumes them, or null when nothing matches.
   */
  timelines(path: readonly string[]): Promise<unknown | null>
  /**
   * The finished films rendered from one asset, newest first.
   *
   * @param path - path segments after the route prefix.
   * @returns The renders as the browser consumes them, or null when nothing matches.
   */
  renders(path: readonly string[]): Promise<unknown | null>
  /**
   * Every measured evidence dimension for one asset, in one answer.
   *
   * One reader for all six rather than one per kind: the surface draws them on a single axis and
   * needs them together, so six requests would only add six chances to disagree about which asset
   * is being shown. A dimension that was never measured is absent from the answer rather than
   * empty, which is what lets the surface say "not measured" instead of drawing nothing.
   *
   * @param path - path segments after the route prefix.
   * @returns The tracks as the browser consumes them, or null when nothing matches.
   */
  evidence(path: readonly string[]): Promise<unknown | null>
  /**
   * The revisions recorded for one timeline.
   *
   * Addresses <projectId>/<assetId>/<timelineId> rather than the asset alone: history belongs to
   * a timeline, and an asset can carry several. The extra segment is why this reader is separate
   * from vidence, which is keyed by asset.
   *
   * @param path - path segments after the route prefix.
   * @returns The revisions, or null when nothing matches.
   */
  history(path: readonly string[]): Promise<unknown | null>
}

/** Resolving an address, signing a key for one method, and reading measurements. */
export interface MediaSource extends MediaData {
  /**
   * Resolve one address to the object it names.
   *
   * @param path - path segments after the route prefix.
   * @returns The target, or `null` when nothing matches.
   */
  resolve(path: readonly string[]): Promise<MediaTarget | null>
  /**
   * A time-limited URL for one object, signed for the method it will be used with.
   *
   * @param key - OSS object key.
   * @param method - HTTP method the URL will be used with.
   * @returns The signed URL.
   */
  sign(key: string, method: 'GET' | 'HEAD'): string
}

/** One parsed byte range request, or a refusal that needs no upstream call. */
type RangeRequest =
  | { readonly kind: 'none' }
  | { readonly kind: 'unsatisfiable' }
  | { readonly kind: 'ok', readonly header: string, readonly from: number, readonly to: number }

/**
 * Parse one `Range` header against a known object length.
 *
 * Only the single-range `bytes=` form is served. A multi-range request is answered with the
 * whole object, which RFC 9110 permits and which costs the caller nothing but a longer
 * transfer; browsers send single ranges for media playback.
 *
 * `bytes=N-` and `bytes=N-M` are both accepted, and `M` past the end is clamped rather than
 * refused, which is the behaviour a browser relies on when it does not know the length yet.
 *
 * @param header - the raw header value, or undefined when absent.
 * @param size - object length in bytes.
 * @returns What to forward, or that the request is unsatisfiable or has no range at all.
 */
export function parseRangeHeader(header: string | undefined, size: number): RangeRequest {
  if (header === undefined || header.trim() === '') return { kind: 'none' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return { kind: 'none' }
  const [, rawFrom, rawTo] = match
  if (rawFrom === '' && rawTo === '') return { kind: 'none' }
  // A suffix range (`bytes=-500`) counts back from the end and cannot satisfy an empty object.
  if (rawFrom === '') {
    const want = Number(rawTo)
    if (want === 0 || size === 0) return { kind: 'unsatisfiable' }
    const from = Math.max(0, size - want)
    return { kind: 'ok', header: `bytes=${from}-${size - 1}`, from, to: size - 1 }
  }
  const from = Number(rawFrom)
  if (from >= size) return { kind: 'unsatisfiable' }
  const to = rawTo === '' ? size - 1 : Math.min(Number(rawTo), size - 1)
  if (to < from) return { kind: 'unsatisfiable' }
  return { kind: 'ok', header: `bytes=${from}-${to}`, from, to }
}

/** Write a response with no body and finish it. */
function sendStatus(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers)
  res.end()
}

/**
 * Serve one media request: resolve, decide the range, forward to OSS, stream back.
 *
 * @param source - resolver and signer for the deployment.
 * @param path - path segments after the route prefix.
 * @param req - the incoming request, read for its `Range` header.
 * @param res - the response, which this function owns until it finishes.
 */
async function serve(source: MediaSource, path: readonly string[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    sendStatus(res, 405, { Allow: 'GET, HEAD' })
    return
  }
  // Project and asset segments are opaque ids; anything else about the path is not addressable.
  const target = await source.resolve(path)
  if (target === null) {
    // Deliberately the same answer for "no such asset" and "not yours": an address must not
    // reveal whether an object exists.
    sendStatus(res, 404)
    return
  }

  // The length is required before a range can be judged, and the probe showed OSS will not
  // judge it. HEAD also yields the content type OSS itself reports, which is more accurate
  // than anything guessed from the file extension.
  let size: number
  let contentType = target.contentType
  try {
    const head = await fetch(source.sign(target.key, 'HEAD'), { method: 'HEAD' })
    if (!head.ok) { sendStatus(res, 502); return }
    const length = Number(head.headers.get('content-length'))
    if (!Number.isFinite(length) || length < 0) { sendStatus(res, 502); return }
    size = length
    contentType = head.headers.get('content-type') ?? contentType
  } catch {
    // A refused or unreachable OSS is an upstream failure, not a missing object.
    sendStatus(res, 502)
    return
  }

  const range = parseRangeHeader(req.headers.range, size)
  if (range.kind === 'unsatisfiable') {
    sendStatus(res, 416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
    return
  }

  const headers: Record<string, string> = { 'Accept-Ranges': 'bytes', 'Content-Type': contentType }
  if (range.kind === 'ok') {
    headers['Content-Range'] = `bytes ${range.from}-${range.to}/${size}`
    headers['Content-Length'] = String(range.to - range.from + 1)
  } else {
    headers['Content-Length'] = String(size)
  }

  if (method === 'HEAD') {
    // A HEAD response carries the headers and no body, and must not open an upstream GET.
    sendStatus(res, range.kind === 'ok' ? 206 : 200, headers)
    return
  }

  // Forward the caller's range verbatim: OSS truncates at exactly the byte the caller asked
  // for, so the response body already has the requested length and needs no local slicing.
  const upstream = new AbortController()
  // The browser abandons a stream whenever the viewer seeks or closes the tab. Without this
  // the OSS connection would stay open until the whole object had been read.
  const abort = (): void => upstream.abort()
  res.on('close', abort)
  // An aborted response emits an error; nothing here can act on it, and an unhandled 'error'
  // on a ServerResponse would take the process down.
  res.on('error', () => upstream.abort())
  try {
    const response = await fetch(source.sign(target.key, 'GET'), {
      headers: range.kind === 'ok' ? { Range: range.header } : {},
      signal: upstream.signal,
    })
    if (!response.ok || response.body === null) {
      if (!res.headersSent) sendStatus(res, 502)
      return
    }
    res.writeHead(range.kind === 'ok' ? 206 : 200, headers)
    // `pipeline` accepts an async iterable, which the fetch body is. `Readable.fromWeb` would
    // need the DOM stream type and Node's overload does not accept this one.
    await pipeline(response.body, res)
  } catch (error) {
    // An aborted client is the ordinary way a stream ends, not a failure to report.
    if (upstream.signal.aborted) return
    if (!res.headersSent) sendStatus(res, 502)
    // A throw with the headers already sent means the body failed midway; the only honest
    // signal left is to break the connection so the caller does not treat it as complete.
    else res.destroy()
    throw error
  } finally {
    res.off('close', abort)
  }
}

/**
 * Answer one measurement request: resolve, read, serialise.
 *
 * @param source - resolver and reader for the deployment.
 * @param path - path segments after the route's data marker.
 * @param req - the incoming request, checked for its method.
 * @param res - the response, which this function owns until it finishes.
 */
async function serveData(source: MediaData, path: readonly string[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    sendStatus(res, 405, { Allow: 'GET, HEAD' })
    return
  }
  let body: unknown | null
  try {
    // The dimension is the last segment and says which reader to use, so one route
    // answers every measurement instead of one route per dimension.
    const dimension = path[path.length - 1]
    const rest = path.slice(0, -1)
    if (dimension === 'loudness') body = await source.loudness(rest)
    else if (dimension === 'timelines') body = await source.timelines(rest)
    else if (dimension === 'renders') body = await source.renders(rest)
    else if (dimension === 'evidence') body = await source.evidence(rest)
    else if (dimension === 'history') body = await source.history(rest)
    else body = null
  } catch (error) {
    sendStatus(res, 502)
    return
  }
  // A dimension that was never measured is a 404, not an empty curve: the caller must
  // be able to tell "not computed yet" apart from "computed and silent".
  if (body === null) {
    sendStatus(res, 404)
    return
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.byteLength),
    // Measurements change only when evidence is recomputed, so let the browser hold it
    // briefly; the workbench refetches when the asset changes.
    'Cache-Control': 'no-cache',
  })
  res.end(method === 'HEAD' ? undefined : payload)
}

/**
 * Build the media route for one deployment.
 *
 * Three address forms, all below one prefix:
 * - `<projectId>/<assetId>` streams the imported asset.
 * - `<projectId>/<assetId>/render/<jobId>` streams a finished film.
 * - `data/<projectId>/<assetId>/loudness` returns the measured curve as JSON.
 *
 * @param source - resolver, signer, and measurement reader.
 * @param prefix - absolute path prefix, no trailing slash.
 * @returns The route to register with `webServer`.
 */
export function mediaRoute(source: MediaSource, prefix: string): WebRoute {
  const base = prefix.replace(/\/+$/, '')
  return {
    kind: 'prefix',
    path: base,
    handler: (req, res) => {
      // A prefix route also receives the bare prefix, which names nothing.
      // The query string carries no meaning here, so it is cut before the segments are read.
      const pathname = (req.url ?? '').split('?').at(0) ?? ''
      const rest = pathname.slice(base.length).replace(/^\/+/, '')
      let path: string[]
      try {
        path = rest === '' ? [] : rest.split('/').map(segment => decodeURIComponent(segment))
      } catch {
        sendStatus(res, 400)
        return
      }
      // `data` is reserved: an asset id could otherwise be spelled `data` and shadow the
      // measurement form, making which one answers depend on a naming coincidence.
      if (path[0] === DATA_SEGMENT) return serveData(source, path.slice(1), req, res)
      return serve(source, path, req, res)
    },
  }
}

/** Reserved first segment that selects the JSON read side rather than a byte stream. */
const DATA_SEGMENT = 'data'
