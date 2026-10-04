/** Plugin configuration. Secrets are referenced through environment-variable names. */
import z from '@deepseek-ai/schemastery'

/** Storage, model and OSS settings for the native video tools. */
export interface Config {
  dataDir: string
  modelBaseUrl: string
  model: string
  apiKeyEnv: string
  ossEndpoint: string
  ossBucket: string
  ossAccessKeyIdEnv: string
  ossAccessKeySecretEnv: string
  ossPrefix: string
  ossOutputPrefix: string
  ossProjectPrefix: string
  signedUrlSeconds: number
  /**
   * Largest source file `video_import` accepts, in bytes.
   *
   * The upload itself streams from disk, so this bound guards against importing the
   * wrong file — a multi-hour recording picked by mistake — rather than against heap
   * use.
   */
  maxImportBytes: number
  /**
   * Deadline for one OSS request, in milliseconds.
   *
   * `restore` runs while the plugin is starting, so a bucket that accepts the
   * connection and then stops responding would otherwise stall the whole boot.
   */
  requestTimeoutMs: number
  /**
   * Deadline for one Qwen Omni request, in milliseconds.
   *
   * A full-video understanding call legitimately takes minutes, so this is far
   * larger than {@link requestTimeoutMs}; it exists to bound the wait, not to hurry
   * the model.
   */
  modelTimeoutMs: number
  /**
   * Most segments one `video_search` may return.
   *
   * A broad query over a long video can match hundreds of segments; the reply
   * reports the true match count so a truncated answer is visible rather than
   * silently incomplete.
   */
  searchLimit: number
  /**
   * Whether `video_import` leaves the file it imported in place.
   *
   * The import copies the file to OSS and by default removes the local original,
   * because OSS is the durable store and the local copy is redundant. That default
   * is destructive, so a deployment can keep the original instead; the tool result
   * always states which of the two happened, so the caller can tell the user.
   */
  keepSourceFiles: boolean
  /**
   * How far a cut may sit from a keyframe before the render re-encodes instead of
   * copying.
   *
   * A stream copy can only begin at a keyframe, so a source whose keyframes are farther
   * apart than this would otherwise yield a clip that starts before the requested time.
   */
  keyframeToleranceMs: number
  /**
   * Ceiling on one reply's output tokens, reasoning included.
   *
   * The model accepts up to 131,072, but its thinking is on by default and is billed
   * as output, so the ceiling has to cover both the reasoning and the JSON. Leaving it
   * unset lets the server pick, and a reply that hits a hidden limit is cut mid-object:
   * the JSON never closes and the failure reads as "the model did not return JSON".
   */
  maxOutputTokens: number
  /**
   * How hard the model thinks before answering, or `undefined` for the deployment default.
   *
   * Reasoning is billed as output, and a short lookup does not need a long chain, so a
   * deployment that mostly asks small questions can turn this down.
   */
  reasoningEffort?: string
  /**
   * Attempts per model request, counting the first one.
   *
   * Covers rate limits and transient server errors. A 4xx that is not 429 is a request
   * problem and is not retried.
   */
  modelAttempts: number
  /** Videos longer than this are split before being sent to the multimodal model. */
  modelChunkThresholdSeconds: number
  /** Duration of one model-visible video chunk. */
  modelChunkSeconds: number
  /** Context retained on both sides of adjacent chunks. */
  modelChunkOverlapSeconds: number
  /** Sample rate used to measure loudness; 8 kHz mono is enough and keeps the decode small. */
  acousticSampleRate: number
  /** Loudness window length in milliseconds; one window becomes one position on the timeline. */
  acousticWindowMs: number
  /** How many loudest windows to list. */
  acousticPeakLimit: number
  /** Frame-change fraction that counts as a cut, passed to ffmpeg's scene filter. */
  shotSceneThreshold: number
  /** Shortest shot worth reporting; closer cuts together are one shot with a flash. */
  shotMinSeconds: number
  /** Window used for the pacing curve. */
  shotPacingWindowSeconds: number
  /** How many busiest pacing windows to list. */
  shotBusyLimit: number
  /** Shortest pause worth reporting as silence. */
  silenceMinSeconds: number
  /**
   * How far above the loudness floor a window must sit to count as sound.
   *
   * An absolute level cannot work here: normal speech in a quiet recording sits far
   * below the same speech in a loud one, so any fixed value either deletes real content
   * as if it were a pause or finds no pauses at all. Measuring the threshold against
   * this asset's own floor keeps both recordings right.
   */
  silenceMarginDb: number
  /**
   * Shortest stretch of sound worth keeping when pauses are removed.
   *
   * Pauses that nearly touch leave a sliver between them. Cutting a sliver produces a
   * flash on screen and an extra splice point, so it counts as part of the pause.
   */
  minKeepSeconds: number
  /** Longest finished film the deployment accepts, in seconds. */
  maxOutputSeconds: number
  /** Largest finished film the deployment accepts, in bytes. */
  maxOutputBytes: number
  /**
   * Frames of accumulated cutting error per clip that are still considered normal.
   *
   * Cutting is frame-aligned, so one clip can land a frame away from the requested
   * boundary. A timeline of many clips adds that up; beyond this the export is reported
   * as longer than the edit plan rather than silently accepted.
   */
  driftWarnFramesPerSegment: number
  /**
   * Whether an export levels its clips towards one loudness.
   *
   * Joining clips from different parts of a recording, or from different recordings,
   * leaves audible steps in level. Matching them needs the acoustic evidence, so with
   * the switch on and no evidence the export says so rather than silently skipping it.
   */
  loudnessMatch: boolean
  /** Level each clip is brought towards, in dBFS (negative). */
  loudnessTargetDbfs: number
  /**
   * Furthest a range edge may move when snapping to a shot or level boundary.
   *
   * This is the accuracy/faithfulness trade: a larger tolerance corrects more of the
   * model's imprecision but risks cutting off content the caller asked for.
   */
  refineToleranceSeconds: number
  /**
   * Longest excerpt the check-a-claim tool will produce, in seconds.
   *
   * An excerpt exists so a finding can be looked at, not so the film can be watched
   * again; a long cap would start putting second copies of assets in the bucket.
   */
  excerptMaxSeconds: number
  /**
   * Whether a found range is re-read on its own to confirm where it starts and ends.
   *
   * The first pass sees the whole film, so its boundaries carry that view's imprecision.
   * A second look at only the candidate is a cheaper question and lands closer, at the
   * cost of one extra transcode, upload and model call per range found.
   */
  verifyBoundaries: boolean
  /** Seconds of context kept on each side of a candidate during the second look. */
  verifyPadSeconds: number
  /** Frame rate used for the second look; higher than the whole-film proxy on purpose. */
  verifyFps: number
  /** Height the proxy is fitted to. Wider or taller sources are scaled down; smaller ones are left alone. */
  proxyHeight: number
  /** Font used when subtitles are burned into the picture. Must be installed where ffmpeg runs. */
  subtitleFont: string
  /** Subtitle text size in the burned-in picture. */
  subtitleFontSize: number
  /** Distance from the bottom edge for burned-in subtitles. */
  subtitleMarginV: number
}

