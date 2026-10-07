/**
 * @deepseek-ai/dsh-host-webserver — node:http route registration with optional
 * gzip, index injection, and one fallback seat. It knows no harness concepts
 * and serves no files; the composing application owns dist serving. Electron
 * uses file:// plus IPC instead, and this package never prints the URL.
 * Route handlers retain direct response ownership.
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import compressionMiddleware from 'compression'
import Negotiator from 'negotiator'
import { renderIndexInjections, type IndexInjection } from './injections.ts'

export { renderIndexInjections } from './injections.ts'
export type { IndexInjection, IndexInjectionPlacement } from './injections.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
  interface Events {
    /**
     * Collect the structured index injection table. Emitted on every index
     * render and every worker boot-payload request; listeners push their
     * current rows, so a row's data is read fresh at emit time.
     * @param table - Mutable row table; listeners append in activation order.
     * @mode emit
     */
    'webserver/index-inject'(table: IndexInjection[]): void
  }
}

/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix'

/** One named route registration. */
export interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/** Web server listen and response-compression config. */
export interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /** Response compression for socket-backed HTTP requests. @default 'none' */
  compression?: 'none' | 'gzip'
  /** Gzip DEFLATE level from 0 through 9. @default 1 */
  compressionLevel?: number
  /** Minimum known response length eligible for gzip; unknown-length streams are eligible. @default 1024 */
  compressionThresholdBytes?: number
}

const DEFAULT_COMPRESSION = 'none' as const
const DEFAULT_COMPRESSION_LEVEL = 1
const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024

