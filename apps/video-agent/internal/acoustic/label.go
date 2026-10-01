package acoustic

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// EventLabel is what a loud stretch sounds like, in words a user would use.
//
// The set is closed on purpose. A model asked for free-form labels returns a
// different phrase every time, and identical events then fail to match the same
// query; a fixed vocabulary is what makes 「哪里在鼓掌」 a lookup instead of a
// guess. The values are the words a Chinese user actually types.
type EventLabel string

// The labelled events. Anything outside this set is discarded rather than
// stored, so the dimension never accumulates phrases nothing can query.
const (
	EventLaughter   EventLabel = "笑声"
	EventApplause   EventLabel = "掌声"
	EventCheers     EventLabel = "欢呼"
	EventMusic      EventLabel = "音乐"
	EventSpeech     EventLabel = "说话声"
	EventSilence    EventLabel = "安静"
	EventNoise      EventLabel = "噪声"
	EventUnlabelled EventLabel = ""
)

// Labels is the closed vocabulary, exported so a caller can validate against it
// without repeating the list.
var Labels = []EventLabel{
	EventLaughter, EventApplause, EventCheers, EventMusic,
	EventSpeech, EventSilence, EventNoise,
}

// EventWindow is one stretch of the curve offered to the labeller: when it is,
// and how loud, in the terms the labeller reasons about.
type EventWindow struct {
	// StartUS and EndUS bound the stretch.
	StartUS int64
	EndUS   int64
	// PeakDB is the loudest second in the stretch.
	PeakDB float64
	// FloorDB is the recording's quiet level, for comparison.
	FloorDB float64
	// SustainedSeconds is how many seconds of the stretch sit near its peak,
	// which separates a burst from a continuous sound.
	SustainedSeconds int
	// Transcript is what was said here, when that is known. A laugh track and a
	// speaker's emphasis are the same waveform; the words are what tell them
	// apart, so the labeller gets whatever the transcript holds for this range.
	Transcript string
}

// Labeller names what a stretch of audio sounds like.
//
// It is supplied by the caller rather than built here, because naming an event
// needs a model and this package measures rather than reasons.
type Labeller interface {
	Label(ctx context.Context, windows []EventWindow) (map[int64]EventLabel, error)
}

// NameMarginDB is how far above the recording's own floor a second must sit to
// join a stretch offered for naming. It sits below the peak share used for
// display so a stretch is named as a whole: naming only the loudest second of an
// applause would leave the rest of it unsearchable.
const NameMarginDB = 6.0

// LabelWindows groups a curve's excursions into stretches worth naming.
//
// Naming is asked once per stretch rather than once per second: adjacent loud
// seconds are one event to a listener, and asking per second would both cost a
// request each and produce a different word for each second of the same laugh.
//
// @param curve - the measured curve.
// @param minMarginDB - how far above the floor a second must sit to join a stretch.
// @returns the stretches, in time order.
func LabelWindows(curve Curve, minMarginDB float64) []EventWindow {
	if len(curve.LevelsDBFS) == 0 {
		return nil
	}
	out := []EventWindow{}
	var current *EventWindow
	for i, db := range curve.LevelsDBFS {
		loud := db-curve.FloorDB >= minMarginDB
		if !loud {
			if current != nil {
				out = append(out, *current)
				current = nil
			}
			continue
		}
		if current == nil {
			current = &EventWindow{
				StartUS:          int64(i) * WindowUS,
				EndUS:            int64(i+1) * WindowUS,
				PeakDB:           db,
				FloorDB:          curve.FloorDB,
				SustainedSeconds: 1,
			}
			continue
		}
		current.EndUS = int64(i+1) * WindowUS
		current.SustainedSeconds++
		if db > current.PeakDB {
			current.PeakDB = db
		}
	}
	if current != nil {
		out = append(out, *current)
	}
	return out
}

