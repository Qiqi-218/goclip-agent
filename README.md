# goclip-agent v1 —— 完整源码包

**goclip 智能剪辑助手**：一个能与用户对话、并主动调用工具去「看」和「听」视频的剪辑智能体。

这是一份**只含项目本身的源码包** —— 不含任何测试素材、成片、抽帧、对话记录或数据库，
API Key 已替换为模板占位符。

---

## 包里有什么

```
start.ps1              启动脚本（拉起两个进程）
setup.ps1              一次性安装（装依赖 + 构建 + 装 profile）
apps/video-agent/      剪辑服务（Go）—— 四维证据层 / 编辑层 / 渲染层，21 个 HTTP 动作
  cmd/ internal/         19 个包。agent（动作调度）、analysis（字幕/视觉/镜头/声学）、
                         acoustic（响度曲线）、shots（镜头切分）、visionsearch（视觉检索）、
                         httpapi（路由/字节流/鉴权）、store（SQLite）
  .env.ps1.example       模型配置模板；复制为 `.env.ps1` 后填入端点与密钥
config/profile/        智能体 profile 配置（模型、默认预设、系统提示词、工作区落点）
  cordis.patch.yml       含 goclip 预设：角色设定、五条硬规则、「精彩怎么找」的代理指标表
  package.json           插件依赖，link 指向本包内的 dsh-src
platform/dsh/          智能体基座源码（TypeScript/Node）+ 我们的插件包
  packages/video/video-workspace/   ← 插件：21 个 video_* 工具 + 前端半部
                                      （帧图卡片 / 渲染任务卡 / 时间线卡 / 剪辑工作台面板）
scripts/tools/
  preflight.py           提交前门禁（视频时长体积 / 文档章节 / 仓库密钥三项硬检查）
  verify/                12 个验收驱动脚本（真实浏览器驱动真实界面）
```

**这个副本里没有**：`data/`（测试素材、成片、抽帧、数据库）、`bin/`（编译产物）、
`node_modules/`（依赖，由 `setup.ps1` 安装）、任何真实 API Key。
首次运行会自建空数据库，不需要预置数据。

---

## 装起来

前置：**Go 1.27+**、**Node ^22.19 或 >=24**、**pnpm**、**FFmpeg**（在 PATH 中）。

```powershell
cd E:\huabei\goclip-agentv1
.\setup.ps1          # 构建服务 + 安装并构建基座 + 装 profile（约 3-5 分钟）
```

然后填密钥并启动：

```powershell
Copy-Item apps\video-agent\.env.ps1.example apps\video-agent\.env.ps1
# 编辑 apps\video-agent\.env.ps1，把 $__base 和 $__key 换成你自己的
.\start.ps1          # 拉起剪辑服务(:8090)与智能体(:8099)
```

打开脚本输出的地址（带一次性令牌）。左栏点「剪辑」是工作台。

可选：镜头切分需要 PySceneDetect。

```powershell
pip install scenedetect opencv-python-headless
# 然后在 .env.ps1 里设 VIDEO_AGENT_SHOTS_PYTHON 指向该 python.exe
```

---

## 这个智能体是怎么工作的

### 两个进程

```
浏览器 → 智能体基座 :8099 ──HTTP──→ 剪辑服务 :8090
              │                          │
       21 个 video_* 工具          四维证据层 + 编辑层
                                   │            │
                              FFmpeg      国产大模型 API
```

**为什么分开**：分析与渲染是 CPU 密集型、生命周期长；前端是交互式、要频繁重启。
分开后前端热更新不打断跑着的分析任务。而且**同一组接口既服务于模型工具，也服务于工作台面板** ——
界面上看到的就是模型拿到的，两者不可能互相矛盾。

### 四维证据层

| 维度 | 是什么 | 工具 |
| --- | --- | --- |
| **文字** | 素材里被**说出来**的内容（字幕）。只有这一层能做字面检索 | `video_search` |
| **画面** | 某一帧里**看得见**什么（抽帧 + 视觉模型逐帧判定） | `video_find_in_video` |
| **声音** | 每一秒有多响、那是什么声音（响度曲线 + 音频事件名） | `video_level_curve` |
| **结构** | 素材被切成几个连续拍摄段（镜头），切点在哪 | `video_shots` |

每条证据都带**来源区间、提供者、分析器版本**，所以结论可核验 —— 每一帧、每一秒都能点开看。

### 「精彩的地方」怎么找（本产品的关键设计）

「精彩」不是素材里的字符串，**字面检索永远搜不到**。所以系统提示词教模型改用**可测的代理指标**：

