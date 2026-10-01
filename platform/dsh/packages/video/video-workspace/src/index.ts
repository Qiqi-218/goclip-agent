/**
 * Model-facing video-editing tools over the local video-agent service.
 *
 * The bundle adds no storage, no rendering and no analysis of its own: it gives
 * the harness's agent the same constrained action surface the service already
 * exposes, so a conversation can create a project, pull footage in, understand
 * it, look at frames, retrieve moments and render a cut.
 *
 * Tool names, parameters and descriptions mirror the service's own action
 * declarations. That duplication is deliberate — the harness compiles tool
 * schemas statically while the service validates them at dispatch — and the
 * pair is kept honest by `pnpm run test` in this package, which fails when a
 * declared name has no case in the service.
 *
 * @module dsh-video-workspace
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Config } from './config.ts'
import { VideoAgentClient } from './client.ts'

export { VideoAgentClient, VideoAgentError, type ActionError, type CallResult } from './client.ts'
// The Loader validates each entry's raw `config:` block against this export, so
// the schema is the plugin's public configuration surface.
export { Config } from './config.ts'

export const name = 'video-workspace'
export const inject = ['tools']

/** One sampled frame, as the service describes it. */
interface FrameMatch {
  readonly start_us?: number
  readonly end_us?: number
  /** Absolute path the sampler wrote, on the machine running the service. */
  readonly frame?: string
  readonly reason?: string
}

/**
 * Turn the sampler's absolute paths into URLs a browser can fetch.
 *
 * The service already streams a frame's bytes with Range support, so naming the
 * URL beside each verdict is what makes a visual judgement checkable rather than
 * a sentence the reader has to trust. The path segments reproduce the layout the
 * sampler writes: `<analysis key>/frame-NNNN.jpg` for index-time frames and
 * `search/<sampled window>/frame-NNNN.jpg` for ad-hoc visual search.
 *
 * @param matches - the service's matches, whose `frame` fields are host paths.
 * @param assetId - the asset the frames were sampled from.
 * @param endpoint - the service base URL the browser can reach.
 * @returns each match with a `frame_url` beside its `frame` path.
 */
function withFrameUrls(matches: readonly FrameMatch[], assetId: string, endpoint: string): unknown[] {
  const base = endpoint.replace(/\/+$/, '')
  return matches.map((match) => {
    const url = frameUrlFor(match, assetId, base)
    return url === undefined ? { ...match } : { ...match, frame_url: url }
  })
}

/**
 * Attach the service's own file URL to an asset, so a reader can open the bytes
 * a tool just described instead of only reading their dimensions.
 * @param value - the service's `assets_import` or `assets_list` result.
 * @param endpoint - the service base URL the browser can reach.
 * @returns the value with a `file_url` on every asset.
 */
function withAssetUrls(value: JsonValue, endpoint: string): JsonValue {
  const base = endpoint.replace(/\/+$/, '')
  const decorate = (asset: Record<string, JsonValue>): Record<string, JsonValue> => {
    const id = asset.id
    return typeof id === 'string' ? { ...asset, file_url: `${base}/v1/assets/${id}/file` } : asset
  }
  if (Array.isArray(value)) {
    return value.map(item => (isRecord(item) ? decorate(item) : item))
  }
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = isRecord(item) ? decorate(item) : item
    }
    return out
  }
  return value
}

/**
 * Narrow a JSON value to an object with JSON values, without asserting.
 * @param value - any JSON value.
 * @returns true when the value is an object map.
 */
function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Answer one match's frame URL, or `undefined` when its recorded path does not
 * carry the two trailing segments a frame URL needs.
 * @param match - the service's match record.
 * @param assetId - the asset the frame was sampled from.
 * @param base - the service base URL, without a trailing slash.
 * @returns the frame URL, or undefined.
 */
function frameUrlFor(match: FrameMatch, assetId: string, base: string): string | undefined {
  const parts = (match.frame ?? '').replace(/\\/g, '/').split('/').filter(part => part !== '')
  const name = parts[parts.length - 1] ?? ''
  const dir = parts[parts.length - 2] ?? ''
  if (name === '' || dir === '') return undefined
  return parts[parts.length - 4] === 'visionsearch'
    ? `${base}/v1/assets/${assetId}/frames/search/${dir}/${name}`
    : `${base}/v1/assets/${assetId}/frames/${dir}/${name}`
}