// LabelerPrompt is the instruction given to the labelling model.
//
// It states the closed vocabulary and demands JSON, because the answer is parsed
// and a prose reply would be dropped. It also says the input is measurements
// only: the model cannot hear the audio, and a prompt that let it believe
// otherwise would invite invented detail.
const LabelerPrompt = `你在标注一段视频里"声音事件"的时间段。

输入是**声学测量结果**，不是音频本身：每个时间段给出起止时间、峰值音量、底噪、
持续秒数，以及该时间段已知的字幕文本（可能为空）。你看不到画面也听不到声音，
所以只能根据这些数字和文字判断，**不要编造输入里没有的信息**。

可选标签只有这些，必须从中选一个：
笑声 / 掌声 / 欢呼 / 音乐 / 说话声 / 安静 / 噪声

判断依据：
- 持续较久、音量中等且平稳，且有字幕文字 → 说话声
- 短促爆发（1-3 秒），峰值远高于底噪 → 笑声 或 掌声 或 欢呼（按字幕内容与常识选）
- 长时间持续、音量平稳且无字幕 → 音乐
- 峰值很高但没有字幕、持续很短 → 噪声

严格输出 JSON 数组，每项形如 {"start_us": <整数>, "label": "<标签>"}，
不要输出任何其它文字。start_us 必须与输入的某一段完全一致。`

// ModelLabeller asks a text model to name each stretch.
type ModelLabeller struct {
	// Ask sends one prompt under the given system message and returns the reply.
	Ask func(ctx context.Context, system, prompt string) (string, error)
}

// Label names each stretch, dropping anything outside the vocabulary.
//
// A model reply that cannot be parsed yields no labels rather than an error: the
// measured level is already stored, and losing a name is a smaller loss than
// failing the whole analysis because one reply was malformed.
//
// @param ctx - cancellation for the request.
// @param windows - the stretches to name.
// @returns labels keyed by each stretch's start, empty when nothing was named.
func (m ModelLabeller) Label(ctx context.Context, windows []EventWindow) (map[int64]EventLabel, error) {
	if m.Ask == nil || len(windows) == 0 {
		return map[int64]EventLabel{}, nil
	}
	payload, err := json.Marshal(windows)
	if err != nil {
		return nil, err
	}
	reply, err := m.Ask(ctx, LabelerPrompt, string(payload))
	if err != nil {
		return nil, err
	}
	return parseLabels(reply, windows), nil
}

// parseLabels reads the model's answer and keeps only entries that name a known
// event at a stretch that was actually offered.
//
// Both checks matter: an unknown word would never match a query, and a start
// time the caller never sent would attach a name to a moment nothing measured.
//
// @param reply - the model's raw answer.
// @param windows - the stretches that were offered.
// @returns labels keyed by stretch start.
func parseLabels(reply string, windows []EventWindow) map[int64]EventLabel {
	offered := map[int64]bool{}
	for _, window := range windows {
		offered[window.StartUS] = true
	}
	type entry struct {
		StartUS int64  `json:"start_us"`
		Label   string `json:"label"`
	}
	var entries []entry
	if err := json.Unmarshal([]byte(extractJSON(reply)), &entries); err != nil {
		return map[int64]EventLabel{}
	}
	out := map[int64]EventLabel{}
	for _, item := range entries {
		label := EventLabel(strings.TrimSpace(item.Label))
		if !offered[item.StartUS] || !knownLabel(label) {
			continue
		}
		out[item.StartUS] = label
	}
	return out
}

// knownLabel reports whether a label is in the closed vocabulary.
// @param label - the candidate.
// @returns true when the vocabulary contains it.
func knownLabel(label EventLabel) bool {
	for _, allowed := range Labels {
		if label == allowed {
			return true
		}
	}
	return false
}

// extractJSON returns the outermost JSON array in a reply.
//
// Models wrap JSON in prose or a fenced block even when told not to. Rejecting
// the whole reply for that would lose labels that are perfectly readable, so the
// array is located and the surrounding text ignored.
//
// @param reply - the model's raw answer.
// @returns the substring that starts at the first `[` and ends at the last `]`.
func extractJSON(reply string) string {
	start := strings.Index(reply, "[")
	end := strings.LastIndex(reply, "]")
	if start < 0 || end <= start {
		return reply
	}
	return reply[start : end+1]
}

