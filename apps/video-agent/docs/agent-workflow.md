# 自动化调用流程（历史）

> 这是内部 API 的自动化回归参考，不是当前产品入口。创作者通过 Web 中的自然语言交互完成同一条“证据 → 方案 → 确认 → 导出”闭环。

自动化调用方通过内部 API 充当“规划与操作调用者”，不是剪辑引擎本身。每轮都重新读取当前 revision，不能依赖对话记忆。

1. `project_get`、`assets_list`、`timeline_get` 读取事实。
2. `analyze` 运行或复用 P2 分析；可传 `subtitle_path` 和 `visual:true`，也可使用配置好的 ASR/视觉 provider。若为 `model_unavailable`，要求调用方提供字幕或配置 provider，不能编造片段。
3. `search` 找到与自然语言目标相关的证据；`no_match` 时回答素材不足或请求澄清。
4. `proposal_create` 只生成草案。审阅每条来源范围后逐条执行 `edit_apply`。
5. 每个编辑后读取返回的 revision；遇到 `revision_conflict`，先 `timeline_get` 再重新规划，不重放旧 revision。
6. 需要保留时调用 `lock_clip`；需要回退时用 `restore_revision`。两者都是 `edit_apply` 的 operation kind。
7. 用 `render_submit` 发起预览或导出，轮询 `jobs_get`；只有 `completed` 且验证字段通过后读取 `/v1/artifacts/{job_id}`。

最小 HTTP 调用例：

```sh
curl -sS -X POST http://127.0.0.1:8090/v1/tools/search \
  -H 'Content-Type: application/json' \
  --data '{"project_id":"demo","query":"进球","limit":3}'
```

真实回放记录见 [B 站回放证据](evidence/p3-bilibili-replay.md)。该记录保存 URL、哈希、操作与验证结果，不保存视频、字幕或 Cookie。
