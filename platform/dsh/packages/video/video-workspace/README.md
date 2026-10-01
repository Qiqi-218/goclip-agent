# @deepseek-ai/dsh-video-workspace

智能剪辑助手：把本地 `video-agent` 服务的剪辑能力交给 DeepSeek Harness 的 agent 调用。

## Summary

这个插件注册一组 `video_*` 工具，让对话里的 agent 能自己完成一次剪辑：创建项目、把素材拉进来、理解素材（字幕 + 抽帧看画面）、按用户描述的画面去找时间点、检索已写下来的证据、建时间线、提交渲染、查进度。

它自己不存数据、不渲染、不调模型：素材、证据、时间线、ffmpeg 渲染全在 `video-agent` 服务里。插件只做两件事——把服务的动作声明成工具，以及把服务的拒绝原样交回给模型。

`video_find_in_video` 是这个包存在的理由：它让**视觉模型真的去看画面**（抽帧、逐帧提问），而不是拿关键词去猜。用户说「把有飞碟图片那里剪一下」时，正确的做法是看画面，不是检索文字。

## Use this package

```yaml
- insert:
    - id: video-workspace
      name: dsh-video-workspace
      config:
        endpoint: http://127.0.0.1:8090
        timeoutMs: 900000
        framePreviewScale: 0.5
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:8090` | `video-agent` 服务的基址。服务默认只监听回环地址，因为比赛要求作品不得仅靠公网可达来评审、也不允许把本地实例直接暴露到公网 |
| `timeoutMs` | `900000` | 单次动作的截止时间。`analyze` 与 `find_in_video` 每抽一帧就要问一次视觉模型，所以默认给得比较宽 |
| `framePreviewScale` | `0.5` | 把视觉模型实际看过的帧作为图片交回给模型时的缩放比例，0 表示不回传图片。回传让视觉判断可核对，代价是图片 token |

服务必须先运行：

```sh
video-agent --data <数据目录> serve --addr 127.0.0.1:8090
```

## Understand the implementation

工具名与参数**逐字对齐**服务自己的动作声明（`internal/agent/toolspec.go`）。这份重复是刻意的：harness 在编译期就要拿到静态工具 schema，而服务在 dispatch 时还会用 `DisallowUnknownFields` 再校验一次。两边的字段名必须一致，否则调用会在解码处失败。

工具集与服务的动作集**必须相等**：scripts/check-action-parity.mjs 从服务的 dispatch 里读出动作名、从构建产物里读出注册的工具名，任一边多一个或少一个就退出码 1。这条检查是必要的——实践里模型确实撞上过缺口（没有编辑工具，于是它改用 shell 去调服务的 HTTP 动作）。

服务返回的信封是 `{api_version, ok, result?, error?}`。`ok:false` 是**有语义的拒绝**（素材 id 不存在、revision 冲突），不是传输故障，所以 `VideoAgentClient` 把它抛成带 `code`/`message` 的 `VideoAgentError`，让模型看到服务自己的措辞并据此换做法。

只读动作（列项目、列素材、看画面、检索、读时间线、查任务）标了 `isConcurrencySafe`，可以并行；任何推进 revision 的动作保持串行。

### 源码地图

- `src/index.ts` — 工具注册，模型可见的措辞都在这里
- `src/client.ts` — 服务信封与错误分类
- `src/config.ts` — 部署配置

## Further Exploration

- `video-agent` 的 `internal/agent/toolspec.go` — 动作声明的权威来源
- [添加一个工具](../../../docs/cookbook/adding-a-tool.md)

## Model Experience

### 工具

19 个 `video_*` 工具在插件挂载时注册 —— 与服务的 19 个动作**逐一对应**，由 `pnpm run check:parity` 双向断言。每个调用把结果 JSON 追加进 transcript。

描述是按「模型下一步该做什么」写的：说清什么时候该用它、什么必须先存在、以及什么情况下该换另一个工具。`video_find_in_video` 与 `video_search` 的描述互相指路，因为把这两者搞混是这个场景里最容易犯的错。

### Token 影响

工具声明常驻上下文。每次调用追加它返回的结果；`analyze` 与 `find_in_video` 的结果可能很长，由 harness 的结果裁剪机制兜底。

## Known Limitations and Deferred Work

- **没有任何测试。** 这个包目前只有一个 `apply` 和一份客户端，行为验证靠端到端跑一遍真实素材，没有单元测试或快照测试。
- **不发布 `./invariant`。** 这个包不持有任何独立状态：它不缓存、不派发、不订阅，每个工具都是一次请求-响应。没有可以互相偏离的观察，因此按规则省略 invariant 配套。
- **没有客户端一半。** 目前只有 host 侧工具，视频工作台面板（时间轴、情绪曲线、内嵌播放器）还没做。
- **帧回传还没接线。** `framePreviewScale` 已经进了配置，但把 JPEG 作为图片内容块回传的路径还没实现，所以现在模型只能看到视觉模型写的判断依据，看不到帧本身。
