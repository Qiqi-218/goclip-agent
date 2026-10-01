/**
 * Typed HTTP client for the local video-agent service.
 *
 * The service answers every action with one envelope:
 * `{ api_version, ok, result?, error? }`. A non-`ok` envelope is a described
 * refusal the model can act on (an unknown asset id, a revision conflict), so it
 * is thrown as {@link VideoAgentError} carrying the service's own code and
 * message rather than flattened into a transport error.
 *
 * @module dsh-video-workspace/client
 */

import type { JsonValue as DshJsonValue } from '@deepseek-ai/dsh-util-values'

/** One action's refusal, as the service classified it. */
export interface ActionError {
  /** Stable machine-readable code, for example `not_found` or `conflict`. */
  readonly code: string
  /** Human-readable, Chinese, already phrased for the model to read. */
  readonly message: string
}

/** The service's response envelope. */
interface Envelope {
  readonly api_version?: string
  readonly ok?: boolean
  readonly result?: DshJsonValue
  readonly error?: ActionError
}

/**
 * A refusal the video-agent service described. The message is the service's own
 * wording, so it reaches the model unchanged.
 */
export class VideoAgentError extends Error {
  /** Stable service-side code. */
  readonly code: string

  /**
   * @param code - the service's error code.
   * @param message - the service's message.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'VideoAgentError'
    this.code = code
  }
}

/** How one call reaches the service. */
export interface ClientOptions {
  /** Base URL without a trailing slash. */
  readonly endpoint: string
  /** Deadline for one call in milliseconds. */
  readonly timeoutMs: number
  /**
   * Bearer token, for a deployment that requires one.
   *
   * The service's action routes change stored state, so a deployment that is
   * reachable from anywhere other than this machine requires a credential on
   * them. Empty means the service was started without one, which is how local
   * development runs.
   */
  readonly authToken?: string
}

/** One call outcome: the service's own words, plus the model-facing text. */
export interface CallResult {
  /**
   * The envelope's `result` value, or `null` when the action returned nothing.
   * Typed as the harness's lossless-JSON union because that is exactly what a
   * tool may return and what its output schema must accept.
   */
  readonly value: DshJsonValue
  /** Compact JSON of `value`, safe to place in a tool result. */
  readonly json: string
}

/**
 * Calls video-agent actions. One instance is stateless and may be shared by
 * every tool in the bundle.
 */
export class VideoAgentClient {
  private readonly options: ClientOptions

  /**
   * @param options - endpoint and per-call deadline.
   */
  constructor(options: ClientOptions) {
    this.options = options
  }

  /**
   * Invoke one action.
   * @param action - the action name, matching a case in the service's dispatch.
   * @param input - the action's input object.
   * @param signal - caller cancellation, combined with the configured deadline.
   * @returns the service's `result` and its JSON encoding.
   * @throws VideoAgentError when the service refuses the action.
   * @throws Error when the endpoint is unreachable or answers outside the protocol.
   */
  async call(action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<CallResult> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    const url = `${this.options.endpoint.replace(/\/+$/, '')}/v1/tools/${action}`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.options.authToken !== undefined && this.options.authToken !== '') {
      headers.authorization = `Bearer ${this.options.authToken}`
    }
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: combined,
      })
    } catch (error) {
      throw new Error(
        `无法连接剪辑服务 ${url}（${describe(error)}）。请确认 video-agent 已启动：`
        + '`video-agent --data <数据目录> serve --addr 127.0.0.1:8090`。',
      )
    }
    const text = await response.text()
    let envelope: Envelope
    try {
      envelope = JSON.parse(text) as Envelope
    } catch {
      throw new Error(`剪辑服务返回了非 JSON 响应（HTTP ${String(response.status)}）：${text.slice(0, 300)}`)
    }
    if (envelope.error !== undefined) {
      throw new VideoAgentError(envelope.error.code, envelope.error.message)
    }
    if (response.status === 401) {
      throw new Error(
        '剪辑服务要求访问令牌，但当前插件没有配置或配置不一致。'
        + '请让服务的 VIDEO_AGENT_SHARED_SECRET 与本插件的 authToken 取同一个值。',
      )
    }
    if (!response.ok || envelope.ok !== true) {
      throw new Error(`剪辑服务拒绝 ${action}（HTTP ${String(response.status)}）：${text.slice(0, 300)}`)
    }
    const value = envelope.result ?? null
    return { value, json: JSON.stringify(value, null, 2) }
  }
}

/**
 * Name a fetch failure in terms the operator can act on.
 * @param error - the rejection from `fetch`.
 * @returns a short cause, naming a deadline separately from an unreachable host.
 */
function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '超时'
    if (error.name === 'AbortError') return '已取消'
    const cause: unknown = error.cause
    if (cause instanceof Error && cause.message !== '') return `${error.message}：${cause.message}`
    return error.message
  }
  return String(error)
}
