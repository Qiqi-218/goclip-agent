# 架构草图

```text
创作者：自然语言目标与确认
              ↓ Web
     本机服务：上传、分析、检索与方案
              ↓
 Go 工程服务：资产、Evidence、时间线、revision
          ↙                  ↘
   SQLite + 本地文件       持久媒体任务
            ↖               ↓
   模型 provider（可选）  FFmpeg
                            ↓
                      预览 / 校验 / MP4
```

领域层与媒体层分开。模型 provider 只处理必要的音频、文本或代表帧，不能直接写数据库、拼接任意 shell 或修改文件路径。Web 是创作者主入口；CLI 和内部接口共用同一套编辑服务，用于实现、调试与自动化回归。

## 核心对象

- `MediaAsset`：一份不可变输入，含路径引用、内容哈希、时长、尺寸和音轨。
- `Evidence`：来自字幕或画面采样的带时间范围证据。
- `TimelineRevision`：完整不可变时间线，引用多个资产。
- `ClipItem`：资产区间在成片中的位置，包含 `asset_id`、源入出点、输出帧范围和锁定状态。
- `EditOperation`：基于某个 revision 的类型化修改，拥有幂等 ID。
- `MediaJob`：导入、分析、预览和导出任务，拥有可恢复状态。

项目已实现 `Project`、`MediaAsset`、`TimelineRevision`、`EditOperation`、`RenderJob`、`Evidence` 与 `AnalysisRun` 的 SQLite 存储；字幕/ASR 和代表帧分析产出统一 Evidence，检索与方案生成始终保留可追溯边界。

当前数据路径：JSON CLI → `app` / `edit.Engine` → SQLite；渲染由 `render.Compile` 生成固定计划，经 `render.Execute` 调用 FFmpeg，在 ffprobe 和完整解码验证后发布文件。媒体工具只接收 argv，不经过 shell。

时间线采用一条连续主轨；源时间用微秒，输出时间用有理数帧率下的整数帧。裁剪更新源区间，插入/删除/重排重算起始帧。锁定同时保护内容和输出位置。提交在同一事务内进行 revision 比较、快照写入和幂等记录，保证多进程不会丢失修改。

当前项目采用与 GoClip 相同的 SQLite 驱动和媒体验证方法，但使用独立 schema 与多源渲染实现，不直接导入 GoClip 的 `internal` 包或共享旧数据库。接口和已知限制见 [使用说明](p1-usage.md)。

## 证据与模型原则

自然语言模型的职责是理解创作目标、解释候选和生成可审阅的方案；它不直接决定未经证据支持的片段。所有候选都必须能回到素材及源时间范围，方案确认前不修改工程。

编辑提交必须验证资产归属、源区间、时长、锁定约束、base revision 和操作幂等性。模型回复“完成”不代表媒体任务完成；只有真实产物通过元数据和完整解码检查才发布。
