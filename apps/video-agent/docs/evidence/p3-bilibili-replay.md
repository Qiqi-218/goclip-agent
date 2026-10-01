# P3 外部 Agent 回放：B 站真实素材

- 日期：2026-10-01（Asia/Shanghai）
- 宿主：本地 `video-agent` v1 HTTP API，`127.0.0.1:8091`
- 输入：`https://www.bilibili.com/video/BV1P5h16JE8n/`
- 素材：299.833313 秒，1920×1080，AV1/AAC；导入内容哈希 `5601170d3db82c9c179143b8b2d17b1dea60db35b3adda3fa96a8e348f37e087`
- 来源证据：平台字幕的三段人工核对范围，以 `bilibili-platform-srt-v1` / `bilibili_platform_subtitle` 写入；视频、字幕和 Cookie 均未纳入仓库。

## 回放

1. 创建 `bili-p3` 项目，导入本地受控素材，创建空时间线 `bili-cut`。
2. 加入三个带源范围的字幕证据；`proposal_create(query="AI", limit=2)` 返回两个候选及连续 revision 操作。
3. 连续提交：插入候选 1（revision 2）、插入候选 2（3）、锁定候选 1（4）、缩短候选 2（5）、替换候选 2（6）。
4. 模拟会话中断后重新 `timeline_get`；用旧的 `base_revision=5` 提交修改，API 正确返回 `revision_conflict`，未误写数据。
5. 用 `restore_revision=5` 生成 revision 7，恢复缩短版本；`render_submit` 返回 queued job，随后完成。

导出任务 `e83a0edc5771b24bb297527ac929baf0` 的验证：1920×1080、222 帧、7,400,000 微秒、SHA-256 `b455d83b99be4c8976b9eb2b30be2e2a5598becb4cf667d659d3a07149914f55`，`probe_passed=true`、`decode_passed=true`。`Range: bytes=0-1023` 返回 `206 Partial Content` 和 `Accept-Ranges: bytes`。

另提交 299.833 秒的真实渲染任务 `a34cfd31073d1f69decb12471c653cff` 后立即取消；最终状态为 `cancelled`、错误为 `context canceled`，且没有发布 `cancel-me.mp4`。这证明取消不会把失败任务标记成完成，也不会泄漏部分成片。
