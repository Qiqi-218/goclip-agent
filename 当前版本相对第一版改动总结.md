# 当前版本相对第一版改动总结

## 对比范围

- **第一版基线**：`1bb573f`（2026-10-01，`feat: initialize goclip video editing agent`）
- **当前版本**：`df19ddf`（2026-10-02，`ui: hide provider prefix in model label`）
- 本文基于 Git 已提交内容编写；`runtime/` 下被忽略的本机密钥和运行状态不纳入版本对比。

## 一句话结论

项目从“**DSH 前端/智能体 + 独立 Go 剪辑 HTTP 服务**”重构为“**DSH 进程内原生视频插件**”。视频理解统一交给 Qwen Omni，业务数据和视频文件改为以阿里云 OSS 为持久化主存储，保留本地 SQLite 与临时文件仅作缓存和处理用途。

## 架构变化

| 维度 | 第一版 | 当前版本 |
| --- | --- | --- |
| 业务进程 | DSH（8099）与 Go `video-agent`（8090）两个进程 | 仅 DSH；`dsh-video-workspace` 在 DSH host 内执行 |
| 工具调用 | DSH 插件通过 HTTP 调用 Go 服务的 21 个动作 | 插件直接执行 TypeScript 运行时逻辑，当前提供 12 个 `video_*` 工具 |
| 视频理解 | 字幕/ASR、抽帧视觉、响度、镜头切分构成“四维证据层” | Omni 对代理视频同时理解画面、声音与时间段 |
| 持久化 | Go 服务管理本地 SQLite、素材与生成文件 | OSS 保存素材、项目 manifest、分析结果、中间产物与导出文件；SQLite 仅作本地索引/恢复缓存 |
| 渲染 | Go 服务调用 FFmpeg | DSH 原生插件调用 FFmpeg，完成后上传 OSS 并清理本地临时文件 |
| 部署依赖 | Go、Node、FFmpeg；可选 Python/PySceneDetect；可独立部署 HTTP 服务 | Node、pnpm、FFmpeg、阿里云百炼与 OSS；不再需要 Go、8090 端口或 PySceneDetect |

## 已完成的主要改动

### 1. 移除独立 Go 服务，收敛到 DSH 原生插件

- 删除 `apps/video-agent/`，其中包括 Go 服务、HTTP 路由、Docker/Compose 配置、CI、集成测试及独立文档。
- `dsh-video-workspace` 不再配置 `endpoint`、超时、HTTP Bearer Token 或帧预览比例，也不再请求 `http://127.0.0.1:8090`。
- 新增插件内运行时 `src/runtime.ts`，直接负责项目、素材、分析、时间线、任务、FFmpeg 与 OSS 调用。
- 启动流程不再拉起两个进程；项目 README 也相应改为仅启动 DSH。

### 2. 工具接口由 21 个动作缩减为 12 个核心工具

当前保留的工具覆盖完整的基本剪辑流程：

`video_project_create` → `video_import` → `video_understand` → `video_search` / `video_find_in_video` → `video_timeline_create` / `video_edit_apply` → `video_render_submit`。

此外保留项目、素材、时间线和任务的查询工具。第一版独立暴露的字幕、镜头、响度曲线、帧卡片等细粒度能力已移除，避免模型在多个证据工具之间调度。

### 3. 视频理解改为 Omni 一体化流程

- 第一版通过字幕/ASR、抽帧视觉、声学响度和镜头切分分别产生证据。
- 当前版在 `video_understand` 中先用 FFmpeg 生成 720p、1 fps 的代理视频，再以 `video_url` 交给 Omni 返回带 `start_us`、`end_us`、画面、声音、标签和置信度的结构化片段。
- `video_search` 检索已保存的分析结果；需要复查具体画面、动作或声音时，`video_find_in_video` 再将视频交给 Omni 查询。
- 系统提示词同步简化为“先理解、引用真实时间段、先给方案并征求确认后渲染”的工作流。

### 4. 增加 OSS 持久化与恢复能力

- 导入素材后上传 OSS，记录 `oss://` 引用；源文件作为本地暂存会被清理。
- 项目 manifest、项目索引、分析结果和渲染任务都会上传 OSS。
- 启动时本地 SQLite 没有项目数据，会尝试从 OSS 的项目索引与 manifest 恢复。
- OSS Bucket 设计为私有；下载与导出结果通过短期签名 URL 访问，默认有效期为 900 秒。
- 本地目录只保存 SQLite、下载/转码/渲染临时文件；处理结束后清理临时视频。

### 5. 模型与 Profile 配置收敛

- 经历过 Qwen-Plus 配置后，Profile 现在只保留 `qwen3.8-omni-flash`，并将其设为 DSH 默认模型。
- 已从 Profile 中移除 `qwen-plus`、`qwen-vl-plus`、`qwen-vl-max` 与 `qwen-max` 等旧模型条目。
- 模型密钥继续只通过环境变量名引用，不写入已跟踪的 Profile。
- `goclip` 预设保留中文剪辑角色、真实时间戳、先确认后渲染等约束，但移除了依赖“四维证据层”的旧提示词。

> 注意：DSH 的默认模型由 `config/profile/cordis.patch.yml` 指定为 `qwen3.8-omni-flash`；原生视频插件则读取 `AUTOCLIP_TEXT_MODEL` 环境变量。部署时应将该环境变量设成相同模型，避免对话模型与视频理解模型版本不一致。

### 6. 界面做了两项轻量调整

- Composer 中只显示上下文用量，不再显示总 token 数。
- 模型选择器隐藏供应商前缀，显示名更简洁。

## 规模与文件变化

相对第一版，Git 统计为 **137 个文件变化、约 220 行新增、19,499 行删除**。删除量主要来自完整 Go 服务、其测试/文档/CI，以及插件侧原有的工作台面板、帧卡片和任务卡片 UI；新增代码主要集中在 DSH 原生运行时与 OSS 存储逻辑。

## 对使用方式的影响

1. 不再访问或部署 `:8090`；所有 `video_*` 工具均由 DSH 进程执行。
2. 必须同时配置百炼模型凭据和 OSS RAM 凭据；没有 OSS 凭据时，素材导入、项目保存与渲染导出无法完成。
3. 不再依赖本地 Go 服务的细粒度分析能力。需要“精彩片段”等主观判断时，效果主要取决于 Omni 的理解结果与后续查询提示。
4. 导出与项目数据以 OSS 为准，本机缓存被清理或丢失后可以尝试从 manifest 恢复。

## 需要关注的取舍

- **简化收益**：部署、进程管理和模型编排更简单；一个 Omni 模型可以直接给出跨画面与声音的时间段结果。
- **能力取舍**：第一版的字幕、响度、镜头切分、可审计帧图和独立 HTTP API 已不再提供；无法再把这些细粒度证据视为当前版本能力。
- **验证取舍**：随着 `apps/video-agent` 和大量测试删除，第一版的 Go 单元/集成测试以及“21 个 HTTP 动作一一对应”的校验已不适用于当前架构。当前应以 TypeScript 编译、插件构建和真实 OSS/Omni/FFmpeg 端到端验证为准。
