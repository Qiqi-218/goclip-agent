# Docker 工作目录

把自己的视频放进 `input/`。容器内对应路径为 `/workspace/input/文件名.mp4`。

运行 `video-agent.bat` 或 `docker compose run` 时：

- `data/` 保存 SQLite 工程、导入后的素材副本和导出视频；可备份整个目录。
- `input/` 是待导入的原始素材；导入成功后可以自行保留或删除原件。
- JSON 时间线和编辑操作可放在本目录，例如 `timeline.json`、`trim.json`。

`data/` 和 `input/` 的实际媒体文件不会提交到 Git。
