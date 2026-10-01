# 调研摘要

本项目的完整调研材料在现有 GoClip 的 [video-agent 文档](../../goclip/docs/video-agent/README.md) 和其下的 `research.md`、`verification.md`。

## 已确认结论

- GoClip 已有 SQLite 任务、草稿 revision、字幕、FFmpeg、Python 构图桥接和 React 预览，适合作为媒体基础。
- GoClip 当前模型以单一源视频为中心；`Scene` 没有 `asset_id`，需要新建多资产时间线。
- PenClip 的 `CentralHub`、能力声明、风险确认和槽位概念可参考。
- PenClip 当前 Composer 会返回成功和输出路径，但不实际生成文件；Analyzer、Matcher 关键函数返回空结果，不能直接作为执行引擎。
- video-use 已验证“结构化 EDL → 多源提取/拼接 → MP4 → 完整解码”，可参考其渲染边界。
- OpenChatCut 的工具循环、工程命令、proposal/revision 和异步导出适合作为交互设计参考。
- Crayotter 和 Vex 的调度、产物校验、有限工具循环值得参考，但当前许可证是 PolyForm Noncommercial，不能直接复制到商业产品。

## 选择

先做 GoClip 的多素材工程和确定性渲染，再接证据检索和外部 Agent。第一版不引入 LangGraph、向量数据库、Redis、Kubernetes 或完整专业时间线编辑器。需要这些能力时，必须由真实任务和性能数据推动。
