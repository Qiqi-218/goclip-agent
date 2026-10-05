/** DSH-native local video tools. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Config } from './config.ts'
import { mediaRoute } from './media-route.ts'
import { VideoWorkspace } from './runtime.ts'

export { Config } from './config.ts'
export const name = 'video-workspace'
// `webServer` carries the read-only media route the workbench plays assets through.
export const inject = ['tools', 'webServer']
const output = { schema: { type: 'json' as const }, render: (_: object, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
/**
 * Output for a tool that calls the model.
 *
 * The model-facing content is the plain result. The presentation projection adds what
 * the call cost — elapsed time, tokens, and the head of the model's reasoning — which
 * is persisted on `tool/result` for the interface to show without the model having to
 * read it back as context.
 */
const costedOutput = {
  schema: { type: 'json' as const },
  render: (_: object, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  presentationMeta: (_: unknown, value: JsonValue) => {
    const result = value as { usage?: unknown, stages?: unknown, dimensions?: unknown, timeline?: unknown, counts?: unknown, duration_us?: unknown } | null
    const meta: Record<string, JsonValue> = {}
    if (result?.usage !== undefined) meta.model_usage = result.usage as JsonValue
    if (result?.stages !== undefined) meta.stages = result.stages as JsonValue
    // 证据总览把要画的数据一并投影出去：面板直接读这份结果元数据，
    // 不必为了画一条曲线再发一次请求，也不会因为再请求一次而前后不一致。
    if (result?.dimensions !== undefined && result?.counts !== undefined) {
      meta.evidence_view = { duration_us: result.duration_us as JsonValue, dimensions: result.dimensions as JsonValue, timeline: (result.timeline ?? null) as JsonValue, counts: result.counts as JsonValue }
    }
    return Object.keys(meta).length === 0 ? null : meta
  },
}
const present = (title: string) => () => ({ card: 'generic' as const, title, kind: 'other' as const })
const json = <T>(value: Promise<T>): Promise<JsonValue> => value.then(item => JSON.parse(JSON.stringify(item)) as JsonValue)

/**
 * Register the video tools. They run in DSH and never call a local HTTP service.
 *
 * @param ctx - the plugin context; the tool registry is its only dependency.
 * @param config - validated deployment settings for storage, model and measurement.
 */
export function apply(ctx: Context, config: Config): void {
  const video = new VideoWorkspace(config)
  // 释放数据库句柄：否则索引文件一直被占用，WAL 边车文件会随进程寿命增长。
  // 代理视频是缓存，随进程结束一起清掉，免得缓存目录无限增长。
  ctx.effect(() => () => video.dispose(), 'video-workspace.dispose')
  // 只读媒体路由：工作台用它把素材放进 <video>，靠 Range 请求拖动进度条。
  // 前缀为空表示部署方不要这条路由 —— 显式关闭，而不是留一条无人知道的开放路径。
  const mediaPrefix = config.mediaRoutePrefix.trim()
  if (mediaPrefix !== '') {
    ctx.effect(
      () => ctx.webServer.register(mediaRoute({
        resolve: async path => {
          const target = await video.resolveMedia(path)
          // 第二道校验：即使某个地址形式忘了验证，也到不了本项目之外的对象。
          return target !== null && video.ownsObjectKey(target.key) ? target : null
        },
        sign: (key, method) => video.signedAssetUrl(key, method),
        loudness: async path => {
          // 路由把维度那一段切掉后才交过来，所以这里只有两个 id。
          const [projectId, assetId] = path
          if (projectId === undefined || assetId === undefined) return null
          try {
            return await video.loudnessCurve(projectId, assetId)
          } catch (error) {
            // 素材不存在也是「没有可画的东西」，路由会翻成 404。
            // 若让它冒出去变成 502，界面就分不清「没有这个素材」和「读取出错」，
            // 会给用户一个错误的提示。
            return null
          }
        },
        timelines: async path => {
          const [projectId, assetId] = path
          if (projectId === undefined || assetId === undefined) return null
          try {
            return await video.timelinesForAsset(projectId, assetId)
          } catch {
            return null
          }
        },
        renders: async path => {
          const [projectId, assetId] = path
          if (projectId === undefined || assetId === undefined) return null
          try {
            return await video.rendersOf(projectId, assetId)
          } catch {
            return null
          }
        },
        evidence: async path => {
          const [projectId, assetId] = path
          if (projectId === undefined || assetId === undefined) return null
          try {
            return await video.evidenceTracks(projectId, assetId)
          } catch {
            return null
          }
        },
        history: async path => {
          // 三个 id：历史属于时间线，而一条素材可以有多条时间线。
          const [projectId, assetId, timelineId] = path
          if (projectId === undefined || assetId === undefined || timelineId === undefined) return null
          try {
            // 先确认这条时间线确实属于这个项目与素材，否则一个猜出来的 id 就能读到别处。
            const timelines = await video.timelinesForAsset(projectId, assetId) as { timelines?: Array<{ id: string }> } | null
            if (timelines?.timelines?.some(timeline => timeline.id === timelineId) !== true) return null
            return await video.timelineHistory(timelineId)
          } catch {
            return null
          }
        },
      }, mediaPrefix)),
      'video-workspace.media-route',
    )
  }
  const add = (tool: Parameters<typeof ctx.tools.register>[0]) => ctx.tools.register(tool)
  add(defineTool({ name: 'video_project_create', description: '创建本地剪辑项目。', parameters: { id: { type: 'string', required: true }, name: { type: 'string', required: true } }, output, async execute(a) { return json(video.createProject(a.id, a.name)) }, presentCall: present('创建剪辑项目') }))
  add(defineTool({ name: 'video_project_list', description: '列出剪辑项目。', parameters: {}, output, isConcurrencySafe: () => true, async execute() { return json(video.projects()) }, presentCall: present('列出剪辑项目') }))
  add(defineTool({ name: 'video_import', description: '把本地视频导入项目（上传到 OSS）并读取时长、分辨率和帧率。注意：默认会删除本地源文件，素材此后只存在于 OSS；部署方可以把 keepSourceFiles 设为 true 改为保留源文件。返回值里的 source_kept / source_note 会明确告知这次是否删除，请把它转达给用户。', parameters: { project_id: { type: 'string', required: true }, path: { type: 'string', required: true } }, output, async execute(a) { return json(video.import(a.project_id, a.path)) }, presentCall: present('导入视频') }))
  add(defineTool({ name: 'video_assets_list', description: '列出项目中的视频素材。', parameters: { project_id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, async execute(a) { return json(video.assets(a.project_id)) }, presentCall: present('列出视频素材') }))
  add(defineTool({ name: 'video_understand', description: '将视频上传至临时 OSS 签名地址，交给 Qwen Omni 同时理解画面和声音，并保存结构化镜头、声音、台词、标签和高光。按内容找片段前必须调用。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, instruction: { type: 'string' } }, output: costedOutput, async execute(a, exec) { const result = await video.understand(a.project_id, a.asset_id, a.instruction, exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('理解视频内容') }))
  add(defineTool({ name: 'video_search', description: '检索已保存的视频理解结果，返回真实时间段。结果按相关性排序；match_count 是命中总数，truncated=true 表示只返回了前若干条。查「高光/精彩/亮点」这类判断类词时走的是分析标注的 is_highlight，不是字面匹配。', parameters: { project_id: { type: 'string', required: true }, query: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, async execute(a) { return json(video.search(a.project_id, a.query)) }, presentCall: present('检索视频内容') }))
  add(defineTool({ name: 'video_find', description: '统一检索入口：在一个素材里按多个条件同时筛选片段。条件全部可选；text=关键词（字面，不命中则不返回），texts=一次问多句原话（每句各自检索，返回里 matched_text 说明命中哪一句），min_seconds/max_seconds=片段时长范围，min_dbfs=该段峰值响度下限（如 -20 表示只要比 -20 dBFS 响），min_cuts=该段内至少有几个镜头切点（节奏紧），highlight_only=只要被标为高光的段，has_silence=false 表示排除含停顿的段。**要定位一句原话的起止时间，直接把那句话放进 text（或多句放进 texts）** —— 语音转写与屏幕文字都是逐字的，能字面命中，返回的区间就是那句话的位置；这比让模型重看整条视频快几个数量级。**命中多句复述的分段时，加 split_sentences=true** 会把该段按句拆开、各给一个估算区间 —— 用于该处没有逐字转写（例如那一段没有音轨）而调用方仍需要逐句时间的场合。每条返回都带 evidence_refs，说明它凭什么被选中（哪一类证据、什么区间、什么数值）。缺哪种证据会在 evidence_missing 里列出。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, text: { type: 'string' }, texts: { type: 'array', items: { type: 'string' } }, split_sentences: { type: 'boolean' }, min_seconds: { type: 'number' }, max_seconds: { type: 'number' }, min_dbfs: { type: 'number' }, min_cuts: { type: 'integer' }, has_silence: { type: 'boolean' }, highlight_only: { type: 'boolean' }, limit: { type: 'integer' } }, output, isConcurrencySafe: () => true, async execute(a) { return json(video.findSpans(a.project_id, a.asset_id, a)) }, presentCall: present('检索片段') }))
  add(defineTool({ name: 'video_outline', description: '列出某个素材已有分析的分章结构（按时间顺序）。用来快速定位「这片子讲了什么、该看哪一段」，尤其适合长视频。只读已存的理解结果，不调模型。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, instruction: { type: 'string' } }, output, async execute(a) { return json(video.outline(a.project_id, a.asset_id, a.instruction)) }, presentCall: present('列出脉络') }))
  add(defineTool({ name: 'video_highlights', description: '列出被标为高光的全部段落，按置信度排序，并带上当初写下的 highlight_reason。「把精彩的地方剪出来」走这个，不需要关键词。只读，不调模型。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, instruction: { type: 'string' } }, output, async execute(a) { return json(video.highlights(a.project_id, a.asset_id, a.instruction)) }, presentCall: present('列出高光') }))
  add(defineTool({ name: 'video_timeline_split', description: '在某一段内部的一个点把它切成两段。切点用**素材自己的时间**（asset_time_us），不是相对于这一段的偏移 —— 看着源片定位、再换算成偏移容易差一帧。切点落在端点上会被拒绝（等于没切）。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, ordinal: { type: 'integer', required: true }, asset_time_us: { type: 'integer', required: true } }, output, async execute(a) { return json(video.splitSegment(a)) }, presentCall: present('切分片段') }))
  add(defineTool({ name: 'video_timeline_merge', description: '把第 N 段与第 N+1 段合成一段。只有同一素材、播放设置相同、且在素材上首尾相接的两段才能合。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, ordinal: { type: 'integer', required: true } }, output, async execute(a) { return json(video.mergeSegments(a)) }, presentCall: present('合并片段') }))
  add(defineTool({ name: 'video_asset_delete', description: '删除一个素材及其全部派生数据（分析、证据、引用它的时间线）。OSS 上的对象不会被删，工具只管理索引。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true } }, output, async execute(a) { return json(video.deleteAsset(a.project_id, a.asset_id)) }, presentCall: present('删除素材') }))
  add(defineTool({ name: 'video_project_delete', description: '删除一个项目及其全部内容。OSS 上的对象保留。', parameters: { project_id: { type: 'string', required: true } }, output, async execute(a) { return json(video.deleteProject(a.project_id)) }, presentCall: present('删除项目') }))
  add(defineTool({ name: 'video_timeline_subtitle_style', description: '设置时间线的字幕样式。字段全部可选，只提有问题的那个即可，其余保持原样。**位置用九宫格**（bottom-center 等）而不是坐标：换成竖版时坐标会失效，九宫格不会。字号与边距是**画面高度的占比**（size 0.04 约等于 1080p 下 43px），不是像素，所以换画幅不用重设。颜色写 #rrggbb。返回里会列出没被接受的字段与原因。样式不影响 revision —— 它改的是成片长什么样，不是成片是什么。', parameters: { timeline_id: { type: 'string', required: true }, font: { type: 'string' }, size: { type: 'number' }, bold: { type: 'boolean' }, italic: { type: 'boolean' }, color: { type: 'string' }, outlineColor: { type: 'string' }, outlineWidth: { type: 'number' }, alignment: { type: 'string', enum: ['bottom-left', 'bottom-center', 'bottom-right', 'middle-left', 'middle-center', 'middle-right', 'top-left', 'top-center', 'top-right'] }, marginVertical: { type: 'number' }, marginHorizontal: { type: 'number' }, backgroundColor: { type: 'string' }, backgroundOpacity: { type: 'number' }, shadowColor: { type: 'string' }, shadowOffset: { type: 'number' }, source: { type: 'string', enum: ['transcript', 'screen-text'] } }, output, async execute(a) { const { timeline_id, ...style } = a as { timeline_id: string } & Record<string, unknown>; return json(video.setSubtitleStyle({ timeline_id, style })) }, presentCall: present('设置字幕样式') }))
  add(defineTool({ name: 'video_subtitle_style_get', description: '读时间线的字幕样式，并给出默认值与生效值。style 为 null 表示从未设置过 —— 那与「设置成了默认值」不同：导出时会用部署默认值并在备注里说明。', parameters: { timeline_id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, async execute(a) { return json(video.subtitleStyle(a.timeline_id)) }, presentCall: present('读取字幕样式') }))
  add(defineTool({ name: 'video_timeline_rename', description: '给时间线起名或改名（传空字符串则清空）。名字不属于编辑内容，所以**不会**推进 revision。', parameters: { timeline_id: { type: 'string', required: true }, name: { type: 'string', required: true } }, output, async execute(a) { return json(video.renameTimeline(a.timeline_id, a.name)) }, presentCall: present('重命名时间线') }))
  add(defineTool({ name: 'video_timeline_name_segment', description: '给某一段起名或改名（传空字符串则清掉名字）。名字存在**片段**上而不是时间线上：它标的是这一刀里的某一块，同一段素材在别处再用一次是另一块。与时间线改名不同，这个动作**会推进 revision** —— 把一段叫作「开场」改变了这一刀读起来的样子。「修改片段名称或标记」用它。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, ordinal: { type: 'integer', required: true }, name: { type: 'string', required: true } }, output, async execute(a) { return json(video.nameSegment(a)) }, presentCall: present('给片段起名') }))
  add(defineTool({ name: 'video_timeline_history', description: '列出一条时间线可回滚的历史版本（每次编辑前都留了快照）。回滚前先看这个选目标 revision。', parameters: { timeline_id: { type: 'string', required: true } }, output, async execute(a) { return json(video.timelineHistory(a.timeline_id)) }, presentCall: present('历史版本') }))
  add(defineTool({ name: 'video_timeline_revert', description: '把时间线回到某个早先的 revision。回滚本身也是一次编辑（版本号继续往前走），所以可以再回滚回来，不会把已经发生的事抹掉。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, target_revision: { type: 'integer', required: true } }, output, async execute(a) { return json(video.revertTimeline(a)) }, presentCall: present('回滚版本') }))
  add(defineTool({ name: 'video_find_similar', description: '找出与**给定区间内容相似**的其它片段（同一个人、同一类画面、同一类情节都算）。参照物是那一段自己的证据（说的话、屏幕上的字、画面描述、分段描述），所以结果可核验：把两段的描述并排看就能判断像不像。参照区间本身会从结果里剔除。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, start_us: { type: 'integer', required: true }, end_us: { type: 'integer', required: true } }, output: costedOutput, async execute(a, exec) { const result = await video.findSimilar(a, exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('找相似片段') }))
  add(defineTool({ name: 'video_find_in_video', description: '让 Omni 再次查看完整视频，找出指定画面、动作或声音出现的时间。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, subject: { type: 'string', required: true } }, output: costedOutput, async execute(a, exec) { const result = await video.find(a.project_id, a.asset_id, a.subject, exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('查找视频内容') }))
  add(defineTool({ name: 'video_timeline_create', description: '用一个视频时间段创建时间线。name 是给人看的中文名字，建议填 —— 列表里比 id 好认。', parameters: { id: { type: 'string', required: true }, name: { type: 'string' }, project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, start_us: { type: 'integer', required: true }, end_us: { type: 'integer', required: true } }, output, async execute(a) { return json(video.createTimeline(a)) }, presentCall: present('创建时间线') }))
  add(defineTool({ name: 'video_timeline_get', description: '读取一条时间线。start_us/end_us 是素材坐标，两者相减才是时长。', parameters: { id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, async execute(a) { return json(video.timeline(a.id)) }, presentCall: present('读取时间线') }))
  add(defineTool({ name: 'video_timeline_list', description: '列出某个项目下的全部时间线。start_us/end_us 是素材上的坐标，duration_us 才是实际时长。若两条时间线区间完全相同，后一条会带 duplicate_of 指向第一条 —— 这通常是同一次剪辑的修订版，不是重复数据，**要问用户保留哪条，不要擅自删**。', parameters: { project_id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, async execute(a) { return json(video.timelinesOf(a.project_id)) }, presentCall: present('列出时间线') }))
  add(defineTool({ name: 'video_edit_apply', description: '用新的素材时间段替换时间线内容。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, asset_id: { type: 'string', required: true }, start_us: { type: 'integer', required: true }, end_us: { type: 'integer', required: true } }, output, async execute(a) { return json(video.replaceTimeline(a)) }, presentCall: present('修改时间线') }))
  add(defineTool({ name: 'video_timeline_add', description: '向时间线追加一段。多段拼接靠它：同一个项目里的任意素材都可以。base_revision 必须是刚读到的版本号，冲突会报错而不会盖掉别人的修改。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, asset_id: { type: 'string', required: true }, start_us: { type: 'integer', required: true }, end_us: { type: 'integer', required: true }, speed: { type: 'number' } }, output, async execute(a) { return json(video.addSegment(a)) }, presentCall: present('追加片段') }))
  add(defineTool({ name: 'video_timeline_remove', description: '按序号删除一段（序号从 0 开始）。删除后后面的序号会自动前移。唯一的一段不能删。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, ordinal: { type: 'integer', required: true } }, output, async execute(a) { return json(video.removeSegment(a)) }, presentCall: present('删除片段') }))
  add(defineTool({ name: 'video_timeline_reorder', description: '把第 from 段移到第 to 位置。用于「一二段换位置」这类改顺序的要求。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, from: { type: 'integer', required: true }, to: { type: 'integer', required: true } }, output, async execute(a) { return json(video.reorderSegment(a)) }, presentCall: present('调整顺序') }))
  add(defineTool({ name: 'video_timeline_trim', description: '裁短某一段：edge 说明动哪一边（start= 开头往后推，end= 结尾往前提），delta_us 是移动量。必须明确说哪一边，不要猜。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, ordinal: { type: 'integer', required: true }, edge: { type: 'string', required: true, enum: ['start', 'end'] }, delta_us: { type: 'integer', required: true } }, output, async execute(a) { return json(video.trimSegment(a)) }, presentCall: present('裁短片段') }))
  add(defineTool({ name: 'video_timeline_adjust', description: '改某一段的播放速度（speed，如 2 表示二倍速）或是否静音（muted）。只改播放方式，不改源区间。注意：变速或静音会让导出走重新编码而不是流拷贝。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, ordinal: { type: 'integer', required: true }, speed: { type: 'number' }, muted: { type: 'boolean' } }, output, async execute(a) { return json(video.adjustSegment(a)) }, presentCall: present('调整片段') }))
  add(defineTool({ name: 'video_timeline_set', description: '一次性替换整条时间线的片段列表。适合已经拿到完整编辑方案的情形（例如 video_evidence_timing 返回的 kept_intervals，可直接做「去掉所有停顿」）。空列表会被拒绝。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, clips: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { asset_id: { type: 'string', required: true }, start_us: { type: 'integer', required: true }, end_us: { type: 'integer', required: true }, speed: { type: 'number' }, muted: { type: 'boolean' } } } } }, output, async execute(a) { return json(video.setSegments(a)) }, presentCall: present('设置片段列表') }))
  add(defineTool({ name: 'video_proposal_create', description: '产出一份**结构化方案**，不会改动任何时间线。每一段应当带 chosen_because（为什么选它）与 evidence_refs（从 video_find 拿到的证据引用），这样用户能逐段核对而不是只看一句结论。用户确认后才用 video_proposal_accept 落到时间线。', parameters: { id: { type: 'string', required: true }, project_id: { type: 'string', required: true }, timeline_id: { type: 'string' }, items: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: { asset_id: { type: 'string', required: true }, start_us: { type: 'integer', required: true }, end_us: { type: 'integer', required: true }, speed: { type: 'number' }, muted: { type: 'boolean' }, chosen_because: { type: 'string' }, evidence_refs: { type: 'array', items: { type: 'json' } } } } }, notes: { type: 'string' } }, output, async execute(a) { return json(video.proposalCreate(a)) }, presentCall: present('方案') }))
  add(defineTool({ name: 'video_proposal_get', description: '读回一份方案：逐段内容、每段的理由与证据引用、总时长、status 与 revision。修改前先读一次拿到最新 revision。', parameters: { id: { type: 'string', required: true } }, output, async execute(a) { return json(video.proposal(a.id)) }, presentCall: present('方案') }))
  add(defineTool({ name: 'video_proposal_revise', description: '按用户意见修改方案的片段列表或备注。只有 draft 能改；已确认的方案再改会与它创建的时间线脱节。base_revision 必须是刚读到的版本号。', parameters: { id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, items: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { asset_id: { type: 'string', required: true }, start_us: { type: 'integer', required: true }, end_us: { type: 'integer', required: true }, speed: { type: 'number' }, muted: { type: 'boolean' }, chosen_because: { type: 'string' }, evidence_refs: { type: 'array', items: { type: 'json' } } } } }, notes: { type: 'string' } }, output, async execute(a) { return json(video.proposalRevise(a)) }, presentCall: present('方案') }))
  add(defineTool({ name: 'video_proposal_accept', description: '用户确认后，把方案落到指定时间线（整条替换）。两个版本号都要对上：方案的保证用户看过的就是这份，时间线的保证自方案画出后它没被改过。确认前必须已经把方案逐段呈现给用户并得到同意。', parameters: { id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, timeline_id: { type: 'string', required: true }, timeline_revision: { type: 'integer', required: true } }, output, async execute(a) { return json(video.proposalAccept(a)) }, presentCall: present('方案') }))
  add(defineTool({ name: 'video_render_submit', description: '用 FFmpeg 导出时间线为 MP4。aspect 可换画幅（默认 keep 保持原样；9:16 竖版、16:9 横版、1:1），focus 决定重构图时保留哪一侧（默认 center）。burn_subtitles 可把字幕烧进画面（transcript 用语音转写、screen-text 用屏幕文字）——这一步必然重编码。若起点离源视频关键帧过远，会自动改为重新编码以保证起点精确（返回值里的 reencoded / note 会说明）。', parameters: { timeline_id: { type: 'string', required: true }, filename: { type: 'string' }, burn_subtitles: { type: 'string', enum: ['transcript', 'screen-text'] }, aspect: { type: 'string', enum: ['keep', '16:9', '9:16', '1:1'] }, focus: { type: 'string', enum: ['left', 'center', 'right'] } }, output: costedOutput, async execute(a, exec) { const frame: { aspect?: 'keep' | '16:9' | '9:16' | '1:1', focus?: 'left' | 'center' | 'right', burnSubtitles?: 'transcript' | 'screen-text' } = {}; if (a.aspect !== undefined) frame.aspect = a.aspect; if (a.focus !== undefined) frame.focus = a.focus; if (a.burn_subtitles !== undefined) frame.burnSubtitles = a.burn_subtitles; const r = await video.render(a.timeline_id, a.filename, exec.signal, frame); return json(Promise.resolve({ ...r, usage: video.lastUsage() })) }, presentCall: present('导出视频') }))
  add(defineTool({ name: 'video_export_subtitles', description: '导出时间线的字幕（SRT 或 WebVTT），时间**已换算到成片坐标**：片段被重排、裁剪或变速之后字幕仍然对得上。跨切点的句子按交集拆成多条，因为成片里它确实分在两处。文字取自语音转写或屏幕文字证据。', parameters: { timeline_id: { type: 'string', required: true }, source: { type: 'string', enum: ['transcript', 'screen-text'] }, format: { type: 'string', enum: ['srt', 'vtt'] } }, output: costedOutput, async execute(a, exec) { const result = await video.exportSubtitles(a.timeline_id, a.source === 'screen-text' ? 'screen-text' : 'transcript', a.format === 'vtt' ? 'vtt' : 'srt', exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('导出字幕') }))
  add(defineTool({ name: 'video_render_validate', description: '校验已导出的成片：实际时长、体积、是否超过上限（默认 300 秒 / 150 MB），以及成片与编辑计划的时长差。不传 job_id 时校验最近一次成功导出。切割是按帧对齐的，每段最多差一帧，段数多会累积，所以实际时长可能略长于计划 —— 这里会把差值报出来。', parameters: { job_id: { type: 'string' } }, output: costedOutput, async execute(a, exec) { const result = await video.validateRender(a.job_id, exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('校验成片') }))
  add(defineTool({ name: 'video_evidence_clip', description: '把素材的一小段切出来并上传，得到一条**给用户打开**的短片链接，用于人工核对证据。证据工具只给数字和区间，而数字无法靠读来核实，所以要由人看一眼、听一下 —— 不是由你。**你读到的只有文本，看不到也听不到这个片段**；判断证据是否成立要靠 video_find 的 evidence_refs 与 video_evidence_* 的数字，不要为了「确认一下」反复调用本工具。把 video_find / video_evidence_* 的区间传进来即可，超过上限会被截断并说明。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, start_us: { type: 'integer', required: true }, end_us: { type: 'integer', required: true }, filename: { type: 'string' } }, output: costedOutput, async execute(a, exec) { const r = await video.evidenceClip(a, exec.signal); return json(Promise.resolve({ ...r, usage: video.lastUsage() })) }, presentCall: present('取核对片段') }))
  add(defineTool({ name: 'video_cover_pick', description: '从时间线里抽一帧当封面并上传（JPEG），返回一条**给用户打开**的链接。帧取自**成片的第 N 段内部**，不是源素材，所以它就是观众真正会看到的那一帧。offset_seconds 默认取该段开头后不足半秒，因为切点常落在转场上，抽第一帧容易得到半个淡入。**你读到的只有文本，看不到这张图** —— 要换一张就改 offset_seconds 或 ordinal 再抽，不要为了「看看效果」连续抽取。', parameters: { timeline_id: { type: 'string', required: true }, ordinal: { type: 'integer' }, offset_seconds: { type: 'number' }, filename: { type: 'string' } }, output: costedOutput, async execute(a, exec) { const r = await video.coverPick(a, exec.signal); return json(Promise.resolve({ ...r, usage: video.lastUsage() })) }, presentCall: present('取封面') }))
  add(defineTool({ name: 'video_jobs_list', description: '列出视频导出任务。传入 project_id 可只看某个项目的任务。', parameters: { project_id: { type: 'string' } }, output, isConcurrencySafe: () => true, async execute(a) { return json(video.jobs(a.project_id)) }, presentCall: present('列出导出任务') }))
  add(defineTool({ name: 'video_evidence_acoustic', description: '取素材的声学证据：逐秒响度（dBFS）、基底/峰值/响亮阈值、最响的若干秒、以及连续响亮区间。用来回答「哪里最响」「笑声掌声在哪」「音量突起在哪」。纯本地 FFmpeg 计算，不调模型。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true } }, output: costedOutput, isConcurrencySafe: () => true, async execute(a, exec) { const result = await video.acousticEvidence(a.project_id, a.asset_id, exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('声学证据') }))
  add(defineTool({ name: 'video_evidence_shots', description: '取素材的镜头证据：镜头列表（含每个镜头起止与时长）、中位镜头长度、每分钟切点数、节奏曲线、切点最密的区间。用来回答「节奏紧的段落」「镜头切点在哪」。也可以用来把剪辑起点吸附到镜头边界。纯本地 FFmpeg 计算。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true } }, output: costedOutput, isConcurrencySafe: () => true, async execute(a, exec) { const result = await video.shotEvidence(a.project_id, a.asset_id, exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('镜头证据') }))
  add(defineTool({ name: 'video_evidence_visual', description: '描述**画面上发生了什么**，每段带起止时间与出现的具体名词。语音与屏幕文字只能匹配真的说过或写过的字，而「下雨的那段」「猫出现的地方」这类问题只存在于画面里 —— 这一维负责回答它们。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true } }, output: costedOutput, async execute(a, exec) { const result = await video.visualEvidence(a.project_id, a.asset_id, exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('画面描述') }))
  add(defineTool({ name: 'video_evidence_transcript', description: '转写视频里**说出来的话**，每句带起止时间。语音是创作者最常记得的检索线索（记得一句话，不记得时间码）。提取后用 video_find 的 text 条件可按原话搜。听不清的部分宁可不写，不会根据画面猜。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true } }, output: costedOutput, async execute(a, exec) { const result = await video.transcriptEvidence(a.project_id, a.asset_id, exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('语音转写') }))
  add(defineTool({ name: 'video_evidence_ocr', description: '提取屏幕上的文字（字幕、标题、图表标签、界面文字），每条带它出现的时间。这是**唯一可字面精确检索**的一维：提取后用 video_find 的 text 条件可以按原文搜。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true } }, output: costedOutput, async execute(a, exec) { const result = await video.ocrEvidence(a.project_id, a.asset_id, exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('屏幕文字') }))
  add(defineTool({ name: 'video_evidence_timing', description: '取素材的时序证据：全部停顿区间，以及「去掉这些停顿之后剩下的区间」（kept_intervals）。后者可直接用来创建时间线，实现「去掉所有停顿」。纯本地 FFmpeg 计算。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true } }, output: costedOutput, isConcurrencySafe: () => true, async execute(a, exec) { const result = await video.timingEvidence(a.project_id, a.asset_id, exec.signal); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('时序证据') }))
  add(defineTool({ name: 'video_evidence_status', description: '查这个素材**已经算过什么**，不必先算一遍。返回：每一类证据是否已算、覆盖到第几秒、条目数；以及**缺口** —— 某类证据没覆盖到画面末尾时，剩下多少秒没有它（落在那个范围里的内容任何检索都找不到）。还列出已保存的理解结果。**任何消耗时间的操作之前先调用它**：该用的证据已经算好就直接检索，没算过再决定要不要算。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true } }, output: costedOutput, isConcurrencySafe: () => true, async execute(a) { return json(video.evidenceStatus(a.project_id, a.asset_id)) }, presentCall: present('查证据状态') }))
  add(defineTool({ name: 'video_evidence_view', description: '把一个素材的全部证据汇总到同一条时间轴上：响度曲线（含它自己的动态范围）、镜头刻度、停顿段、语音转写、屏幕文字、画面描述、章节，以及可选的时间线片段。位置同时给 0–1 的归一化值与绝对微秒 —— 归一化值给界面画图用，微秒给回跳用。**这部分数据也会随工具结果一起投影给证据面板**，所以面板不必再请求一次。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, timeline_id: { type: 'string' } }, output: costedOutput, isConcurrencySafe: () => true, async execute(a) { const result = await video.evidenceView(a.project_id, a.asset_id, a.timeline_id); return json(Promise.resolve({ ...result, usage: video.lastUsage() })) }, presentCall: present('证据总览') }))
  add(defineTool({ name: 'video_cost_report', description: '报告最近一次视频工具调用的开销：各阶段耗时、模型耗时、输出与推理 token，以及模型思考的开头部分。用来回答「这次处理花了多少时间与 token、它在想什么」。', parameters: {}, output, isConcurrencySafe: () => true, async execute() { const usage = video.lastUsage(); const stages = video.lastStages(); return json(Promise.resolve({ calls: usage.length, usage, stages, note: usage.length === 0 ? '本进程还没有调用过模型（或上次调用未成功返回）' : '这些数字只覆盖最近一次工具调用；stages 是该次调用的各阶段耗时' })) }, presentCall: present('模型开销') }))
}