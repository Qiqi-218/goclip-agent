# Docker 与 Windows 使用说明

这个镜像包含 `video-agent`、FFmpeg 和 ffprobe。它通过 Docker Desktop 的 Linux 容器运行，因此 Windows 用户不需要单独安装 Go、FFmpeg 或配置编译环境。

产品主入口是本机 Web 服务：用户通过浏览器导入素材、分析、对话选片并导出。命令行仍可用于工程调试和自动化回归；每次命令会启动一个容器、操作挂载的工程目录并退出。工程数据和成片仍在 Windows 文件系统中。

## Windows 一键开始

1. 安装并启动 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，确认使用 Linux containers。
2. 下载或克隆仓库，在 PowerShell 进入仓库目录。
3. 运行：

```powershell
.\video-agent.bat --help
```

这会自动构建镜像；首次需要下载约数百 MB 的基础镜像和 FFmpeg，后续只在 Dockerfile 或 Go 依赖变化后重新构建。

`video-agent.bat` 实际执行的是：

```powershell
docker compose run --rm --build video-agent --data /workspace/data <你的命令>
```

`workspace/` 是唯一需要关心的工作目录：

```text
workspace/
  input/       放入原始 MP4/MOV
  data/        自动生成：SQLite、受控素材副本、exports/
  *.json       你自己的时间线和编辑操作文件
```

Windows 路径在容器里统一写成 `/workspace/...`。例如主机文件 `workspace\input\match.mp4`，导入命令中的路径是 `/workspace/input/match.mp4`。

## 一个完整命令行示例

先把两个视频放进 `workspace\input\`：`one.mp4`、`two.mp4`。

```powershell
.\video-agent.bat project create --id demo --name "比赛回顾"
.\video-agent.bat assets import --project demo --path /workspace/input/one.mp4
.\video-agent.bat assets import --project demo --path /workspace/input/two.mp4
.\video-agent.bat assets list --project demo
```

记下两次导入返回的 `id`，把它们填入 `workspace\timeline.json`：

```json
{
  "id": "demo-timeline",
  "project_id": "demo",
  "fps_num": 30,
  "fps_den": 1,
  "width": 1280,
  "height": 720,
  "items": [
    {"id": "opening", "asset_id": "替换为第一个素材ID", "source_in_us": 0, "source_out_us": 5000000},
    {"id": "ending", "asset_id": "替换为第二个素材ID", "source_in_us": 0, "source_out_us": 5000000}
  ]
}
```

创建、预览和导出：

```powershell
.\video-agent.bat timeline create --file /workspace/timeline.json
.\video-agent.bat render preview --timeline demo-timeline --output /workspace/data/exports/preview.mp4
.\video-agent.bat render export --timeline demo-timeline
```

命令输出 JSON，`output` 字段会是 `/workspace/data/exports/<任务ID>.mp4`；在 Windows 资源管理器中对应 `workspace\data\exports\`。不指定 `--output` 时每次都会新建文件，不会覆盖已有成片。

## 编辑与备份

把编辑操作保存为 `workspace\trim.json`，例如：

```json
{
  "id": "trim-opening-001",
  "timeline_id": "demo-timeline",
  "base_revision": 1,
  "kind": "trim_clip",
  "target_clip_id": "opening",
  "duration_frames": 90
}
```

然后执行：

```powershell
.\video-agent.bat edit apply --file /workspace/trim.json
.\video-agent.bat render export --timeline demo-timeline
```

备份时复制整个 `workspace\data\`。它包含 SQLite 数据库、受控素材副本、revision 历史和导出文件。不要在工程运行时编辑 `video-agent.db`、`assets/` 或 `exports/`。

## 更新、排错与限制

拉取新代码后，下次运行 `.\video-agent.bat` 会根据 Dockerfile 自动重建。若需要强制重建：

```powershell
docker compose build --no-cache
```

若出现 Docker 连接错误，先确认 Docker Desktop 正在运行。若素材导入失败，确认文件实际在 `workspace\input\`，路径使用 `/workspace/input/...`，并检查 Docker Desktop 已允许共享该磁盘。渲染慢通常取决于视频长度、分辨率和电脑 CPU。

镜像只挂载 `workspace/`，所以容器无法直接读取其他 Windows 路径。需要导入的素材先复制进 `workspace\input\`。启动下列服务后，在宿主机打开 `http://127.0.0.1:8090/`，即可使用浏览器界面；命令行/API 是实现、调试和回归入口：

```powershell
docker compose run --rm --service-ports video-agent --data /workspace/data serve --addr 0.0.0.0:8090
```

服务仅供本机访问。完整内部接口见 [接口说明](api.md)。
