/** DSH-native local video tools. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Config } from './config.ts'
import { VideoWorkspace } from './runtime.ts'

export { Config } from './config.ts'
export const name = 'video-workspace'
export const inject = ['tools']
const output = { schema: { type: 'json' as const }, render: (_: object, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
const present = (title: string) => () => ({ card: 'generic' as const, title, kind: 'other' as const })
const json = <T>(value: Promise<T>): Promise<JsonValue> => value.then(item => JSON.parse(JSON.stringify(item)) as JsonValue)

/** Register the video tools. They run in DSH and never call a local HTTP service. */
export function apply(ctx: Context, config: Config): void {
  const video = new VideoWorkspace(config)
  const add = (tool: Parameters<typeof ctx.tools.register>[0]) => ctx.tools.register(tool)
  add(defineTool({ name: 'video_project_create', description: '创建本地剪辑项目。', parameters: { id: { type: 'string', required: true }, name: { type: 'string', required: true } }, output, async execute(a) { return json(video.createProject(a.id, a.name)) }, presentCall: present('创建剪辑项目') }))
  add(defineTool({ name: 'video_project_list', description: '列出剪辑项目。', parameters: {}, output, isConcurrencySafe: () => true, async execute() { return json(video.projects()) }, presentCall: present('列出剪辑项目') }))
  add(defineTool({ name: 'video_import', description: '导入本地视频并读取时长、分辨率和帧率。', parameters: { project_id: { type: 'string', required: true }, path: { type: 'string', required: true } }, output, async execute(a) { return json(video.import(a.project_id, a.path)) }, presentCall: present('导入视频') }))
  add(defineTool({ name: 'video_assets_list', description: '列出项目中的视频素材。', parameters: { project_id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, async execute(a) { return json(video.assets(a.project_id)) }, presentCall: present('列出视频素材') }))
  add(defineTool({ name: 'video_understand', description: '将视频上传至临时 OSS 签名地址，交给 Qwen Omni 同时理解画面和声音，并保存结构化镜头、声音、台词、标签和高光。按内容找片段前必须调用。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, instruction: { type: 'string' } }, output, async execute(a, exec) { return json(video.understand(a.project_id, a.asset_id, a.instruction, exec.signal)) }, presentCall: present('理解视频内容') }))
  add(defineTool({ name: 'video_search', description: '检索 Omni 已保存的结构化视频理解结果，返回真实时间段。', parameters: { project_id: { type: 'string', required: true }, query: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, async execute(a) { return json(video.search(a.project_id, a.query)) }, presentCall: present('检索视频内容') }))
  add(defineTool({ name: 'video_find_in_video', description: '让 Omni 再次查看完整视频，找出指定画面、动作或声音出现的时间。', parameters: { project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, subject: { type: 'string', required: true } }, output, async execute(a, exec) { return json(video.find(a.project_id, a.asset_id, a.subject, exec.signal)) }, presentCall: present('查找视频内容') }))
  add(defineTool({ name: 'video_timeline_create', description: '用一个视频时间段创建时间线。', parameters: { id: { type: 'string', required: true }, project_id: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, start_us: { type: 'integer', required: true }, end_us: { type: 'integer', required: true } }, output, async execute(a) { return json(video.createTimeline(a)) }, presentCall: present('创建时间线') }))
  add(defineTool({ name: 'video_timeline_get', description: '读取时间线和版本号。', parameters: { id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, async execute(a) { return json(video.timeline(a.id)) }, presentCall: present('读取时间线') }))
  add(defineTool({ name: 'video_edit_apply', description: '用新的素材时间段替换时间线内容。', parameters: { timeline_id: { type: 'string', required: true }, base_revision: { type: 'integer', required: true }, asset_id: { type: 'string', required: true }, start_us: { type: 'integer', required: true }, end_us: { type: 'integer', required: true } }, output, async execute(a) { return json(video.replaceTimeline(a)) }, presentCall: present('修改时间线') }))
  add(defineTool({ name: 'video_render_submit', description: '使用 FFmpeg 导出当前时间线为 MP4。', parameters: { timeline_id: { type: 'string', required: true }, filename: { type: 'string' } }, output, async execute(a, exec) { return json(video.render(a.timeline_id, a.filename, exec.signal)) }, presentCall: present('导出视频') }))
  add(defineTool({ name: 'video_jobs_list', description: '列出视频导出任务。', parameters: {}, output, isConcurrencySafe: () => true, async execute() { return json(video.jobs()) }, presentCall: present('列出导出任务') }))
}