/** Cordis schema for {@link Config}. */
export const Config: z<Config> = z.object({
  dataDir: z.string().required(),
  modelBaseUrl: z.string().required(),
  model: z.string().required(),
  apiKeyEnv: z.string().required(),
  ossEndpoint: z.string().required(),
  ossBucket: z.string().required(),
  ossAccessKeyIdEnv: z.string().required(),
  ossAccessKeySecretEnv: z.string().required(),
  ossPrefix: z.string().required(),
  ossOutputPrefix: z.string().required(),
  ossProjectPrefix: z.string().required(),
  signedUrlSeconds: z.number().required(),
  maxImportBytes: z.natural().default(4 * 1024 * 1024 * 1024),
  requestTimeoutMs: z.natural().default(120_000),
  modelTimeoutMs: z.natural().default(1_800_000),
  searchLimit: z.natural().default(50),
  keepSourceFiles: z.boolean().default(false),
  keyframeToleranceMs: z.natural().default(500),
  maxOutputTokens: z.natural().default(32_768),
  reasoningEffort: z.string(),
  modelAttempts: z.natural().default(3),
  modelChunkThresholdSeconds: z.natural().default(600),
  modelChunkSeconds: z.natural().default(300),
  modelChunkOverlapSeconds: z.natural().default(8),
  acousticSampleRate: z.natural().default(8000),
  acousticWindowMs: z.natural().default(1000),
  acousticPeakLimit: z.natural().default(20),
  shotSceneThreshold: z.number().default(0.3),
  shotMinSeconds: z.number().default(0.4),
  shotPacingWindowSeconds: z.natural().default(30),
  shotBusyLimit: z.natural().default(8),
  silenceMinSeconds: z.number().default(0.4),
  silenceMarginDb: z.number().default(10),
  minKeepSeconds: z.number().default(0.3),
  maxOutputSeconds: z.natural().default(300),
  maxOutputBytes: z.natural().default(150 * 1024 * 1024),
  driftWarnFramesPerSegment: z.number().default(1),
  loudnessMatch: z.boolean().default(true),
  loudnessTargetDbfs: z.number().default(-16),
  refineToleranceSeconds: z.number().default(1.5),
  excerptMaxSeconds: z.natural().default(60),
  verifyBoundaries: z.boolean().default(false),
  verifyPadSeconds: z.number().default(3),
  verifyFps: z.number().default(3),
  proxyHeight: z.number().default(720),
  subtitleFont: z.string().default('Microsoft YaHei'),
  subtitleFontSize: z.number().default(22),
  subtitleMarginV: z.number().default(28),
})
