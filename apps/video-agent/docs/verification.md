# 验证入口

当前验证范围为 P1，具体结果见 [P1 验收记录](p1-acceptance.md)。

```sh
go test -race ./...
go vet ./...
VIDEO_AGENT_INTEGRATION=1 VIDEO_AGENT_ACCEPTANCE_DIR="$PWD/data/p1-acceptance" go test -count=1 -v ./integration
```

PR CI 使用同一组门槛：基础 job 执行 `go build ./cmd/video-agent`、`go test -race ./...` 和 `go vet ./...`；独立媒体 job 显式设置 `VIDEO_AGENT_INTEGRATION=1` 后执行上面的 integration 命令。FFmpeg/ffprobe 缺失会使媒体 job 失败。CI 仅上传 `report.json` 和测试日志，不上传生成的视频、数据库或密钥。

普通测试覆盖版本冲突、锁定与连带位移、幂等重放、历史恢复、连续编辑、并发提交、跨项目引用、错误/取消状态等。FFmpeg 测试必须显式设置 `VIDEO_AGENT_INTEGRATION=1`，缺少工具时报错，不能把跳过媒体测试的普通测试结果当作 P1 完成证据。

`TestP1EndToEnd` 通过真实 CLI 子进程生成 36 秒 MP4、预览、重排/替换/恢复成片，校验像素、音频、源哈希、历史和输出元数据；保留 `report.json`、`jobs.json`、`assets.json`、`history.json` 及视频文件。

`TestP1MediaBoundaries` 覆盖非关键帧裁剪、随时间变化的画面、分数帧率、可变帧率、无声/短音轨及渲染失败清理。

`TestP1ExternalSample` 使用显式传入的本地影片，生成横竖混合版本、预览与替换后的版本。设置 `VIDEO_AGENT_SAMPLE=/绝对路径/至少40秒.mp4` 后执行；测试不会自行下载视频。记录中的一次公开样片验收并不代替 P4 的 8 个真实创作任务验收。

素材不足反馈、语义选段质量、字幕/BGM、后台任务恢复和 Web 预览属于 P2–P4，尚未通过产品级验收。
