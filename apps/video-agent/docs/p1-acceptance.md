# P1 自验收记录

结论：P1「多素材确定性编辑」通过本次验收。工程可以导入多素材，按结构化时间线生成 30–90 秒范围内的实际 MP4，修改片段后重新导出，保留完整历史并恢复。此结论不包含 P2 的语义理解或 P4 的创作质量验收。

验证时间：2026-09-30 UTC。环境：macOS arm64，Go 1.25.6，FFmpeg/ffprobe 8.1.2，modernc SQLite 1.39.1。机器可读结果、成片哈希与元数据见 [p1-results.json](evidence/p1-results.json)。

## 逐项验收

| P1 要求 | 实际证据 | 结果 |
| --- | --- | --- |
| 新工程、多资产导入 | CLI 创建项目，导入 24 fps 横屏单声道、29.97 fps 竖屏无声、60 fps 旋转双声道素材；重复导入返回同 ID；修改原文件不改变素材副本 | 通过 |
| 单轨、稳定片段 ID、合法来源 | 时间线与渲染计划记录片段 ID、资产 ID、源微秒范围及输出帧范围；非法范围、跨项目引用、时长矛盾被拒绝 | 通过 |
| 裁剪/替换/删除/插入/重排 | CLI 连续 5 次编辑并重启读取；实际导出从 36 秒变为 34 秒；像素核对重排和替换后的颜色与位置 | 通过 |
| revision、锁定、幂等、恢复 | 历史保留 8 个版本；旧版本拒绝；锁定阻止直接修改及连带位移；同载荷重放不创建版本，不同载荷报错；恢复后导出 SHA256 与原版本一致 | 通过 |
| SQLite 持久化与并发 | 11 个单元/存储测试通过 race 检查，包括两个 SQLite 连接竞争同一 base revision、12 个相同操作并发重试、关闭重开数据库恢复历史 | 通过 |
| 多源、原声/无声、方向与帧率 | 36 秒、1280×720、30 fps、1080 帧，H.264/AAC；单/双声道统一，静音区 RMS=0；重排后音频跟随画面；支持旋转标记、分数帧率、VFR、短音轨 | 通过 |
| 精确源区间 | 非关键帧处裁剪随时间改变的画面，像素证明取到指定源时间；30000/1001 输出 60 帧、2.002 秒 | 通过 |
| 预览与验证发布 | 640×360 预览与导出同样 1080 帧；所有成功导出经过 ffprobe 元数据与音视频完整解码，再发布文件 | 通过 |
| 失败不会伪装成完成 | 缺少工具、取消、素材副本被修改、已存在输出均失败；错误状态持久化；不覆盖既有文件，渲染失败不留下发布文件或临时文件 | 通过 |
| 实际影片样片 | Sintel 预告片原始 24 fps 横屏，与派生 25 fps 竖屏静音素材组成 36 秒视频；生成预览，替换首段重新导出；抽帧检查构图和黑边 | 通过 |

同一版本重新导出的字节一致性只在本次固定 FFmpeg/编码器环境内验证；跨平台或编码器版本不承诺相同字节。

## 执行记录

```text
go test -race ./...    PASS（11 个普通测试，媒体测试另行显式执行）
go vet ./...           PASS
git diff --check      PASS

TestP1MediaBoundaries  PASS  0.82s
TestP1EndToEnd         PASS 17.48s
TestP1ExternalSample   PASS 17.06s
integration suite     PASS 35.640s
```

媒体验收使用 `VIDEO_AGENT_INTEGRATION=1`，不存在通过跳过 FFmpeg 来通过验收的情况。普通 `go test` 的媒体测试跳过行为已在 README 明确标注。

本次本地保存的产物（路径相对于仓库根目录）：

- `data/p1-acceptance/run-1034416389/`：6 份生成素材成片，包含 36 秒初稿/预览/重排/替换/恢复，以及 34 秒连续编辑结果；附源资产、8 个历史版本、任务和报告 JSON。
- `data/p1-acceptance/footage-825215631/`：公开影片的 `original-36s.mp4`、`preview-36s.mp4`、`replaced-36s.mp4`，2 张抽帧 PNG、工程数据库和报告。

媒体文件与工程数据位于 `.gitignore` 中，不上传 GitHub；代码、使用说明和元数据证据随仓库交付。

## 重现

```sh
go test -race ./...
go vet ./...
VIDEO_AGENT_INTEGRATION=1 VIDEO_AGENT_ACCEPTANCE_DIR="$PWD/data/p1-acceptance" go test -count=1 -v ./integration
```

这会完成生成素材的端到端与边界测试。另有至少 40 秒的影片时，显式传入本地路径：

```sh
VIDEO_AGENT_INTEGRATION=1 \
VIDEO_AGENT_SAMPLE=/绝对路径/影片.mp4 \
VIDEO_AGENT_ACCEPTANCE_DIR="$PWD/data/p1-acceptance" \
go test -count=1 -v ./integration
```

本次影片来源：[W3C 提供的 Sintel 预告片](https://media.w3.org/2010/05/sintel/trailer.mp4)，影片署名：Blender Foundation。素材仅在本地用于验证，仓库不包含影片副本。

## 完成边界

P1 包含同步渲染与持久任务记录；后台任务调度、强制中断后的租约回收、自动重试属于后续阶段。当前工程使用绝对素材路径，迁移整个工程目录的路径修复尚未实现。

本次验收使用可重复生成的视频文件和一份公开影片，不等于已经固定 P0 的 3 个实际创作任务，也不等于通过 P4 的 8 个任务质量门槛。ASR、视觉分析、语义检索、字幕/BGM、Web 编辑、API/MCP、独立模型循环继续按 P2–P4 推进。