// ApplyLabels writes each stretch's name onto the seconds it covers.
//
// The name is written onto every second of the stretch rather than onto one row,
// because retrieval matches a second at a time and a query like 「掌声在哪」 must
// find the middle of the applause, not only its first second.
//
// @param rows - the measured rows to annotate.
// @param labels - labels keyed by stretch start.
// @param windows - the stretches that were labelled.
// @returns the rows with `event_label` set where a name applies.
func ApplyLabels(rows []EventRow, labels map[int64]EventLabel, windows []EventWindow) []EventRow {
	if len(labels) == 0 {
		return rows
	}
	for i := range rows {
		for _, window := range windows {
			label, ok := labels[window.StartUS]
			if !ok {
				continue
			}
			if rows[i].StartUS >= window.StartUS && rows[i].StartUS < window.EndUS {
				rows[i].EventLabel = label
			}
		}
	}
	return rows
}

// EventRow is one measured second as the labelling step sees it.
type EventRow struct {
	// StartUS is the second's start.
	StartUS int64
	// DBFS is its measured level.
	DBFS float64
	// Summary is the sentence the analyzer wrote for it.
	Summary string
	// EventLabel is the named event, empty until labelling runs.
	EventLabel EventLabel
}

// LabelStretches is the whole labelling pass over a curve: group, ask, apply.
//
// It is separate from Evidence so the measurement can be stored even when no
// model is available — a curve with no names is still the loudness dimension,
// while a name with no curve would be a claim with nothing behind it.
//
// @param ctx - cancellation for the request.
// @param labeller - the model to ask, or nil to skip naming.
// @param curve - the measured curve.
// @param minMarginDB - how far above the floor a second must sit to join a stretch.
// @param transcripts - what was said at a given time, for the labeller's context.
// @returns the labelled rows.
// @throws when the labeller fails, so the caller can decide whether to keep the
// unlabelled measurement.
func LabelStretches(
	ctx context.Context,
	labeller Labeller,
	curve Curve,
	minMarginDB float64,
	transcripts func(startUS, endUS int64) string,
) ([]EventRow, error) {
	rows := Rows(curve)
	if labeller == nil {
		return rows, nil
	}
	windows := LabelWindows(curve, minMarginDB)
	if len(windows) == 0 {
		return rows, nil
	}
	if transcripts != nil {
		for i := range windows {
			windows[i].Transcript = transcripts(windows[i].StartUS, windows[i].EndUS)
		}
	}
	// One request per batch keeps a two-hour recording from becoming one request
	// per excursion, which would be both slow and expensive.
	const perBatch = 40
	labels := map[int64]EventLabel{}
	for start := 0; start < len(windows); start += perBatch {
		end := start + perBatch
		if end > len(windows) {
			end = len(windows)
		}
		batch, err := labeller.Label(ctx, windows[start:end])
		if err != nil {
			return rows, fmt.Errorf("label windows %d-%d: %w", start, end, err)
		}
		for at, label := range batch {
			labels[at] = label
		}
	}
	return ApplyLabels(rows, labels, windows), nil
}

// LabelSummary reports how many stretches were named, for a log or a result.
// @param rows - the labelled rows.
// @returns a one-line summary.
func LabelSummary(rows []EventRow) string {
	counts := map[EventLabel]int{}
	for _, row := range rows {
		if row.EventLabel != "" {
			counts[row.EventLabel]++
		}
	}
	if len(counts) == 0 {
		return "no events named"
	}
	parts := make([]string, 0, len(counts))
	for label, count := range counts {
		parts = append(parts, fmt.Sprintf("%s×%d", label, count))
	}
	sort.Strings(parts)
	return strings.Join(parts, " ")
}
