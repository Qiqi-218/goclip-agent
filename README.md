# goclip-agent

基于 DeepSeek Harness 的视频理解与剪辑助手。项目把剪辑能力实现为 DSH 原生插件，使用 `qwen3.5-omni-flash` 分析视频画面和声音，使用 FFmpeg 生成片段，并使用阿里云 OSS 保存素材、项目状态、中间产物和导出文件。

## 架构

```text
DSH Web
  └─ qwen3.5-omni-flash
       └─ dsh-video-workspace
            ├─ OSS：素材、manifest、分析结果、中间产物、导出视频
            └─ 本地临时目录：FFmpeg 处理缓存，任务结束后清理
```

项目不再包含独立的 Go 剪辑服务，也不需要 8090 端口。所有业务工具都注册在 `dsh-video-workspace` 中，并在 DSH 进程内执行。

## 功能

- 创建和管理剪辑项目、素材和时间线
- 使用 Omni 同时理解画面、声音和视频结构
- 按分析结果搜索片段，或让 Omni 重新查找指定画面、动作和声音
- 使用 FFmpeg 创建时间线并导出 MP4
- OSS 私有存储和签名 URL
- 项目 manifest 上传到 OSS，可在本地状态为空时恢复项目

当前工具：

`video_project_create` · `video_project_list` · `video_import` · `video_assets_list` · `video_understand` · `video_search` · `video_find_in_video` · `video_timeline_create` · `video_timeline_get` · `video_edit_apply` · `video_render_submit` · `video_jobs_list`

## 前置要求

- Node.js 22.19 或更高版本
- pnpm
- FFmpeg 和 ffprobe，并且在 `PATH` 中
- 阿里云百炼 OpenAI 兼容 API Key
- 阿里云 OSS Bucket，以及允许对象读写的 RAM 用户

## 配置

将配置写入本地忽略文件 `runtime/.env.ps1`：

```powershell
$env:AUTOCLIP_TEXT_BASE_URL = 'https://<workspace>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
$env:AUTOCLIP_TEXT_MODEL = 'qwen3.5-omni-flash'
$env:AUTOCLIP_TEXT_API_KEY = 'sk-...'

$env:GOCLIP_OSS_ENDPOINT = 'oss-cn-beijing.aliyuncs.com'
$env:GOCLIP_OSS_BUCKET = 'your-bucket'
$env:GOCLIP_OSS_ACCESS_KEY_ID = 'LTAI...'
$env:GOCLIP_OSS_ACCESS_KEY_SECRET = '...'
```

Bucket 建议保持私有。RAM 用户至少需要 `oss:PutObject`、`oss:GetObject`、`oss:DeleteObject` 和对象列表权限。不要把 Key 提交到 Git，也不要把 Key 写入 README、配置补丁或会话记录。

## 安装和启动

```bash
pnpm --dir platform/dsh install
pnpm --dir platform/dsh run build
pnpm --dir runtime/home/profiles/video install
node runtime/start-dsh.mjs
```

启动后打开脚本输出的 `http://127.0.0.1:8099/?token=...` 地址。Windows 可以运行：

```powershell
./setup.ps1
./start.ps1
```

## 文件存储

- 原始素材：上传到 `goclip-projects/{project}/assets/...`
- 项目状态：`goclip-projects/{project}/manifest.json`
- Omni 代理视频和分析中间产物：`goclip-temporary/{project}/...`
- 导出视频：`goclip-exports/{project}/...`
- FFmpeg 本地文件：只作为临时缓存，上传成功后删除

OSS 对象默认是私有的。工具返回的下载地址是短期签名 URL，不应持久化为项目状态。

## 开发检查

```bash
node platform/dsh/node_modules/typescript/bin/tsc \
  -p platform/dsh/packages/video/video-workspace/tsconfig.json --noEmit
platform/dsh/node_modules/.bin/tsdown \
  --config platform/dsh/packages/video/video-workspace/tsdown.config.ts
```

核心插件代码位于 `platform/dsh/packages/video/video-workspace`，profile 配置位于 `config/profile`。