| 用户的意思 | 该测什么 | 工具 |
| --- | --- | --- |
| 观众反应强烈、情绪高点 | 响度峰值、音量突起（笑声/掌声/欢呼/音乐推进） | `video_level_curve` |
| 节奏紧、信息密集 | 镜头切点密度：切得越快通常越紧 | `video_shots` |
| 有具体动作或事物 | 画面里真的出现了什么 | `video_find_in_video` |
| 有人说了关键的话 | 字幕里确实出现过的词 | `video_search` |

**这条是踩坑换来的**：早期版本里，用户说「帮我剪出来这个视频精彩的地方」，
模型把「精彩」当成可检索的词，用 `精彩 / 高潮 / 震撼 / amazing / wow / cool` 及其大小写变体
**连续调了 60 多次检索**，全部落空，然后声称「音量曲线返回空结果」——
而那一刻曲线有整整 300 秒数据。三处修好后才正常：提示词写清能力边界、检索的空结果说明
改成明确阻断换词重试、`level_curve` 的返回形状从 `{seconds,count}` 改成直接返回数组
（模型把对象读成了空）。修完同样一句指令：**10 次调用，零次滥用检索**，最后反问用户要多长。

### 五条硬规则（写在系统提示词里）

1. 不要用同义词反复重试同一个检索 —— 没命中就换工具，不要换词
2. 不要用检索找「精彩/高光/高潮」这类没有具体所指的词
3. 不许编造时间戳 —— 所有时间必须来自工具返回的真实区间
4. 不许替用户改时间线 —— 先出方案、说明依据、**征求确认**，确认后才渲染
5. 拿不到的数据如实说 —— 绝不用推测填补

---

## 测试

```powershell
cd apps\video-agent
go test ./...        # 17 个包有测试，应全部通过

cd ..\..\platform\dsh
pnpm run build       # 构建基座；插件产物在 packages/video/video-workspace/lib/
node packages\video\video-workspace\scripts\check-action-parity.mjs
# 期望：parity holds: every service action has exactly one tool（21 = 21）
```

`scripts/tools/verify/` 里是**用真实浏览器驱动真实界面**的验收脚本（点真实按钮、读真实 DOM），
所以「验收通过」随时可以重跑复核。用法见 `tools/verify/README.md`。

---

## 三个已知边界（如实说明）

1. **`analyze` 的某些阶段失败时，原因记在 `stage_errors` 字段里。** 曾遇到一次 `audio` 与
   `visual` 同时失败、单独跑又都成功的情况，**根因未确证** —— 因为当时没有错误文本可查。
   该字段就是为此加的，遇到请先看它。
2. **动作接口默认不鉴权**，因为默认只监听回环地址。若要把服务放到公网可访问的位置，
   必须同时设置 `VIDEO_AGENT_SHARED_SECRET` 与 `VIDEO_AGENT_ALLOWED_ORIGINS` ——
   否则服务会**拒绝启动**并说明缺哪一项。这是有意设计的。
3. **工作区里嵌着 `deepseek-harness` 这一段目录名**，那是基座自己的固定命名
   （`documentsDirectory` 下再拼一层）。它在本包的 `runtime/` 之内，不写到别处。

---

## 环境要求

| 项 | 版本 |
| --- | --- |
| Go | 1.27+ |
| Node.js | ^22.19 或 >=24 |
| pnpm | 11.x |
| FFmpeg / ffprobe | 9.x（在 PATH 中） |
| Python + PySceneDetect | 3.11+ / 0.7.1（仅镜头切分需要） |
| 大模型 API | 通义千问等国产模型（文本 / 视觉 / 语音三路） |

---

## 与基座的关系

`platform/dsh/` 是作为**基座**使用的开源项目（DeepSeek Harness，MIT 许可，版权声明保留在其
`LICENSE` 与 `THIRD_PARTY_NOTICES.md` 中）。本产品的实质工作是这个包里的两部分：

- **`apps/video-agent/`** —— 剪辑服务，四维证据层与全部业务逻辑
- **`platform/dsh/packages/video/video-workspace/`** —— 把服务能力注册成 21 个工具，
  并新增前端半部（帧图卡片、渲染任务卡、时间线卡、剪辑工作台面板）

`config/profile/cordis.patch.yml` 里的 **`goclip` 预设**承载系统提示词。它之所以要自建预设而不是改
全局配置：基座内置的 `preset-standard` 里有一行 scoped 的 `persona`，会**遮蔽**全局 persona，
而 patch 层只能定位顶层 loader 行、够不到预设内部 —— 所以唯一有效的做法是自己注册一个预设，
再把默认预设指过去。
