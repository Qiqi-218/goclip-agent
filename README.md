# goclip 智能剪辑助手

**一个能听懂人话的长视频理解与智能剪辑助手**：把长视频解析成多维可检索的证据，
让创作者用自然语言精确可控地剪出成片。

2026 华北五省（市、自治区）及港澳台大学生计算机应用大赛 · 赛道一（大模型与智能体应用）

---

## 它解决什么

剪一条 40 分钟的素材，创作者通常记得的是**内容**（「那句关于奥德修斯的话」「下雨那段」），
不记得时间码。传统工具要求你先找到时间码，再从时间码开始剪。

goclip 反过来：先用多模态模型把长视频解析成**带时间戳的结构化证据**，
再用自然语言检索这些证据，最后把检索结果落成可回放、可回滚的编辑操作。

**「精确可控」是硬要求，不是形容词。** 所以：

- 所有时间都来自工具返回的真实区间，模型不许编造
- 每次编辑都要带 `base_revision`，版本冲突会**报错而不是覆盖**
- 改动前先出**结构化方案**（每段带选择理由与证据引用），用户确认后才落到时间线
- 每次编辑前留快照，可以回滚到任意历史版本
- 拿不到的数据**如实说**，绝不用推测填补

---

## 架构

纯 DSH 插件。**没有独立后端服务，没有第二个端口。**

```
浏览器
  └─ DSH Web（单进程）
       ├─ dsh-video-workspace   插件：50 个 video_* 工具，全部在 DSH 进程内执行
       │    ├─ FFmpeg/ffprobe   本地：证据计算、切分、拼接、导出
       │    ├─ Qwen3.8-Omni     云端：视频理解（画面+声音同时）
       │    └─ 阿里云 OSS       云端：素材与成片的权威存储
       ├─ dsh-client-ui-evidence  插件：证据总览面板（只读）
       └─ dsh-client-ui-workbench 插件：剪辑工作台（时间线、播放器、证据轨道、成片）
```

**关键设计：工具在 DSH 进程内跑。** 早期版本是一个独立的 Go 服务 + 8090 端口，
现在整个删掉了 —— 少一个进程、少一套鉴权、少一处状态不一致。

### 证据总览面板

界面里有一张**只读**的多轨时间轴卡片，把七个证据维度画在同一条轴上：

```
证据总览 · 2:40
响度    -18.2 … -13.3 dBFS   ← 折线，纵轴固定 -60…0 dBFS
镜头    70 条                 ← 切点刻度
停顿    1 条                  ← 最短 3px，否则零点几秒会细成毛刺
转写    19 条 ┐
屏文字  75 条 ├ 悬停显示原文
画面    25 条 ┘
章节    （本素材未做，如实留空）
时间线  版本 2                ← 实心=本素材，空心=来自别的素材
```

面板**不发任何请求**：数据是工具自己投影出去、随会话日志持久化的那份
`presentationMeta`。所以重开一次会话日志，面板照原样画出来。

---

## 工具（50 个）

| 类别 | 工具 |
| --- | --- |
| 项目管理 | `video_project_create` `video_project_list` `video_project_delete` |
| 素材 | `video_import` `video_assets_list` `video_asset_delete` |
| 理解与检索 | `video_understand` `video_search` `video_find` `video_find_in_video` `video_find_similar` `video_outline` `video_highlights` |
| 证据（本地计算，不调模型） | `video_evidence_acoustic` `video_evidence_shots` `video_evidence_timing` |
| 证据（云端多模态） | `video_evidence_transcript` `video_evidence_ocr` `video_evidence_visual` |
| 证据汇总 | `video_evidence_view` |
| 时间线编辑 | `video_timeline_create` `video_timeline_get` `video_timeline_list` `video_edit_apply` `video_timeline_add` `video_timeline_remove` `video_timeline_reorder` `video_timeline_trim` `video_timeline_adjust` `video_timeline_set` `video_timeline_split` `video_timeline_merge` `video_timeline_rename` |
| 版本 | `video_timeline_history` `video_timeline_revert` |
| 字幕样式 | `video_timeline_subtitle_style` `video_subtitle_style_get` |
| 方案 | `video_proposal_create` `video_proposal_get` `video_proposal_revise` `video_proposal_accept` |
| 导出 | `video_render_submit` `video_render_validate` `video_export_subtitles` |
| 辅助 | `video_evidence_clip` `video_cover_pick` `video_jobs_list` `video_evidence_status` `video_cost_report` |

