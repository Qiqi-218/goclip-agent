package agent

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"unicode/utf8"

	"github.com/zylar06/video-agent/internal/analysis/provider"
)

// ToolSpec is the model-facing declaration of one action this service can
// perform. The Name must exactly match a case in Service.call: the schema here
// and the decoder there are two halves of the same contract, so a test asserts
// every declared tool is callable and every callable action is declared.
type ToolSpec struct {
	Name        string
	Description string
	Parameters  map[string]any
	// ReadOnly marks a tool that only observes. Read-only calls may run
	// concurrently with each other because they cannot race on project state.
	// Anything that writes — evidence, timelines, edits, renders — stays
	// serialized so revision numbers and generated ids stay deterministic.
	ReadOnly bool
}

// ConcurrencySafe reports whether this tool may join a parallel group.
func (s ToolSpec) ConcurrencySafe() bool { return s.ReadOnly }

func obj(props map[string]any, required ...string) map[string]any {
	if required == nil {
		required = []string{}
	}
	return map[string]any{"type": "object", "properties": props, "required": required, "additionalProperties": false}
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
func num(desc string) map[string]any { return map[string]any{"type": "integer", "description": desc} }
func bool_(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}
func arr(desc, itemType string) map[string]any {
	return map[string]any{"type": "array", "description": desc, "items": map[string]any{"type": itemType}}
}

// ToolSpecs returns every action an agent may invoke. Descriptions are written
// for a model deciding what to do next: they state when to use the tool and what
// has to exist first, not how it is implemented.
func (s *Service) ToolSpecs() []ToolSpec {
	specs := []ToolSpec{
		{
			Name:        "project_list",
			Description: "列出所有项目及其素材数量。用户问“有哪些项目/素材”或你不知道该用哪个项目时，先调用它，不要猜 id；asset_count 大于 0 的项目才有素材。",
			Parameters:  obj(map[string]any{}),
			ReadOnly:    true,
		},
		{
			Name:        "project_create",
			Description: "创建一个新项目，返回 project id。id 必须提供一个简短的英文标识（如 proj-001）；已存在的 id 会失败。导入素材前必须先有项目。",
			Parameters:  obj(map[string]any{"id": str("项目 id，简短英文标识，必填"), "name": str("项目名称，用于展示")}, "id", "name"),
		},
		{
			Name:        "project_get",
			Description: "按 id 读取项目。不知道 id 时先用 project_list。",
			Parameters:  obj(map[string]any{"id": str("项目 id")}, "id"),
			ReadOnly:    true,
		},
		{
			Name:        "assets_import",
			Description: "把一个本地视频文件导入项目（按内容哈希去重），返回 asset id 与时长、分辨率。用户拖入或选择了文件后调用。",
			Parameters:  obj(map[string]any{"project_id": str("所属项目 id"), "path": str("本地视频文件的绝对路径")}, "project_id", "path"),
		},
		{
			Name:        "assets_list",
			Description: "列出项目下已导入的素材。不确定素材 id 时先调用它。",
			Parameters:  obj(map[string]any{"project_id": str("项目 id")}, "project_id"),
			ReadOnly:    true,
		},
		{
			Name: "analyze",
			Description: "对素材做内容理解，生成带时间范围的证据：字幕／转写、" +
				"**默认同时抽帧看画面**（画面里发生的事、字幕没说的动作都能被检索到），" +
				"**并且默认量出逐秒音量曲线**（哪一秒变响、峰值在哪一秒）。" +
				"用户要按内容找片段前必须先调用；已有字幕文件时传 subtitle_path 可跳过语音识别。",
			Parameters: obj(map[string]any{
				"project_id":       str("项目 id"),
				"asset_id":         str("素材 id"),
				"subtitle_path":    str("可选的本地 SRT/VTT 路径"),
				"skip_visual":      bool_("设为 true 只做字幕理解、跳过抽帧；默认 false，即默认会抽帧看画面"),
				"skip_audio":       bool_("设为 true 跳过音量曲线；默认 false，即默认会量音量"),
				"provider":         str("可选的提供方标记"),
				"analyzer_version": str("可选的分析器版本标记"),
			}, "project_id", "asset_id"),
		},
		{
			Name: "shots",
			Description: "检测素材的镜头切分点，把全片切成若干「连续拍摄」的镜头区间，并把结果记为证据。" +
				"要按镜头边界精确下刀、想知道成片由几个镜头组成、或想验证某个画面到底持续多久时用它。" +
				"注意：它逐帧比对，耗时约为视频时长的三分之一，所以不必每次分析都跑；" +
				"跑过一次之后，视频检索的结果会自动带上所属镜头的边界。",
			Parameters: obj(map[string]any{
				"project_id":  str("项目 id"),
				"asset_id":    str("素材 id"),
				"skip_record": map[string]any{"type": "boolean", "description": "只检测不写入证据，默认 false"},
			}, "project_id", "asset_id"),
			ReadOnly: false,
		},
		{
			Name: "level_curve",
			Description: "读取素材的逐秒音量曲线（每 1 秒一个采样：起止时间、dBFS、是否峰值/升高/平稳）。" +
				"要在时间轴上画音量/情绪曲线、或想一眼看出全片哪里最响时用它；" +
				"它不走关键词检索，所以多长的素材都能一次拿全。",
			Parameters: obj(map[string]any{"project_id": str("项目 id"), "asset_id": str("素材 id")}, "project_id", "asset_id"),
			ReadOnly:   true,
		},
		{
			Name:        "evidence_add",
			Description: "写入一条带时间范围的证据。仅在用户提供了外部理解结果时使用，不要编造时间戳。",
			Parameters: obj(map[string]any{
				"id": str("证据 id"), "project_id": str("项目 id"), "asset_id": str("素材 id"),
				"start_us": num("起始微秒"), "end_us": num("结束微秒"),
				"asset_content_hash": str("素材内容哈希，需与素材一致"),
				"transcript":         str("该时间范围的字幕或转写"),
				"visual_summary":     str("该时间范围的画面描述"),
			}, "id", "project_id", "asset_id", "start_us", "end_us", "asset_content_hash"),
		},
		{
			Name: "find_in_video",
			Description: "让视觉模型直接看视频画面，找出「某个东西、某个画面」出现在哪些时间点。" +
				"当用户描述的是他看见过的画面（飞碟、进球、某人出镜、某张图、某种动作或表情），" +
				"就用这个工具，不要用 search 去猜关键词。" +
				"search 只能匹配已经写成文字的记录，画面里出现过但没人描述过的东西它找不到。" +
				"本工具会按你给的时间范围抽帧、逐帧问视觉模型，返回命中时间点与判断依据。" +
				"范围越小越快；可以先粗找一遍，再在命中的时间附近缩小范围确认。",
			Parameters: obj(map[string]any{
				"project_id": str("项目 id"),
				"asset_id":   str("素材 id"),
				"subject":    str("要找的东西，尽量用用户的原话，例如「飞碟」「进球瞬间」「有人在笑」"),
				"start_us":   num("可选，只看这段范围（微秒），省略表示从头"),
				"end_us":     num("可选，范围结束（微秒），省略表示到结尾"),
				"frames":     num("可选，抽查多少帧，默认 24，上限 60；范围大时适当提高"),
			}, "project_id", "asset_id", "subject"),
			// Reading frames observes the asset; it writes no project state, so
			// several visual questions may run alongside each other.
			ReadOnly: true,
		},
		{
			Name: "search",
			Description: "在**已经写成文字**的证据里做**字面**关键词检索（字幕文本、画面描述、音频事件名），返回带来源时间戳的命中。" +
				"只在两种情况下用它：① 用户说的词确实会出现在素材里；② 已知素材里被说出来的某个具体词。" +
				"⚠️ 它不理解语义，也检索不到**没有说出口**的信息，所以：" +
				"**不要用它找「精彩 / 高光 / 高潮 / 激动人心」这类没有具体所指的词** —— 搜不到是必然的，换同义词也一样；" +
				"这类需求改用 level_curve（响度峰值＝观众反应与情绪高点）、shots（切点密度＝节奏）、find_in_video（画面动作）。" +
				"**不要为同一个意图反复换词调用**：没命中就说明素材里没有这个词，count=0 是有效结果，请换工具而不是换词。",
			Parameters: obj(map[string]any{
				"project_id": str("项目 id"), "query": str("检索关键词，必须用素材里**确实出现过**的词"),
				"asset_ids": arr("限定素材，可省略", "string"), "limit": num("返回条数上限 1..100"),
			}, "project_id", "query", "limit"),
			// search only reads evidence. (The chat path can additionally trigger
			// analysis, but that is a cache-keyed upsert and does not race on
			// project state.)
			ReadOnly: true,
		},
		{
			Name:        "timeline_create",
			Description: "用给定的片段创建一个版本化时间线，返回时间线 id。这是成片的载体；确认方案后再创建。",
			Parameters: obj(map[string]any{
				"id": str("时间线 id"), "project_id": str("项目 id"), "revision": num("版本号，新建填 1"),
				"fps_num": num("帧率分子"), "fps_den": num("帧率分母"), "width": num("画面宽"), "height": num("画面高"),
				"items": map[string]any{"type": "array", "description": "片段列表", "items": obj(map[string]any{
					"id": str("片段 id"), "asset_id": str("素材 id"),
					"source_in_us": num("素材内起始微秒"), "source_out_us": num("素材内结束微秒"),
					"evidence_ids": arr("该片段依据的证据 id", "string"),
				}, "id", "asset_id", "source_in_us", "source_out_us")},
			}, "id", "project_id", "revision", "fps_num", "fps_den", "width", "height", "items"),
		},
		{
			Name:        "timeline_get",
			Description: "读取时间线当前版本或指定版本。改动前先读，拿到 revision 才能提交编辑。",
			Parameters:  obj(map[string]any{"id": str("时间线 id"), "revision": num("可选，指定版本号")}, "id"),
			ReadOnly:    true,
		},
		{
			Name:        "timeline_history",
			Description: "列出时间线的全部历史版本，用于回退或向用户说明改过什么。",
			Parameters:  obj(map[string]any{"id": str("时间线 id")}, "id"),
			ReadOnly:    true,
		},
		{
			Name:        "timeline_list",
			Description: "列出某个项目下的全部时间线（含当前版本）。用户问“这个项目剪过什么”或要接着改某条时间线时，先用它找到 timeline id。",
			Parameters:  obj(map[string]any{"project_id": str("项目 id")}, "project_id"),
			ReadOnly:    true,
		},
		{
			Name:        "proposal_create",
			Description: "按检索词生成一个待确认的剪辑提案（含候选片段与操作）。向用户展示候选、等待确认时使用。",
			Parameters:  obj(map[string]any{"timeline_id": str("时间线 id"), "query": str("检索词"), "limit": num("候选数量，默认 3")}, "timeline_id", "query"),
		},
		{
			Name:        "edit_apply",
			Description: "对时间线施加一次编辑操作（裁剪/替换/删除/插入/移动/锁定/恢复）。base_revision 必须等于当前版本，否则会冲突。",
			Parameters: obj(map[string]any{
				"id": str("操作 id"), "timeline_id": str("时间线 id"), "base_revision": num("基线版本号，须等于当前版本"),
				"kind":           str("操作类型：trim_clip|replace_clip|delete_clip|insert_clip|move_clip|lock_clip|unlock_clip|restore_revision"),
				"target_clip_id": str("目标片段 id"), "new_clip_id": str("新片段 id"), "asset_id": str("素材 id"),
				"source_in_us": num("素材内起始微秒"), "source_out_us": num("素材内结束微秒"),
				"duration_frames": num("时长帧数"), "index": num("插入位置"), "restore_revision": num("要恢复的版本号"),
			}, "id", "timeline_id", "base_revision", "kind"),
		},
		{
			Name:        "render_submit",
			Description: "异步渲染时间线并返回 job id。preview 为真时生成低开销预览，否则导出 MP4。提交后用 jobs_get 查询进度。",
			Parameters: obj(map[string]any{
				"timeline_id": str("时间线 id"), "revision": num("可选版本号"), "preview": bool_("是否只生成预览"),
				"filename": str("可选输出文件名"),
			}, "timeline_id"),
		},
		{
			Name:        "jobs_get",
			Description: "查询渲染任务状态与进度，完成后可拿到产物地址。",
			Parameters:  obj(map[string]any{"id": str("任务 id")}, "id"),
			ReadOnly:    true,
		},
		{
			Name:        "jobs_list",
			Description: "列出全部任务。用户问“渲染好了吗”而不知道 job id 时使用。",
			Parameters:  obj(map[string]any{}),
			ReadOnly:    true,
		},
		{
			Name:        "jobs_cancel",
			Description: "取消一个进行中的渲染任务。",
			Parameters:  obj(map[string]any{"id": str("任务 id")}, "id"),
		},
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].Name < specs[j].Name })
	return specs
}

