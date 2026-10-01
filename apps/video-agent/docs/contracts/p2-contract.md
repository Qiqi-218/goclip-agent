# F02：P2/P3 跨模块契约（v1）

本文件冻结 P1 之后新增分析与检索接口的 v1 边界。P1 CLI、时间线和 `RenderJob` JSON 维持原样；新 CLI/API 在 P3 才包入统一 envelope，届时必须标明 `api_version: "v1"`。所有对象 JSON 使用 `snake_case`，标识符在其所属项目内唯一，时间一律用整数微秒。

## 领域对象

- `Evidence`：某一 `project_id`、`asset_id` 的半开源区间 `[start_us,end_us)`；至少有一种证据（转写、视觉摘要或帧引用）。`asset_content_hash` 是分析时的输入哈希，禁止用路径作缓存键。
- `AnalysisRequest`：项目、素材、`analyzer_version`、`provider` 与无密钥的 `parameters`。`cache_key` 是 SHA-256（素材内容哈希、分析器版本、provider、规范化参数）的组合；不同项目不共享可见证据。
- `AnalysisResult`：`status` 为 `completed`、`no_match`、`failed` 或 `cancelled`。`completed` 可含零条 evidence；`no_match` 专用于检索/规划层，分析器未发现内容应返回 `completed` 加空数组。
- `SearchRequest`：在单个项目中查询，`asset_ids` 为空代表项目所有资产，`limit` 为 1--100。结果按 `score` 降序、再按 `evidence.id` 升序稳定排序。
- `EditProposal`：仅是未提交建议；每个 clip 仍以来源区间标识。提交时必须走现有 `EditOperation`、`base_revision` 与幂等 `operation_id`，不能直接写 SQLite。

## 取消、错误与兼容

调用方取消 `context` 后 provider 应尽快停止，持久任务最终状态为 `cancelled`，绝不能变为 `completed`。稳定错误码如下：`invalid_request`、`not_found`、`no_match`、`model_unavailable`、`timeout`、`budget_exhausted`、`cancelled`、`revision_conflict`、`internal`。错误响应可包含可展示的 `message`，但业务分支只依赖 `code`。

P2 的 provider 不创建后台 goroutine/队列；P3 的任务系统负责调度、进度和取消。P1 的同步 `render` 行为不改；P3 新入口须把旧命令的结果映射为 v1 envelope，并保留原字段。

## 存储与迁移规则

迁移编号由 B 按合并顺序分配，格式为六位递增号（例如 `000002_evidence.sql`）；已合并迁移永不修改或复用编号。A 先提交本契约和迁移需求，不能直接改变共享 schema。迁移必须前向、事务化、可在含 P1 项目/版本/任务的数据库上执行；需要回退时发布新的前向迁移。新增证据表必须以 `project_id` 和 `asset_id` 隔离，索引缓存键，且保留分析器/输入哈希以防错误复用。

## 可执行 mock 边界

`internal/catalog` 是分析、证据仓库和规划器之间的唯一 Go 边界。`StaticCatalog` 只用于无网络测试：它根据请求返回预置分析或搜索结果，不读取模型账户、不访问网络。其行为由 `go test ./internal/catalog` 锁定；JSON 示例在 [v1-examples.json](v1-examples.json)。