---

## 剪辑工作台

工作台是中心区的独立面板，侧栏会出现「工作台」入口。它把一条素材的片段、画面、证据、时间线、版本和成片放在同一个编辑面上：

- 时间线使用原片时间轴，片段之间的空隙就是未被使用的素材区间
- 拖动片段边界、调整倍速/静音、切开、合并、重排、删除和起名，都会先生成带 `base_revision` 的工具意图，不会绕过宿主直接写库
- 证据轨道显示台词、屏文字、镜头、停顿、响度、章节和高光，并可点击回到原片时刻
- 版本列表支持提出 `video_timeline_revert`，成片列表保留失败任务及失败阶段
- 字幕样式可在画面上近似预览，最终导出由 FFmpeg/libass 按成片真实尺寸烧录

工作台通过地址片段指定素材：

```text
http://127.0.0.1:<port>/?token=…#project=<项目>&asset=<素材>
```

媒体字节、成片和测量数据都通过 `dsh-video-workspace` 的只读路由提供，视频播放支持 Range 请求。

### 七维证据

| 维度 | 来源 | 能回答 |
| --- | --- | --- |
| 声学 | 本地 FFmpeg | 哪里最响、笑声掌声在哪 |
| 镜头 | 本地 FFmpeg | 节奏紧的段落、切点在哪 |
| 时序 | 本地 FFmpeg | 停顿在哪、去掉停顿剩什么 |
| 语音转写 | Qwen Omni | 「他说的那句话在哪」 |
| 屏幕文字 | Qwen Omni | **唯一可字面精确检索**的一维 |
| 画面描述 | Qwen Omni | 「下雨那段」「猫出现的地方」 |

前三维纯本地、不花钱、可离线；后三维走多模态模型。**缺哪一维会如实上报**，
面板上的 `missing` 就是这么来的。

---

## 前置要求

- Node.js **22.19 或更高**（推荐 24）
- pnpm
- FFmpeg 与 ffprobe 在 `PATH` 中
- **Linux 额外需要**：C 编译器（`build-essential`）—— DSH 基座要编译原生插件；
  中文字体（`fonts-noto-cjk`）—— 缺了烧字幕会静默失败
- 阿里云百炼 API Key（OpenAI 兼容端点）
- 阿里云 OSS Bucket + 允许对象读写的 RAM 用户

---

## 安装

### Linux / macOS

```bash
apt-get install -y build-essential ffmpeg git curl fonts-noto-cjk   # Debian/Ubuntu
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
npm i -g pnpm@11
bash setup.sh      # 构建基座 → 装 profile → 摆好启动器
```

### Windows

```powershell
./setup.ps1
```

`setup.sh` / `setup.ps1` 都会在缺依赖时**明确报错并停下**，不会带着半成品继续。

---

## 配置

凭据写在本地忽略文件里（**绝不要提交**）：

- Linux / macOS：`runtime/.env`
- Windows：`runtime/.env.ps1`

```bash
AUTOCLIP_TEXT_BASE_URL=https://<workspace>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
AUTOCLIP_TEXT_MODEL=qwen3.8-omni-flash
AUTOCLIP_TEXT_API_KEY=sk-...

GOCLIP_OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com
GOCLIP_OSS_BUCKET=your-bucket
GOCLIP_OSS_ACCESS_KEY_ID=LTAI...
GOCLIP_OSS_ACCESS_KEY_SECRET=...
```

