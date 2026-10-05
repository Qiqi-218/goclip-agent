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
   * Whether the extraction tools may use the model's reasoning channel.
   *
   * Transcription, screen-text reading and scene description are extraction: the answer
   * is in the media, and there is nothing to work out. Leaving the reasoning channel open
   * for them is what produced the worst measured failure in this plugin — a 43-minute
   * transcription spent 16384 reasoning tokens writing the whole timestamped transcript
   * into its own thinking, ran out of budget there, and returned an empty `lines` array
   * with `finish_reason: "stop"`. The empty result was then stored as "this video has no
   * speech", and the caller went on to re-analyse the whole video 21 times looking for
   * narration the analysis already held.
   *
   * Measured against the deployment endpoint: the same request with the channel disabled
   * returns the correct JSON with no reasoning tokens at all; `low` still spends a few
   * tens of them. `undefined` leaves the request as it was, for deployments whose endpoint
   * does not accept either parameter.
   *
   * The understanding pass is deliberately not covered: grouping a long video into
   * segments is a judgement, and its 296-token reasoning spend was proportionate.
   */
  extractionThinking?: 'off' | 'low'
  /**
   * Longest stretch of media handed to one extraction call, in seconds.
   *
   * Extraction answers have to fit in one model reply, and the reply is bounded by
   * `maxOutputTokens` shared with the reasoning channel. Measured against the deployment
   * endpoint, on a 43-minute narrated documentary at the default 32768 output ceiling:
   *
   * | media handed over | outcome |
   * | --- | --- |
   * | 3 min  | empty result |
   * | 8 min  | 88 lines |
   * | 15 min | 161 lines, but on a denser documentary the same window stopped mid-sentence at 15 minutes |
   * | 43 min | reply stops mid-JSON around 21335 characters, no usable result |
   *
   * The limit that matters is how much is *said* in the window, not how long it is: the
   * 15-minute figures came from a sparse stretch, and continuous narration in the same
   * window ran out of reply before the window did. The default is set below that, so the
   * answer fits with room to spare. A long asset is covered by successive windows, and the
   * file stays transcribable regardless of how long it is.
   */
  extractionChunkSeconds: number
  /**
   * The speech-recognition model that transcribes an asset, and where to reach it.
   *
   * Transcription is a recognition task, and a model built for it is both far faster and
   * far more accurate on proper nouns than the multimodal model is. Measured on the same
   * 43-minute narrated documentary, same signed URL:
   *
   * | model | time | proper nouns |
   * | --- | --- | --- |
   * | qwen-audio-3.1-asr-flash-filetrans | 41s | 洪洞广胜寺 / 飞虹塔 — correct |
   * | fun-asr | 33s | 广成子 / 飞鸿塔 |
   * | paraformer-v2 | 21s | 广深市 / 飞红塔 / 洪桐 |
   * | the multimodal model used before this | 192s | unusable: the answer came back truncated or empty |
   *
   * Spelling decides whether a creator's search finds anything, because local retrieval
   * matches text literally: a query for 飞虹塔 cannot match a transcript that wrote 飞鸿塔.
   * That is why the accurate model is the default even though a faster one exists.
   *
   * The model must be a file-transcription variant (the `-filetrans` suffix). The
   * synchronous variants accept only five minutes of audio and, over the compatible
   * endpoint, return no timestamps at all.
   */
  asrModel: string
  /**
   * DashScope API root for the asynchronous speech-recognition task endpoints.
   *
   * Separate from `modelBaseUrl`, which points at the OpenAI-compatible
   * `/compatible-mode/v1` root and has no task endpoints. The asynchronous flow submits to
   * `/services/audio/asr/transcription` and polls `/tasks/{id}`, both under `/api/v1`.
   */
  asrBaseUrl: string
  /**
   * How often to ask whether a recognition task finished, in milliseconds.
   *
   * The task endpoint allows 20 requests per second; polling faster buys nothing because a
   * submission's own latency dominates, and every poll is a request against quota.
   */
  asrPollMs: number
  /**
   * Longest a recognition task may run before it is abandoned, in milliseconds.
   *
   * An abandoned task is reported as a failure rather than left pending, so the caller
   * learns that the evidence is missing instead of waiting on it.
   */
  asrTimeoutMs: number
  /**
   * Credential reference for `asrBaseUrl`.
   *
   * Defaults to `apiKeyEnv`. Kept separate because a deployment can hold its speech key and
   * its chat key in different variables, and both are DashScope keys.
   */
  asrApiKeyEnv?: string
  /**
   * The model that reads text off the picture, and how densely to sample the picture.
   *
   * Reading text is not the same job as understanding a scene, and the model built for it
   * is both faster and steadier. Measured on frames of the 43-minute asset, one frame per
   * call:
   *
   * | model | per frame | result on a frame reading 今天我们先从下寺开始逛 |
   * | --- | --- | --- |
   * | qwen-vl-ocr / -latest / -2025-11-20 | 250-330 ms | the caption, nothing else |
   * | qwen3.5-ocr | 2867 ms | ran away: repeated its own preamble, then invented a list of classics |
   * | qwen3-vl-flash | 4717 ms | described a different building entirely and wrote three paragraphs about it |
   *
   * So the newest model is not the right one here, and the dedicated one is roughly 19x
   * faster than the general vision model while refusing to invent text that is not on
   * screen. A hallucinated caption is worse than a missing one: it becomes a search hit
   * for words nobody ever displayed, indistinguishable from a real one.
   */
  ocrModel: string
  /**
   * Seconds between sampled frames when reading on-screen text.
   *
   * Text on screen is static between cuts, so sampling every frame buys almost nothing and
   * costs a request per frame. The measured asset cuts roughly every five seconds; four
   * seconds samples each shot without stepping over a short one.
   */
  ocrSampleSeconds: number
  /**
   * How many frames are read at once.
   *
   * Frames are independent, so this is the only lever on wall-clock time. Measured over 60
   * consecutive frames: 758 ms per frame at concurrency 1, 168 ms at 8, 95 ms at 16. The
   * model allows 6000 requests per minute, so 16 is well inside the limit.
   */
  ocrConcurrency: number
  /**
   * Fraction of sampled frames above which a piece of text counts as furniture and is dropped.
   *
   * The reader returns only the characters, with no indication of whether they were a caption
   * or a station logo. Frequency is what separates them: the measured asset carries a station
   * mark on essentially every frame, while a spoken line appears on a few.
   *
   * Set well below "most frames" because the reader does not transcribe furniture
   * identically every time. Measured on that asset, the same mark appeared as
   * `-小老西儿 bilibili`, `-小老西儿_bilibili`, `-小老西儿` and `bilibili`, which splits its
   * frequency across four spellings; at 0.6 none of them cleared the bar and all leaked into
   * the results. Per-piece grouping keeps a caption's own count low, so a threshold at a
   * third still separates furniture from speech. Losing a genuine caption that really does
   * persist across a third of the video is the cost, and it is the cheaper mistake.
   */
  ocrWatermarkFraction: number
  /**
   * The model that describes what is on screen when no reading of text is wanted, and the
   * model used to double-check a single boundary.
   *
   * Kept separate from `model` because scene description needs sight but not hearing, and
   * paying for a model that also listens buys nothing. `verifyModel` handles a much smaller
   * question - is this cut where it claims to be - so it can be the cheaper model.
   */
  visionModel: string
  verifyModel: string
  /**
   * Attempts per model request, counting the first one.
   *
   * Covers rate limits and transient server errors. A 4xx that is not 429 is a request
   * problem and is not retried.
   */
  modelAttempts: number
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
  /** Path prefix of the read-only media route. See the schema entry for the contract. */
  mediaRoutePrefix: string
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
  extractionThinking: z.union([z.const('off'), z.const('low')]),
  extractionChunkSeconds: z.natural().default(900),
  asrModel: z.string().default('qwen-audio-3.1-asr-flash-filetrans'),
  asrBaseUrl: z.string().default('https://dashscope.aliyuncs.com/api/v1'),
  asrPollMs: z.natural().default(4000),
  asrTimeoutMs: z.natural().default(600_000),
  asrApiKeyEnv: z.string(),
  ocrModel: z.string().default('qwen-vl-ocr-2025-11-20'),
  ocrSampleSeconds: z.number().default(4),
  /**
   * How many frames are read at once.
   *
   * Frames are independent, so this is the only lever on wall-clock time: measured over 60
   * consecutive frames, 758 ms per frame at concurrency 1, 168 ms at 8, 95 ms at 16. The
   * gain is not linear because the model has a long tail - p99 near 7.6 s - and only
   * concurrency hides it: on the 43-minute asset, 646 frames took 82.9 s at 8 and 34.1 s at
   * 16.
   *
   * The documented ceiling is 6000 requests per minute for the dynamic alias but 600 for the
   * pinned snapshot, and 16 workers sustains roughly 3700. The pinned snapshot was driven at
   * 16 workers for 2584 consecutive frames with zero errors, so the lower figure does not
   * appear to be enforced - but it is a documented limit, and a deployment that starts seeing
   * refusals should lower this rather than lose frames.
   */
  ocrConcurrency: z.natural().default(16),
  ocrWatermarkFraction: z.number().default(0.5),
  visionModel: z.string().default('qwen3-vl-plus'),
  verifyModel: z.string().default('qwen3-vl-flash'),
  modelAttempts: z.natural().default(3),
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
  /**
   * Path prefix of the read-only route that serves media bytes to the browser.
   *
   * The video workbench plays assets in a `<video>` element, which needs an HTTP address it
   * can range against. Nothing else in the harness serves media, so this plugin registers
   * its own route. The prefix is configurable because a deployment may already use the
   * default path for something else, and a collision would make the route fail to register.
   *
   * An empty value disables the route: a deployment that does not want the plugin listening
   * on any path sets it to `''` rather than relying on the route being unreachable.
   */
  mediaRoutePrefix: z.string().default('/goclip-media'),
})