/**
 * Register every video tool on the harness's tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the deployment's endpoint, deadline and frame-preview choice.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new VideoAgentClient({
    endpoint: config.endpoint,
    timeoutMs: config.timeoutMs,
    authToken: config.authToken,
  })

  /** Project list, so the model never has to guess a project id. */
  ctx.tools.register(defineTool({
    name: 'video_project_list',
    description:
      '列出所有剪辑项目及其素材数量。用户问「有哪些项目」「我上传过什么」或者你不知道该操作哪个项目时，先调用它，不要猜 id。'
      + 'asset_count 大于 0 的项目才是已经有素材的。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return (await client.call('project_list', {}, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '列出剪辑项目', kind: 'read' }),
  }))

  /** Import a local file as an asset, hashing for dedup. */
  ctx.tools.register(defineTool({
    name: 'video_assets_import',
    description:
      '把一个本地视频文件导入项目（按文件内容哈希去重），返回 asset id 与时长、分辨率。'
      + '用户在对话里上传了视频、或告诉你磁盘上某个视频的绝对路径时调用它。导入前项目必须先存在。',
    parameters: {
      project_id: { type: 'string', required: true, description: '所属项目 id' },
      path: { type: 'string', required: true, description: '本地视频文件的绝对路径' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const { value } = await client.call('assets_import', { project_id: args.project_id, path: args.path }, exec.signal)
      return withAssetUrls(value, config.endpoint)
    },
    presentCall: args => ({ card: 'generic', title: '导入素材', kind: 'other', rawInput: args.path }),
  }))

  /** List a project's assets, so the model can obtain an asset id. */
  ctx.tools.register(defineTool({
    name: 'video_assets_list',
    description: '列出项目下已经导入的素材（asset id、时长、分辨率）。不知道 asset id 时先调用它。',
    parameters: {
      project_id: { type: 'string', required: true, description: '项目 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { value } = await client.call('assets_list', { project_id: args.project_id }, exec.signal)
      return withAssetUrls(value, config.endpoint)
    },
    presentCall: () => ({ card: 'generic', title: '列出素材', kind: 'read' }),
  }))

  /** Understand an asset: transcript plus one description per sampled frame. */
  ctx.tools.register(defineTool({
    name: 'video_analyze',
    description:
      '对素材做内容理解，生成带时间范围的证据：字幕／转写，并且**默认同时抽帧看画面**'
      + '（画面里发生的事、字幕没说的动作都能被检索到）。凡是要按内容找片段，必须先调用它。'
      + '已经有字幕文件时传 subtitle_path 可以跳过语音识别。素材很长时这一步会比较慢。',
    parameters: {
      project_id: { type: 'string', required: true, description: '项目 id' },
      asset_id: { type: 'string', required: true, description: '素材 id' },
      subtitle_path: { type: 'string', description: '可选的本地 SRT/VTT 字幕文件绝对路径' },
      skip_visual: {
        type: 'boolean',
        description: '设为 true 只做字幕理解、跳过抽帧；默认 false，即默认会抽帧看画面',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const input: Record<string, unknown> = { project_id: args.project_id, asset_id: args.asset_id }
      if (args.subtitle_path !== undefined) input.subtitle_path = args.subtitle_path
      if (args.skip_visual !== undefined) input.skip_visual = args.skip_visual
      return (await client.call('analyze', input, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '理解素材（含抽帧）', kind: 'other' }),
  }))

  /**
   * The visual lookup. This is the tool the whole bundle exists for: it samples
   * real frames and asks a vision model about each one, instead of matching a
   * keyword against text somebody else wrote.
   */
  ctx.tools.register(defineTool({
    name: 'video_find_in_video',
    description:
      '让视觉模型直接看视频画面，找出「某个东西／某个画面」出现在哪些时间点。'
      + '当用户描述的是他**看见过**的画面（飞碟、进球、某人出镜、某张图、某种动作或表情），就用这个工具，'
      + '不要用 video_search 去猜关键词 —— 后者只能匹配已经写成文字的记录，'
      + '画面里出现过但没人用文字描述过的东西它找不到。'
      + '本工具会按你给的时间范围抽帧、逐帧问视觉模型，返回命中时间点与判断依据，'
      + '并把看到的帧作为图片一起返回。范围越小越快；可以先粗找一遍，再在命中的时间附近缩小范围确认。',
    parameters: {
      project_id: { type: 'string', required: true, description: '项目 id' },
      asset_id: { type: 'string', required: true, description: '素材 id' },
      subject: {
        type: 'string',
        required: true,
        description: '要找的东西，尽量用用户的原话，例如「飞碟」「进球瞬间」「有人在笑」',
      },
      start_us: { type: 'integer', description: '可选，只看这段范围（微秒），省略表示从头' },
      end_us: { type: 'integer', description: '可选，范围结束（微秒），省略表示到结尾' },
      frames: { type: 'integer', description: '可选，抽查多少帧，默认 24，上限 60；范围大时适当提高' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input: Record<string, unknown> = {
        project_id: args.project_id,
        asset_id: args.asset_id,
        subject: args.subject,
      }
      if (args.start_us !== undefined) input.start_us = args.start_us
      if (args.end_us !== undefined) input.end_us = args.end_us
      if (args.frames !== undefined) input.frames = args.frames
      const { value } = await client.call('find_in_video', input, exec.signal)
      if (!isRecord(value)) return value
      const matches = value.matches
      if (!Array.isArray(matches)) return value
      const out: Record<string, JsonValue> = {}
      for (const [key, item] of Object.entries(value)) out[key] = item
      out.matches = withFrameUrls(matches as FrameMatch[], args.asset_id, config.endpoint) as JsonValue[]
      return out
    },
    presentCall: args => ({ card: 'generic', title: `看画面找「${args.subject}」`, kind: 'read' }),
  }))

  /** Keyword retrieval over evidence the analysis already wrote down. */
  ctx.tools.register(defineTool({
    name: 'video_search',
    description:
      '在**已经写成文字**的证据里做关键词检索（字幕和画面描述都包括），返回带来源时间戳的命中。'
      + '适合用户说的词确实出现在素材里时。若用户描述的是一个画面而检索不到，改用 video_find_in_video 直接看画面。'
      + '没有命中是正常结果，会返回 count=0，不要因为 0 命中就反复换同义词重试。',
    parameters: {
      project_id: { type: 'string', required: true, description: '项目 id' },
      query: { type: 'string', required: true, description: '检索关键词，尽量用素材里出现过的原话' },
      limit: { type: 'integer', description: '返回条数上限，1..100，默认 20' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input: Record<string, unknown> = { project_id: args.project_id, query: args.query }
      input.limit = args.limit ?? 20
      return (await client.call('search', input, exec.signal)).value
    },
    presentCall: args => ({ card: 'generic', title: `检索「${args.query}」`, kind: 'read' }),
  }))

  /** Read a timeline and its current revision. */
  ctx.tools.register(defineTool({
    name: 'video_timeline_get',
    description: '读取时间线当前版本或指定版本，返回片段列表与 revision。要改动时间线前先读它，拿到 revision 才能提交编辑。',
    parameters: {
      id: { type: 'string', required: true, description: '时间线 id' },
      revision: { type: 'integer', description: '可选，指定版本号；省略表示当前版本' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input: Record<string, unknown> = { id: args.id }
      if (args.revision !== undefined) input.revision = args.revision
      return (await client.call('timeline_get', input, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '读取时间线', kind: 'read' }),
  }))

  /** Create the versioned timeline that a render reads. */
  ctx.tools.register(defineTool({
    name: 'video_timeline_create',
    description:
      '用给定的片段创建一个版本化时间线，返回时间线 id。时间线是成片的载体：先向用户说明打算怎么剪、拿到确认，再创建。'
      + 'fps 与分辨率必须和素材一致；片段不能重叠也不能留空隙，而且只支持 1 倍速。',
    parameters: {
      id: { type: 'string', required: true, description: '时间线 id，自拟的英文标识' },
      project_id: { type: 'string', required: true, description: '项目 id' },
      revision: { type: 'integer', required: true, description: '版本号，新建填 1' },
      fps_num: { type: 'integer', required: true, description: '帧率分子' },
      fps_den: { type: 'integer', required: true, description: '帧率分母' },
      width: { type: 'integer', required: true, description: '画面宽' },
      height: { type: 'integer', required: true, description: '画面高' },
      items: {
        type: 'array',
        required: true,
        description: '片段列表，按播放顺序',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '片段 id' },
            asset_id: { type: 'string', required: true, description: '素材 id' },
            source_in_us: { type: 'integer', required: true, description: '素材内起始微秒' },
            source_out_us: { type: 'integer', required: true, description: '素材内结束微秒' },
            evidence_ids: {
              type: 'array',
              description: '该片段依据的证据 id',
              items: { type: 'string' },
            },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return (await client.call('timeline_create', {
        id: args.id,
        project_id: args.project_id,
        revision: args.revision,
        fps_num: args.fps_num,
        fps_den: args.fps_den,
        width: args.width,
        height: args.height,
        items: args.items.map(item => ({
          id: item.id,
          asset_id: item.asset_id,
          source_in_us: item.source_in_us,
          source_out_us: item.source_out_us,
          evidence_ids: item.evidence_ids ?? [],
        })),
      }, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '创建时间线', kind: 'other' }),
  }))

  /** Submit the render job. */
  ctx.tools.register(defineTool({
    name: 'video_render_submit',
    description:
      '异步渲染时间线并返回 job id。preview 为真时只生成低开销预览，否则导出完整 MP4。'
      + '提交后用 video_jobs_get 查询进度。渲染会真实消耗时间并写出文件，'
      + '所以先向用户说清楚要导出什么、得到同意之后再调用。',
    parameters: {
      timeline_id: { type: 'string', required: true, description: '时间线 id' },
      revision: { type: 'integer', description: '可选，指定要渲染的版本号' },
      preview: { type: 'boolean', description: '是否只生成预览；默认 false 表示导出 MP4' },
      filename: { type: 'string', description: '可选输出文件名' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const input: Record<string, unknown> = { timeline_id: args.timeline_id }
      if (args.revision !== undefined) input.revision = args.revision
      if (args.preview !== undefined) input.preview = args.preview
      if (args.filename !== undefined) input.filename = args.filename
      return (await client.call('render_submit', input, exec.signal)).value
    },
    presentCall: args => ({
      card: 'generic',
      title: args.preview === true ? '生成预览' : '导出成片',
      kind: 'other',
    }),
  }))

  /** Poll one render job. */
  ctx.tools.register(defineTool({
    name: 'video_jobs_get',
    description: '查询渲染任务的状态与进度，完成后可拿到产物地址。提交渲染后用它确认是否已经出片。',
    parameters: {
      id: { type: 'string', required: true, description: '任务 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return (await client.call('jobs_get', { id: args.id }, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '查询渲染进度', kind: 'read' }),
  }))

  /**
   * The edit operation. Without it the model can create a timeline but cannot
   * change one, and an observed session worked around the gap by shelling out to
   * `curl` against the service's own HTTP action — which is exactly the kind of
   * side channel this bundle exists to avoid.
   */
  ctx.tools.register(defineTool({
    name: 'video_edit_apply',
    description:
      '对时间线施加一次编辑操作（裁剪/替换/删除/插入/移动/锁定/解锁/恢复版本）。'
      + 'base_revision 必须等于当前版本，否则会返回冲突，要重新读一次时间线再改。'
      + '改动前先用 video_timeline_get 读一次拿到 revision —— 版本号对不上时服务会拒绝，不会改坏数据。',
    parameters: {
      id: { type: 'string', required: true, description: '操作 id，自拟的英文标识' },
      timeline_id: { type: 'string', required: true, description: '时间线 id' },
      base_revision: { type: 'integer', required: true, description: '基线版本号，必须等于当前版本' },
      kind: {
        type: 'string',
        required: true,
        enum: [
          'trim_clip', 'replace_clip', 'delete_clip', 'insert_clip',
          'move_clip', 'lock_clip', 'unlock_clip', 'restore_revision',
        ],
        description: '操作类型。注意 trim_clip 只能往内裁，想延长片段要用 replace_clip',
      },
      target_clip_id: { type: 'string', description: '目标片段 id（trim/replace/delete/move/lock/unlock 用）' },
      new_clip_id: { type: 'string', description: '新片段 id（insert/replace 用）' },
      asset_id: { type: 'string', description: '素材 id（insert/replace 用）' },
      source_in_us: { type: 'integer', description: '素材内起始微秒' },
      source_out_us: { type: 'integer', description: '素材内结束微秒' },
      duration_frames: { type: 'integer', description: '时长帧数' },
      index: { type: 'integer', description: '插入位置' },
      restore_revision: { type: 'integer', description: '要恢复到的版本号（restore_revision 用）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const input: Record<string, unknown> = {
        id: args.id,
        timeline_id: args.timeline_id,
        base_revision: args.base_revision,
        kind: args.kind,
      }
      if (args.target_clip_id !== undefined) input.target_clip_id = args.target_clip_id
      if (args.new_clip_id !== undefined) input.new_clip_id = args.new_clip_id
      if (args.asset_id !== undefined) input.asset_id = args.asset_id
      if (args.source_in_us !== undefined) input.source_in_us = args.source_in_us
      if (args.source_out_us !== undefined) input.source_out_us = args.source_out_us
      if (args.duration_frames !== undefined) input.duration_frames = args.duration_frames
      if (args.index !== undefined) input.index = args.index
      if (args.restore_revision !== undefined) input.restore_revision = args.restore_revision
      return (await client.call('edit_apply', input, exec.signal)).value
    },
    presentCall: args => ({ card: 'generic', title: `编辑时间线（${args.kind}）`, kind: 'other' }),
  }))

  /** Create a project. The workbench can also do this; the agent needs it for a cold start. */
  ctx.tools.register(defineTool({
    name: 'video_project_create',
    description:
      '创建一个新剪辑项目，返回项目 id。用户还没指定项目、要开一个新片子时用。'
      + 'id 要一个简短的英文标识（如 proj-001）；已存在的 id 会失败。导入素材前必须先有项目。',
    parameters: {
      id: { type: 'string', required: true, description: '项目 id，简短英文标识' },
      name: { type: 'string', required: true, description: '项目名称，用于展示' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return (await client.call('project_create', { id: args.id, name: args.name }, exec.signal)).value
    },
    presentCall: args => ({ card: 'generic', title: `新建项目「${args.name}」`, kind: 'other' }),
  }))

  /** Read one project. */
  ctx.tools.register(defineTool({
    name: 'video_project_get',
    description: '按 id 读取一个项目。不知道 id 时先用 video_project_list。',
    parameters: {
      id: { type: 'string', required: true, description: '项目 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return (await client.call('project_get', { id: args.id }, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '读取项目', kind: 'read' }),
  }))

  /** List a project's timelines, so the model can find one to continue. */
  ctx.tools.register(defineTool({
    name: 'video_timeline_list',
    description:
      '列出某个项目下的全部时间线（含当前版本）。用户问「这个项目剪过什么」'
      + '或者要接着改某条已有时间线时，先用它找到 timeline id。',
    parameters: {
      project_id: { type: 'string', required: true, description: '项目 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return (await client.call('timeline_list', { project_id: args.project_id }, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '列出时间线', kind: 'read' }),
  }))

  /** List a timeline's revisions, for a rollback or a "what changed" answer. */
  ctx.tools.register(defineTool({
    name: 'video_timeline_history',
    description: '列出时间线的全部历史版本，用于回退，或向用户说明改过什么。',
    parameters: {
      id: { type: 'string', required: true, description: '时间线 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return (await client.call('timeline_history', { id: args.id }, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '查看版本历史', kind: 'read' }),
  }))

  /** List every render job, so "渲染好了吗" is answerable without an id. */
  ctx.tools.register(defineTool({
    name: 'video_jobs_list',
    description: '列出全部渲染任务。用户问「渲染好了吗」而你不知道 job id 时使用。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return (await client.call('jobs_list', {}, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '列出渲染任务', kind: 'read' }),
  }))

  /** Cancel one render job. */
  ctx.tools.register(defineTool({
    name: 'video_jobs_cancel',
    description: '取消一个进行中的渲染任务。用户说「别渲染了」「停下」时使用。',
    parameters: {
      id: { type: 'string', required: true, description: '任务 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return (await client.call('jobs_cancel', { id: args.id }, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '取消渲染', kind: 'other' }),
  }))

  /** Propose a cut from evidence, for the "show me candidates first" flow. */
  ctx.tools.register(defineTool({
    name: 'video_proposal_create',
    description:
      '按检索词生成一个待确认的剪辑提案，返回候选片段。想先给用户看几个候选、'
      + '等用户挑一个再落成时间线时用它。注意它只在**已经写成文字**的证据里检索；'
      + '用户描述的是画面时改用 video_find_in_video。',
    parameters: {
      timeline_id: { type: 'string', required: true, description: '时间线 id' },
      query: { type: 'string', required: true, description: '检索词' },
      limit: { type: 'integer', description: '候选数量，默认 3' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const input: Record<string, unknown> = { timeline_id: args.timeline_id, query: args.query }
      if (args.limit !== undefined) input.limit = args.limit
      return (await client.call('proposal_create', input, exec.signal)).value
    },
    presentCall: args => ({ card: 'generic', title: `生成提案「${args.query}」`, kind: 'other' }),
  }))

  /**
   * Detect the asset's shot boundaries and record them as evidence.
   *
   * It records what it found, so it is deliberately not marked concurrency-safe,
   * and it costs about a third of the video's length to run.
   */
  ctx.tools.register(defineTool({
    name: 'video_shots',
    description:
      '检测素材的镜头切分点，把全片切成若干「连续拍摄」的镜头区间，并把结果记为证据。'
      + '要按镜头边界精确下刀、想知道成片由几个镜头组成、或想验证某个画面持续多久时用它。'
      + '它逐帧比对，耗时约为视频时长的三分之一，所以不必每次都用；'
      + '跑过一次之后，video_find_in_video 的结果会自动带上所属镜头的边界。',
    parameters: {
      project_id: { type: 'string', required: true, description: '项目 id' },
      asset_id: { type: 'string', required: true, description: '素材 id' },
      skip_record: { type: 'boolean', description: '只检测不写入证据，默认 false' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return (await client.call('shots', {
        project_id: args.project_id,
        asset_id: args.asset_id,
        skip_record: args.skip_record,
      }, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '检测镜头切分', kind: 'other' }),
  }))

  /** Read one asset's measured loudness curve in full. */
  ctx.tools.register(defineTool({
    name: 'video_level_curve',
    description:
      '读取素材的逐秒音量曲线：每秒一条（起止时间、dBFS、以及这一秒是峰值／明显升高／平稳）。'
      + '要看全片哪里最响、要按「情绪峰值／全场沸腾」找片段时用它。'
      + '它不走关键词检索，所以多长的素材都能一次拿全 —— 想找某个响的瞬间也可以用视频检索词的 search。',
    parameters: {
      project_id: { type: 'string', required: true, description: '项目 id' },
      asset_id: { type: 'string', required: true, description: '素材 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return (await client.call('level_curve', {
        project_id: args.project_id,
        asset_id: args.asset_id,
      }, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '读取音量曲线', kind: 'read' }),
  }))

  /** Record evidence the user supplied, instead of inventing timestamps. */
  ctx.tools.register(defineTool({
    name: 'video_evidence_add',
    description:
      '写入一条带时间范围的证据。**只在用户自己提供了外部理解结果时使用**，'
      + '不要自己编时间戳 —— 编出来的时间戳会污染后续所有检索与提案。',
    parameters: {
      id: { type: 'string', required: true, description: '证据 id' },
      project_id: { type: 'string', required: true, description: '项目 id' },
      asset_id: { type: 'string', required: true, description: '素材 id' },
      start_us: { type: 'integer', required: true, description: '起始微秒' },
      end_us: { type: 'integer', required: true, description: '结束微秒' },
      asset_content_hash: { type: 'string', required: true, description: '素材内容哈希，必须与素材一致' },
      transcript: { type: 'string', description: '该时间范围的字幕或转写' },
      visual_summary: { type: 'string', description: '该时间范围的画面描述' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const input: Record<string, unknown> = {
        id: args.id,
        project_id: args.project_id,
        asset_id: args.asset_id,
        start_us: args.start_us,
        end_us: args.end_us,
        asset_content_hash: args.asset_content_hash,
      }
      if (args.transcript !== undefined) input.transcript = args.transcript
      if (args.visual_summary !== undefined) input.visual_summary = args.visual_summary
      return (await client.call('evidence_add', input, exec.signal)).value
    },
    presentCall: () => ({ card: 'generic', title: '写入证据', kind: 'other' }),
  }))
}