Bucket 建议保持私有。RAM 用户至少需要 `oss:PutObject` / `GetObject` / `DeleteObject` 与列举权限。

---

## 启动

```bash
./start.sh --host 127.0.0.1 --port 6006 --no-open     # Linux / macOS
./start.ps1                                            # Windows
```

打开日志里打印的 `http://127.0.0.1:<port>/?token=...`。

> **只能绑回环。** DSH 拒绝 `--host 0.0.0.0`（安全设计），webserver 的配置类型也只接受
> `127.0.0.1 | 0.0.0.0`。要让外部访问，必须靠反向代理或端口映射 —— 详见
> `docs-参赛/10-公网部署实作手册.md`。
>
> **每次重启令牌都会变**，旧链接会显示「authentication required」。

---

## ⚠️ 导入会删除本地源文件

**`video_import` 默认把源视频上传到 OSS，然后删除本地那份。**

这是**不可撤销**的操作，所以：

- 工具返回 `source_kept`（布尔）与 `source_note`（说明），**模型应当转达给用户**
- 想保住原始文件，在插件配置里设 `keepSourceFiles: true`
- 无论开关如何，**上传成功之后才会动本地文件** —— 传输失败时源文件与索引都不受影响

---

## 开发

```bash
cd platform/dsh

# 类型检查与打包 —— 改完源码两个都要跑
node node_modules/typescript/bin/tsc -b packages/video/video-workspace/tsconfig.json --force
node node_modules/typescript/bin/tsc -b packages/client/ui-evidence/tsconfig.json --force
node node_modules/typescript/bin/tsc -b packages/client/ui-workbench/tsconfig.json --force
node node_modules/tsdown/dist/run.mjs --config packages/video/video-workspace/tsdown.config.ts
node node_modules/tsdown/dist/run.mjs --config packages/client/ui-evidence/tsdown.config.ts
node node_modules/tsdown/dist/run.mjs --config packages/client/ui-workbench/tsdown.config.ts
```

**只跑 tsc 会让线上继续跑旧代码** —— DSH 加载的是 tsdown 打包出的 `lib/index.js`，
而 tsc 产出的是类型。两个都要。

### 验收

```bash
cd platform/dsh
pwsh -File ..\..\scripts\tools\verify\run-all.ps1      # Windows
```

工作台与视频插件的回归测试共 **13 个测试文件、241 项断言**，并配有真实浏览器 CDP 验收脚本。确定性探测用网络桩件拦截 OSS 与模型调用，因此不碰真实数据、
不消耗模型额度。覆盖：运行时与表结构、关开往返、七维证据、证据总览、多素材拼接与导出、
检索、方案版本、云端证据、区间吸附精度。

---

## 目录

```
config/profile/          goclip 的 DSH profile（模型、persona、客户端插件行）
platform/dsh/            DSH 基座（随仓库提交，保证可复现构建）
  packages/video/video-workspace/     核心插件：50 个工具
  packages/client/ui-evidence/        证据总览面板
  packages/client/ui-workbench/       剪辑工作台
scripts/tools/verify/    验收脚本（probe-* 确定性检查，cdp_* 真实界面驱动）
docs-参赛/               参赛文档
setup.sh / setup.ps1     安装
start.sh / start.ps1     启动
```

**关于 `platform/dsh`**：它是 DSH 基座的完整源码，随本仓库一起提交以保证
`git clone` 后可直接构建与验收。上游 DSH 自己的忽略规则已前缀化搬进根 `.gitignore`
（否则一次 `git add .` 会把约 261 MB 的 `node_modules` 与构建产物一起提交）。

---

## 许可

DSH 基座部分（`platform/dsh/`）来自 DeepSeek Harness，遵循其原始许可；
剪辑插件与面板为本作品实现。
