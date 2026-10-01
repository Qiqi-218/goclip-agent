/**
 * Deployment settings for the video workspace bundle.
 *
 * Every value the operator may need to change without editing TypeScript lives
 * here; nothing in the tool bodies carries a hardcoded endpoint or limit. The
 * exported `Config` is both the setting shape and the schema cordis validates a
 * profile's `config:` block against, matching every other tool plugin here.
 */

import z from '@deepseek-ai/schemastery'

/** Where the local video-agent service listens and how long one call may take. */
export interface Config {
  /**
   * Base URL of the video-agent HTTP service. The service owns asset storage,
   * evidence, timelines and ffmpeg rendering, and binds the loopback interface
   * by default because the competition forbids a workload reachable only by
   * publishing a local instance.
   */
  endpoint: string
  /**
   * Deadline for one action call in milliseconds. `analyze` and `find_in_video`
   * drive a vision model once per sampled frame, so the default is generous.
   */
  timeoutMs: number
  /**
   * Fraction of a frame's pixel count kept when a frame is handed back to the
   * model as an image, or 0 to hand back no image at all. Reading the frame the
   * vision model actually judged is what makes a visual verdict auditable, and
   * it costs image tokens, so the operator chooses the trade-off.
   */
  framePreviewScale: number
  /**
   * Bearer token sent on every action call, for a deployment whose service
   * requires one. It must equal the service's `VIDEO_AGENT_SHARED_SECRET`.
   *
   * The action routes change stored state, so a service reachable from anywhere
   * other than this machine requires this. Empty, the default, matches a service
   * started without a token, which is how local development runs.
   */
  authToken: string
}

/** Schemastery schema for {@link Config}; every field is required and explicit. */
export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  timeoutMs: z.number().required(),
  framePreviewScale: z.number().required(),
  authToken: z.string().default(''),
})