// ModelTools projects the specs into the provider's wire format. Only name,
// description and parameters are model-visible.
func (s *Service) ModelTools() []provider.ToolDefinition {
	specs := s.ToolSpecs()
	out := make([]provider.ToolDefinition, 0, len(specs))
	for _, spec := range specs {
		out = append(out, provider.ToolDefinition{Name: spec.Name, Description: spec.Description, Parameters: spec.Parameters})
	}
	return out
}

// maxToolResultBytes caps what one tool may hand back to the model. Without a
// cap a single analyze call on a long asset floods the context window with
// evidence the model cannot use in one step, crowding out the conversation.
const maxToolResultBytes = 16000

// fragmentBudget is how much raw payload survives a clamp, leaving room for the
// JSON re-encoding's escape expansion plus the notice.
const fragmentBudget = 11000

// RunTool validates and executes one model-chosen action, returning the JSON
// result the model should see. Failures come back as an error string rather than
// a Go error so the agent loop can hand them to the model and let it recover.
func (s *Service) RunTool(ctx context.Context, name string, arguments string) (string, bool) {
	raw := json.RawMessage(arguments)
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	envelope := s.Call(ctx, name, raw)
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return `{"ok":false,"error":{"code":"encode_failed","message":"tool result could not be serialized"}}`, false
	}
	return clampToolResult(string(encoded)), envelope.OK
}

// clampToolResult truncates an oversized result while keeping it valid JSON and
// telling the model how to get the rest, so it narrows its next call instead of
// assuming the data ended. The fragment is re-encoded as a JSON string, which
// escapes quotes and backslashes, hence the headroom below the cap.
func clampToolResult(result string) string {
	if len(result) <= maxToolResultBytes {
		return result
	}
	notice := "结果过长已截断，仅保留前 " + strconv.Itoa(fragmentBudget) + " 字节。请改用更精确的参数（缩小 limit、指定 asset_id 或更具体的关键词）再次调用。"
	cut := fragmentBudget
	if cut > len(result) {
		cut = len(result)
	}
	// Cut on a rune boundary so the fragment stays valid UTF-8.
	for cut > 0 && !utf8.RuneStart(result[cut]) {
		cut--
	}
	wrapped, err := json.Marshal(map[string]any{"truncated": true, "notice": notice, "partial_json": result[:cut]})
	if err != nil {
		return `{"truncated":true,"notice":"` + notice + `"}`
	}
	return string(wrapped)
}
