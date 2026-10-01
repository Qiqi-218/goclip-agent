# 工程 CLI 使用与数据契约（历史）

> 面向创作者的产品入口是 Web 页面。本文保留底层 CLI 的调试、自动化回归和历史验收方法，不是当前产品使用说明。

底层 CLI 提供无需模型的本地视频工程服务。依赖 Go 1.24+、FFmpeg/ffprobe 6+，FFmpeg 需要 libx264 和 AAC 编码器。当前开发验收环境见 [验收记录](p1-acceptance.md)。

## 从自己的素材开始

在仓库根目录运行：

```sh
go build -o bin/video-agent ./cmd/video-agent
bin/video-agent --data data/demo project create --id demo --name "我的项目"
bin/video-agent --data data/demo assets import --project demo --path /绝对路径/视频一.mp4
bin/video-agent --data data/demo assets import --project demo --path /绝对路径/视频二.mov
```

导入返回 `asset-<完整 SHA256>`。把返回的两个 ID 填入 [时间线样例](../examples/timeline.json) 的 `asset_id`；根据自己的素材调整源区间。样例取两段各 18 秒，素材必须足够长。

```sh
bin/video-agent --data data/demo timeline create --file examples/timeline.json
bin/video-agent --data data/demo render preview --timeline demo-timeline
bin/video-agent --data data/demo edit apply --file examples/trim.json
bin/video-agent --data data/demo render export --timeline demo-timeline
bin/video-agent --data data/demo timeline history --id demo-timeline
```

预览与导出返回 `output`、`job_id` 对应的 `id`、revision、渲染计划和校验结果。可用系统播放器打开 `output`。不指定 `--output` 时，每次生成独立的 `data/demo/exports/<任务ID>.mp4`；指定路径时必须是尚不存在的 `.mp4`。

```sh
bin/video-agent --data data/demo jobs get --id <任务ID>
bin/video-agent --data data/demo timeline get --id demo-timeline --revision 1
bin/video-agent --data data/demo render export --timeline demo-timeline --revision 1
```

所有业务结果输出 JSON 到 stdout；错误输出 JSON 到 stderr 并返回非零退出码。`--file -` 接收 stdin 的一个 JSON 对象。`--data` 必须位于命令前。帮助：`bin/video-agent --help`。此处是 P1 操作入口；P3 的统一工具、异步接口和 HTTP 使用说明见 [API 文档](api.md)。MCP 仍未实现。

## 时间与编辑规则

- 一条主视频轨，片段按数组顺序连续排列，没有空隙或重叠。`start_frame` 由服务重排；创建时可省略。
- 源入点含、出点不含，单位微秒；输出时长单位帧。P1 固定 1 倍速，`duration_frames = round((out-in) × fps / 1,000,000)`。省略时由服务计算；显式值不匹配则拒绝。
- 帧率用 `fps_num / fps_den` 表达，支持例如 `30000/1001`。输出尺寸为偶数。源素材按比例缩放并补黑边，保留原声；无声和短音轨补静音，统一为 48 kHz 双声道 AAC。
- 输入路径只接受本地普通文件。导入保留内容寻址副本，重复文件在同一工程内复用资产 ID；渲染前重新校验副本哈希。
- 每个素材属于一个项目，不能跨项目引用未导入的素材。相同文件可以导入另一个项目并共享内容副本。
- `base_revision` 必须匹配当前版本。revision、操作记录、当前版本指针在同一个 SQLite 事务中提交；历史版本不覆盖。
- 操作 ID 在同一时间线内唯一。同 ID、同载荷重试返回原版本；同 ID、不同载荷返回 `operation_id_reuse`。旧版本返回 `revision_conflict`。
- 锁定保护片段内容和成片位置；影响锁定片段位置的前部裁剪、插入或重排也会失败。先明确解锁才能继续。
- `restore_revision` / `undo` 是显式工程恢复，允许恢复历史锁定状态；它们创建新 revision，而不是改写历史。`undo` 恢复当前版本的父版本内容，连续 `undo` 不是独立的撤销栈。

| kind | 必要参数 | 语义 |
| --- | --- | --- |
| `trim_clip` | `target_clip_id`，`duration_frames` 或 `source_in_us` + `source_out_us` | 按帧缩短尾部，或指定当前区间的子区间；同步源出点 |
| `replace_clip` | `target_clip_id`、`asset_id`、源入出点 | 保留片段 ID，替换内容，重新计算时长并清除旧证据 |
| `insert_clip` | `new_clip_id`、`asset_id`、源入出点、`index` | 在零基索引处插入；允许末尾追加 |
| `delete_clip` | `target_clip_id` | 删除后其余片段连续排列 |
| `move_clip` | `target_clip_id`、`index` | 移动到最终零基索引 |
| `lock_clip` / `unlock_clip` | `target_clip_id` | 修改锁定状态 |
| `restore_revision` | `restore_revision` | 将指定历史版本内容提交为新版本 |
| `undo` | 无额外参数 | 将父版本内容提交为新版本 |

每个操作还必须包含 `id`、`timeline_id`、`base_revision`、`kind`。

## 预览、导出与状态

P1 渲染同步执行，任务和精确渲染计划持久化；结束后可按返回的任务 ID 查询记录。预览最长边最多 640 像素，时间线内容、时长和音频与导出相同。P3 的 `render_submit` 将同一渲染语义包装为 queued/running/completed/cancelled 的异步任务。

先生成同目录临时文件，再验证 H.264/AAC、分辨率、帧率、帧数、时长，并用 FFmpeg 完整解码视频和音轨。成功后以不覆盖已有路径的原子硬链接发布，再将任务标为 `completed`。错误和正常取消会保存 `failed` / `cancelled`，清理临时文件。`plan.inputs` 保留源资产、片段 ID、源入出点和输出帧区间。

强制杀进程或断电后的任务租约恢复、自动重试、临时文件回收属于后续阶段；P1 不会把遗留 `running` 自动标记为成功，也不提供后台任务调度器。可从已保存 revision 重新执行导出到新路径。

工程目录包含 `video-agent.db`、`assets/`、`exports/`。当前资产记录使用绝对路径，P1 工程不支持直接搬移目录后自动修复路径。

## 实现边界与 GoClip 关系

沿用 GoClip 的 Go + modernc SQLite、本地媒体子进程、产物验证思路。GoClip 的内部模块耦合旧单源模型，并受 Go `internal` 导入边界限制，因此新项目实现独立的多源服务和渲染编译器，不直接链接或修改旧数据库。旧 GoClip 仍然是独立项目。

尚未提供 ASR、视觉分析、语义选片、字幕/BGM、Web 编辑器、HTTP API、MCP 或独立模型循环。P1 的完成只代表确定性编辑与渲染层通过验收。
