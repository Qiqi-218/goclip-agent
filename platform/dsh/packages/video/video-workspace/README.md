# dsh-video-workspace

DSH 原生视频剪辑插件。它在 DSH 进程内注册 `video_*` 工具，调用 FFmpeg 和 Qwen Omni 完成视频导入、理解、检索、时间线编辑和导出。

持久数据使用私有 OSS：原始素材、项目 `manifest.json`、分析结果、中间产物和导出视频都上传 OSS；FFmpeg 只使用本地临时缓存，上传成功后清理。SQLite 仅作为本地索引和恢复缓存。

插件不依赖 Go 服务或 HTTP 剪辑服务。配置由 profile 的 `cordis.patch.yml` 提供，密钥通过 `runtime/.env.ps1` 注入启动进程。