function safeReturnPath(value: string): string {
  // Only retain an origin-relative destination. Never let the login form turn
  // into an open redirect when someone crafts its hidden `next` field.
  if (!value.startsWith('/') || value.startsWith('//')) return '/'
  try {
    const parsed = new URL(value, 'http://goclip.local')
    return parsed.origin === 'http://goclip.local' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/'
  } catch {
    return '/'
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

interface ResolvedConfig extends Config {
  compression: 'none' | 'gzip'
  compressionLevel: number
  compressionThresholdBytes: number
}

type NodeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void

function createGzipMiddleware(config: ResolvedConfig): NodeMiddleware {
  // `compression` is typed for Express, but its runtime uses only the
  // node:http request and response members supplied here.
  const middleware = compressionMiddleware({
    level: config.compressionLevel,
    threshold: config.compressionThresholdBytes,
    filter(request, response) {
      if (response.getHeader('content-range') !== undefined) return false
      const contentType = response.getHeader('content-type')
      if (typeof contentType === 'string' && contentType.toLowerCase().startsWith('text/event-stream')) return false
      if (typeof contentType === 'string' && /^multipart\/form-data(?:;|$)/i.test(contentType)) return true
      return compressionMiddleware.filter(request, response)
    },
  }) as NodeMiddleware

  return (req, res, next) => {
    // The Web Worker tunnel has no socket and transfers identity bytes.
    if ((res as { socket?: unknown }).socket === undefined) {
      next()
      return
    }
    const encoding = new Negotiator(req).encoding(['gzip', 'identity'])
    const gzipRequest = Object.create(req) as IncomingMessage
    Object.defineProperty(gzipRequest, 'headers', {
      value: { ...req.headers, 'accept-encoding': encoding === 'gzip' ? 'gzip' : 'identity' },
    })
    middleware(gzipRequest, res, next)
  }
}

/**
 * The browser HTTP carrier service. Activation listens immediately. Route
 * registration order does not affect requests because configured named routes
 * must be distinct, and the fallback handler answers anything not yet claimed
 * during startup with 404 until its owner registers. A listen failure rejects
 * initialization, and the boot process reports the failed fiber.
 */
export class WebServer extends Service {
  static Config: z<Config> = z.object({
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
    port: z.natural().max(65535).required(),
    compression: z.union([z.const('none'), z.const('gzip')]).default(DEFAULT_COMPRESSION),
    compressionLevel: z.number().step(1).min(0).max(9).default(DEFAULT_COMPRESSION_LEVEL),
    compressionThresholdBytes: z.natural().default(DEFAULT_COMPRESSION_THRESHOLD_BYTES),
  })

  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly upgrades = new Map<string, WebUpgradeRoute>()
  private readonly upgradedSockets = new Set<Duplex>()
  private readonly indexTaps: ((html: string) => string)[] = []
  private fallback: WebRoute['handler'] | undefined
  private server!: Server
  private listenedPort!: number
  private readonly gzip: NodeMiddleware | undefined
  private readonly authUsername: string | undefined
  private readonly authPassword: string | undefined
  private readonly sessions = new Map<string, number>()

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'webServer')
    const resolved = config as ResolvedConfig
    this.gzip = resolved.compression === 'gzip' ? createGzipMiddleware(resolved) : undefined
    const username = process.env.GOCLIP_WEB_USERNAME ?? ''
    const password = process.env.GOCLIP_WEB_PASSWORD ?? ''
    if ((username === '') !== (password === '')) {
      throw new Error('webserver: GOCLIP_WEB_USERNAME and GOCLIP_WEB_PASSWORD must be configured together')
    }
    this.authUsername = username === '' ? undefined : username
    this.authPassword = username === '' ? undefined : password
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (this.authUsername === undefined) return true
    const cookies = req.headers.cookie ?? ''
    const match = cookies.match(/(?:^|;\s*)goclip_session=([a-f0-9]{64})(?:;|$)/u)
    if (match === null) return false
    const expiresAt = this.sessions.get(match[1]!)
    if (expiresAt === undefined) return false
    if (expiresAt <= Date.now()) {
      this.sessions.delete(match[1]!)
      return false
    }
    return true
  }

  private async readLoginBody(req: IncomingMessage): Promise<URLSearchParams | undefined> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > 8192) return undefined
      chunks.push(buffer)
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const values = await this.readLoginBody(req)
    const username = Buffer.from(values?.get('username') ?? '')
    const password = Buffer.from(values?.get('password') ?? '')
    const expectedUsername = Buffer.from(this.authUsername ?? '')
    const expectedPassword = Buffer.from(this.authPassword ?? '')
    const valid = username.length === expectedUsername.length
      && password.length === expectedPassword.length
      && timingSafeEqual(username, expectedUsername)
      && timingSafeEqual(password, expectedPassword)
    if (!valid) {
      this.renderLogin(res, values?.get('next') ?? '/', '账号或密码不正确，请重试。')
      return
    }

    const token = randomBytes(32).toString('hex')
    this.sessions.set(token, Date.now() + 12 * 60 * 60 * 1000)
    // Bound memory if a long-running server receives many logins.
    if (this.sessions.size > 1000) {
      const now = Date.now()
      for (const [key, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(key)
      while (this.sessions.size > 1000) this.sessions.delete(this.sessions.keys().next().value!)
    }
    const next = safeReturnPath(values?.get('next') ?? '/')
    res.writeHead(303, {
      location: next,
      'set-cookie': `goclip_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${(req.socket as { encrypted?: boolean }).encrypted ? '; Secure' : ''}`,
      'cache-control': 'no-store',
    })
    res.end()
  }

  private renderLogin(res: ServerResponse, next: string, error = ''): void {
    const safeNext = escapeHtml(safeReturnPath(next))
    const message = error === '' ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>登录 · GoClip</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#171717;background:#fff;font-synthesis:none}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}.login{width:min(100%,360px)}h1{margin:0 0 6px;font-size:24px;font-weight:600;letter-spacing:-.03em}.hint{margin:0 0 28px;color:#737373;font-size:14px}label{display:block;margin:18px 0 7px;font-size:13px;font-weight:500}input{width:100%;height:42px;padding:0 12px;border:1px solid #d4d4d4;border-radius:8px;background:#fff;color:#171717;font:inherit;outline:none}input:focus{border-color:#171717;box-shadow:0 0 0 2px #17171714}button{width:100%;height:42px;margin-top:22px;border:0;border-radius:8px;background:#171717;color:#fff;font:inherit;font-size:14px;font-weight:500;cursor:pointer}button:hover{background:#343434}.error{margin:0 0 14px;color:#c62828;font-size:13px}@media(prefers-color-scheme:dark){:root{color:#f5f5f5;background:#151515}input{border-color:#444;background:#202020;color:#f5f5f5}input:focus{border-color:#d4d4d4;box-shadow:0 0 0 2px #ffffff14}button{background:#f5f5f5;color:#171717}button:hover{background:#d4d4d4}.hint{color:#a3a3a3}}
</style></head><body><main class="login"><h1>GoClip</h1><p class="hint">登录剪辑工作台</p>${message}<form method="post" action="/__goclip/login"><input type="hidden" name="next" value="${safeNext}"><label for="username">账号</label><input id="username" name="username" autocomplete="username" required autofocus><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">登录</button></form></main></body></html>`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(html)) })
    res.end(html)
  }

  /** The listening port (the OS-assigned value when config.port is 0). */
  get port(): number {
    return this.listenedPort
  }

  /** The configured bind host (the loopback or all-interfaces literal). */
  get host(): Config['host'] {
    return this.config.host
  }

  /**
   * Register a named route. Duplicate (kind, path) throws — route patterns are
   * a composition-level contract, so a collision is a misconfiguration.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /**
   * Register an exact-path HTTP upgrade route. Duplicate paths throw because
   * one socket can have only one protocol owner.
   * @param route - pathname and handler owning negotiation plus socket use.
   * @returns the disposer removing the route.
   */
  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) {
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    }
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  /**
   * Claim the fallback seat: the handler answering every request no named
   * route matches (the SPA dist server in the shipped Web composition). One
   * owner only — a second registration throws, because two fallbacks cannot
   * compose.
   * @param handler - owns the full response lifecycle of unmatched requests.
   * @returns the disposer releasing the seat.
   */
  registerFallback(handler: WebRoute['handler']): () => void {
    if (this.fallback !== undefined) {
      throw new Error('webserver: fallback already registered')
    }
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  /**
   * Register a raw-HTML index transform, the escape hatch for markup no
   * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
   * registration order after rendering the structured rows.
   * @param transform - pure html-to-html function.
   * @returns the disposer removing the transform.
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
  async [Service.init](): Promise<void> {
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const requestUrl = new URL(req.url ?? '/', 'http://x')
      if (this.authUsername !== undefined && requestUrl.pathname === '/__goclip/login' && req.method === 'POST') {
        await this.login(req, res)
        return
      }
      if (!this.isAuthorized(req)) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          this.renderLogin(res, `${requestUrl.pathname}${requestUrl.search}`)
        } else {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('authentication required\n')
        }
        return
      }
      /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
      requests; the field is only optional on the client-side IncomingMessage type */
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const route = this.match(rawPath)
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      const fallback = this.fallback
      if (fallback === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      await fallback(req, res)
    }
    // Last-resort guard: handle() rejecting would otherwise be an unhandled
    // rejection killing the process on one malformed request (bad %-escape,
    // client dropping mid-body). Per-request failures log and answer 400 —
    // never a process exit.
    this.server = createServer((req, res) => {
      const next = (): void => {
        void handle(req, res).catch((err: unknown) => {
          this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)))
          if (res.headersSent) {
            res.destroy()
            return
          }
          res.writeHead(400)
          res.end()
        })
      }
      if (this.gzip === undefined) next()
      else this.gzip(req, res, next)
    })
    this.server.on('upgrade', (req, socket, head) => {
      const onError = (error: Error): void => {
        this.ctx.logger.warn(error)
        socket.destroy()
      }
      socket.on('error', onError)
      socket.once('close', () => {
        socket.off('error', onError)
        this.upgradedSockets.delete(socket)
      })
      let route: WebUpgradeRoute | undefined
      if (!this.isAuthorized(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      try {
        /* v8 ignore next -- node:http always sets url on server requests. */
        route = this.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
      } catch (error) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
        return
      }
      if (route === undefined) {
        socket.destroy()
        return
      }
      this.upgradedSockets.add(socket)
      try {
        Promise.resolve(route.handler(req, socket, head)).catch((error: unknown) => {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          socket.destroy()
        })
      } catch (error) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      }
    })

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject)
        this.server.on('error', (err) => { this.ctx.logger.error(err) })
        this.listenedPort = (this.server.address() as AddressInfo).port
        resolve()
      })
    })

    // Node does not include upgraded sockets in closeAllConnections(). The service
    // owns them with the other connections, so it tracks and destroys them explicitly.
    this.ctx.effect(() => async () => {
      const serverClosed = new Promise<void>((resolve) => {
        this.server.close(() => { resolve() })
      })
      this.server.closeAllConnections()
      const upgradedClosed = [...this.upgradedSockets].map(socket => new Promise<void>((resolve) => {
        socket.once('close', () => { resolve() })
        socket.destroy()
      }))
      await Promise.all([serverClosed, ...upgradedClosed])
    }, 'webServer.listen')
  }

  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  /**
   * Run an index.html body through the registered taps in registration order
   * — called by the fallback owner on every index response it renders.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }

  /**
   * Gather the structured injection table: one `webserver/index-inject` emit,
   * every subscriber pushes its current rows. Fresh per call, so subscribers
   * read live state (module graph, theme preference) at emit time.
   * @returns rows in subscriber activation order.
   */
  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = []
    this.ctx.emit('webserver/index-inject', table)
    return table
  }

  /**
   * Render one index.html body: the structured injection table first, then
   * the raw `tapIndex` transforms over the result.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  renderIndex(html: string): string {
    return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()))
  }
}

export default WebServer
