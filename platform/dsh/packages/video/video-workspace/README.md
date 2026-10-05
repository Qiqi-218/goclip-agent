# dsh-video-workspace

DSH 原生视频剪辑插件。它在 DSH 进程内注册 `video_*` 工具，调用 FFmpeg 和 Qwen Omni 完成视频导入、理解、检索、时间线编辑和导出。

持久数据使用私有 OSS：原始素材、项目 `manifest.json`、分析结果、中间产物和导出视频都上传 OSS；FFmpeg 只使用本地临时缓存，上传成功后清理。SQLite 仅作为本地索引和恢复缓存。

插件不依赖 Go 服务或 HTTP 剪辑服务。配置由 profile 的 `cordis.patch.yml` 提供，密钥通过 `runtime/.env.ps1` 注入启动进程。

## 只读媒体路由

工作台要把素材放进 `<video>` 并拖动进度条，而 DSH 基座不提供任何媒体路由（`webServer` 的注释原话：knows no harness concepts and serves no files）。所以本插件在 `ctx.webServer` 上注册一条**只读**路由，三种地址形式：

| 地址 | 内容 |
| --- | --- |
| `<前缀>/<项目>/<素材>` | 素材字节，支持 Range |
| `<前缀>/<项目>/<素材>/render/<任务>` | 成片字节 |
| `<前缀>/data/<项目>/<素材>/<维度>` | 测量结果的 JSON |

维度是路径**最后一段**，所以一条路由回答所有维度，而不是一个维度一条路由。未测量回 404、素材不存在也回 404、读取失败回 502 —— 三种结局必须能分辨，否则界面会把「还没算」和「算不出来」显示成同一句话。

**播放地址一律指向这条路由，不把 OSS 签名地址发进页面**：签名地址会带上 AccessKeyId，而且签在一段时间后就过期。

实测出来的三条 OSS 行为（`scripts/tools/verify/probe-oss-range.mjs`）：

| 事实 | 实测 |
| --- | --- |
| 签名 URL 支持 Range | `bytes=0-1023` → `206 Content-Range: bytes 0-1023/73370626` |
| **签名覆盖 HTTP 方法** | GET 签名发 HEAD → **403**，所以 HEAD 探测要单独签一份 |
| **OSS 不报 416** | 越界 Range → 静默回 **200 全量**，所以越界判定必须路由自己做 |

## 字幕样式

样式存在 `timelines.subtitle_style` 上（JSON，可空）。烧录时按成片**真实像素高度**把占比换算成字号与边距。三条取舍写在 `subtitle-style.ts` 的模块注释里，这里只记结论：

- **位置用九宫格加边距，不用坐标** —— 坐标在换画幅时会失效，九宫格不会。
- **字号与边距是画面高度的占比，不是像素** —— 否则 1080p 上合适的 28px 在 360p 上会占掉半个画面。
- **只提有问题的字段** —— 没提到的字段保持原值，所以「把字幕改成黄色」不会顺手把字号也重置。

拒绝时一次列出**全部**有问题的字段：一次只报一个会让模型来回三轮。

`@deepseek-ai/dsh-client-ui-workbench` 会读取同一份 `timelines.subtitle_style`，在播放器上提供近似预览；预览只用于选字体、颜色、描边、底框和位置，最终像素仍以导出阶段 FFmpeg/libass 的结果为准。

## Model Experience

### The `video_*` tool definitions

#### What the model sees

Every tool's name, description, and parameter list, as registered in `index.ts`. The descriptions are written from the model's side of the call and carry the facts a caller gets wrong otherwise — positions are asset microseconds rather than offsets, `base_revision` must be the revision just read, a moment the cut does not use has no place in the film.

##### The description of the timeline trim tool

```markdown
裁短某一段：edge 说明动哪一边（start= 开头往后推，end= 结尾往前提），delta_us 是移动量。必须明确说哪一边，不要猜。
```

#### Token effect

Conditional and fixed. The definitions are part of every request that offers these tools, and their size does not grow with the project: forty-odd tools carrying the descriptions above. Results are the other half and are capped where they are produced — the search and listing tools truncate with a stated `truncated` flag rather than returning an unbounded match set.

#### KV Cache effect

Append-only. A tool call appends its result, and this package never rewrites an earlier message. A `video_timeline_*` result reports the new revision as a new message rather than editing an old one, so the prefix stays reusable.

## Known Limitations and Deferred Work

- **`verify-export-jsdoc` 在本包上有 63 处报告**，全部是 fork 之前就存在的导出缺 JSDoc，不是本次改动引入的。逐条补齐是一笔独立的工作。
- **字幕样式的阴影只有偏移量，没有颜色** —— ASS 的 `Shadow` 只接受偏移，阴影颜色跟着 `BackColour` 走。因此有底框时阴影与底框二者只能取一，这一条写进了 `toAssStyle` 的注释；要真正的彩色阴影得改用 `drawtext` 滤镜逐条绘制。
- **浏览器预览不是最终成片** —— 工作台会在画面上提供字幕样式的近似预览，但浏览器字体替换、libass 字体和实际输出尺寸可能不同；最终效果以 `video_render_submit` 导出的成片为准。
- **`video_understand` 单次上传有 192 秒上限**，更长的素材走的是分段窗口；这个上限是模型侧的限制，不是本包的选择。
