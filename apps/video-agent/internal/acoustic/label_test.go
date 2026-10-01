package acoustic

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/zylar06/video-agent/internal/domain"
)

// stubLabeller answers with a fixed reply, and records what it was asked.
type stubLabeller struct {
	reply   string
	err     error
	asked   []EventWindow
	batches int
}

func (s *stubLabeller) Label(_ context.Context, windows []EventWindow) (map[int64]EventLabel, error) {
	s.batches++
	s.asked = append(s.asked, windows...)
	if s.err != nil {
		return nil, s.err
	}
	return parseLabels(s.reply, windows), nil
}

// TestParseLabelsKeepsOnlyKnownEventsAndOfferedStretches is the guard that makes
// the vocabulary closed: an unknown word would never match a query, and a start
// time the caller never sent would attach a name to a moment nothing measured.
func TestParseLabelsKeepsOnlyKnownEventsAndOfferedStretches(t *testing.T) {
	windows := []EventWindow{{StartUS: 0}, {StartUS: 5_000_000}}
	reply := `[
	  {"start_us": 0, "label": "掌声"},
	  {"start_us": 5000000, "label": "笑声"},
	  {"start_us": 9999999, "label": "欢呼"},
	  {"start_us": 0, "label": "不知道是什么"}
	]`
	got := parseLabels(reply, windows)
	if len(got) != 2 {
		t.Fatalf("kept %d labels, want 2: %v", len(got), got)
	}
	if got[0] != EventApplause || got[5_000_000] != EventLaughter {
		t.Fatalf("labels: %v", got)
	}
}

// TestParseLabelsDiscoversJSONInProse covers what models actually return: JSON
// wrapped in a sentence or a fenced block despite being told not to. Rejecting
// the whole reply would discard labels that are perfectly readable.
func TestParseLabelsDiscoversJSONInProse(t *testing.T) {
	windows := []EventWindow{{StartUS: 0}}
	for _, reply := range []string{
		"好的，结果如下：\n```json\n[{\"start_us\":0,\"label\":\"掌声\"}]\n```\n希望有帮助。",
		"结果：[{\"start_us\":0,\"label\":\"掌声\"}] 以上。",
		"```\n[{\"start_us\":0,\"label\":\"掌声\"}]\n```",
	} {
		got := parseLabels(reply, windows)
		if got[0] != EventApplause {
			t.Fatalf("reply %q produced %v", reply, got)
		}
	}
}

// TestParseLabelsSurvivesGarbage keeps a malformed reply from failing the run:
// the measured level is already recorded, so losing a name is the smaller loss.
func TestParseLabelsSurvivesGarbage(t *testing.T) {
	windows := []EventWindow{{StartUS: 0}}
	for _, reply := range []string{"", "no json here", "{not an array}", "[{\"start_us\":"} {
		if got := parseLabels(reply, windows); len(got) != 0 {
			t.Fatalf("reply %q produced %v, want nothing", reply, got)
		}
	}
}

// TestLabelWindowsGroupsAdjacentLoudSeconds proves naming is asked once per
// stretch: adjacent loud seconds are one event to a listener, and asking per
// second would produce a different word for each second of the same laugh.
func TestLabelWindowsGroupsAdjacentLoudSeconds(t *testing.T) {
	// Quiet, three loud seconds, quiet, one loud second, quiet.
	raw := append(append(flat(2, 0.01), tone(3, 0.9)...), flat(2, 0.01)...)
	raw = append(raw, tone(1, 0.9)...)
	raw = append(raw, flat(2, 0.01)...)
	curve, err := measureStream(&reader{data: raw, step: 8192})
	if err != nil {
		t.Fatal(err)
	}
	windows := LabelWindows(curve, 12)
	if len(windows) != 2 {
		t.Fatalf("grouped into %d stretches, want 2: %+v", len(windows), windows)
	}
	if windows[0].StartUS != 2*WindowUS || windows[0].EndUS != 5*WindowUS {
		t.Fatalf("first stretch %d-%d, want seconds 2..4", windows[0].StartUS, windows[0].EndUS)
	}
	if windows[0].SustainedSeconds != 3 {
		t.Fatalf("first stretch sustained %d seconds, want 3", windows[0].SustainedSeconds)
	}
	if windows[1].StartUS != 7*WindowUS || windows[1].EndUS != 8*WindowUS {
		t.Fatalf("second stretch %d-%d, want second 7", windows[1].StartUS, windows[1].EndUS)
	}
}

// TestLabelWindowsFindsNothingInAFlatRecording is the honest case: with no
// excursion there is no event to name, and inventing one would put a word in the
// evidence that nothing measured.
func TestLabelWindowsFindsNothingInAFlatRecording(t *testing.T) {
	curve, err := measureStream(&reader{data: flat(10, 0.05), step: 8192})
	if err != nil {
		t.Fatal(err)
	}
	if windows := LabelWindows(curve, 12); len(windows) != 0 {
		t.Fatalf("a flat recording produced %+v", windows)
	}
}

// TestApplyLabelsNamesEverySecondOfTheStretch pins the coverage rule: retrieval
// matches a second at a time, so a query like 「掌声在哪」 must find the middle of
// the applause, not only its first second.
func TestApplyLabelsNamesEverySecondOfTheStretch(t *testing.T) {
	rows := []EventRow{{StartUS: 0}, {StartUS: 1_000_000}, {StartUS: 2_000_000}, {StartUS: 3_000_000}}
	windows := []EventWindow{{StartUS: 1_000_000, EndUS: 3_000_000}, {StartUS: 3_000_000, EndUS: 4_000_000}}
	labels := map[int64]EventLabel{1_000_000: EventApplause, 3_000_000: EventMusic}
	got := ApplyLabels(rows, labels, windows)

	want := []EventLabel{EventUnlabelled, EventApplause, EventApplause, EventMusic}
	for i, row := range got {
		if row.EventLabel != want[i] {
			t.Fatalf("row %d label %q, want %q", i, row.EventLabel, want[i])
		}
	}
}

// TestLabelStretchesPassesMeasuredContextToTheLabeller proves the labeller is
// given what it can reason about, including the transcript, and that the rows it
// returns carry both the measurement and the name.
func TestLabelStretchesPassesMeasuredContextToTheLabeller(t *testing.T) {
	raw := append(append(flat(2, 0.01), tone(2, 0.9)...), flat(2, 0.01)...)
	curve, err := measureStream(&reader{data: raw, step: 8192})
	if err != nil {
		t.Fatal(err)
	}
	stub := &stubLabeller{reply: `[{"start_us": 2000000, "label": "笑声"}]`}
	rows, err := LabelStretches(context.Background(), stub, curve, 12,
		func(int64, int64) string { return "观众都笑了" })
	if err != nil {
		t.Fatal(err)
	}
	if len(stub.asked) != 1 {
		t.Fatalf("labeller saw %d stretches, want 1", len(stub.asked))
	}
	if stub.asked[0].Transcript != "观众都笑了" {
		t.Fatalf("labeller was not given the transcript: %+v", stub.asked[0])
	}
	if stub.asked[0].PeakDB <= stub.asked[0].FloorDB {
		t.Fatalf("labeller was not given a comparable level: %+v", stub.asked[0])
	}
	named := 0
	for _, row := range rows {
		if row.EventLabel == EventLaughter {
			named++
		}
		if row.Summary == "" {
			t.Fatalf("row %d lost its measurement", row.StartUS/WindowUS)
		}
	}
	if named != 2 {
		t.Fatalf("named %d seconds as laughter, want the whole two-second stretch", named)
	}
}

// TestLabelStretchesWithoutAModelStillMeasures keeps the dimension usable with
// no provider: the curve is the measurement, and a name is an addition to it.
func TestLabelStretchesWithoutAModelStillMeasures(t *testing.T) {
	curve, err := measureStream(&reader{data: tone(3, 0.5), step: 8192})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := LabelStretches(context.Background(), nil, curve, 12, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(rows))
	}
	for i, row := range rows {
		if row.Summary == "" {
			t.Fatalf("row %d has no measurement", i)
		}
		if row.EventLabel != "" {
			t.Fatalf("row %d was named without a labeller: %q", i, row.EventLabel)
		}
	}
}

// TestLabelStretchesReportsALabellerFailure lets the caller choose: a broken
// labeller must be distinguishable from a recording with nothing to name, so the
// caller can keep the measurement and say the naming failed.
func TestLabelStretchesReportsALabellerFailure(t *testing.T) {
	raw := append(append(flat(2, 0.01), tone(2, 0.9)...), flat(2, 0.01)...)
	curve, err := measureStream(&reader{data: raw, step: 8192})
	if err != nil {
		t.Fatal(err)
	}
	boom := errors.New("model down")
	_, err = LabelStretches(context.Background(), &stubLabeller{err: boom}, curve, 12, nil)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
}

// TestLabelStretchesBatchesALongRecordingBounds the request count: a two-hour
// recording must not become one request per excursion.
func TestLabelStretchesBatchesALongRecordingBounds(t *testing.T) {
	// Alternate loud and quiet seconds so each loud one is its own stretch.
	var raw []byte
	for i := 0; i < 100; i++ {
		raw = append(raw, flat(1, 0.01)...)
		raw = append(raw, tone(1, 0.9)...)
	}
	curve, err := measureStream(&reader{data: raw, step: 32768})
	if err != nil {
		t.Fatal(err)
	}
	stub := &stubLabeller{reply: `[]`}
	if _, err := LabelStretches(context.Background(), stub, curve, 12, nil); err != nil {
		t.Fatal(err)
	}
	if len(stub.asked) != 100 {
		t.Fatalf("labeller saw %d stretches, want 100", len(stub.asked))
	}
	if stub.batches != 3 {
		t.Fatalf("used %d requests for 100 stretches, want 3 (batches of 40)", stub.batches)
	}
}

// TestLabelSummaryCountsWhatWasNamed keeps the one-line report honest: it names
// events and their durations, and says so plainly when nothing was named.
func TestLabelSummaryCountsWhatWasNamed(t *testing.T) {
	if got := LabelSummary(nil); got != "no events named" {
		t.Fatalf("empty summary = %q", got)
	}
	rows := []EventRow{
		{EventLabel: EventApplause}, {EventLabel: EventApplause},
		{EventLabel: EventMusic}, {EventLabel: EventUnlabelled},
	}
	got := LabelSummary(rows)
	if !strings.Contains(got, "掌声×2") || !strings.Contains(got, "音乐×1") {
		t.Fatalf("summary = %q", got)
	}
}

// TestEvidenceKeepsTheMeasurementSeparateFromTheName pins the field choice: the
// measured level and the model's name are different kinds of fact, and a reader
// must be able to tell which is which.
func TestEvidenceKeepsTheMeasurementSeparateFromTheName(t *testing.T) {
	curve, err := measureStream(&reader{data: tone(2, 0.5), step: 8192})
	if err != nil {
		t.Fatal(err)
	}
	asset := domain.MediaAsset{ID: "asset-z", ProjectID: "p", DurationUS: 2 * WindowUS}
	rows := Evidence(asset, Rows(curve))
	for i, row := range rows {
		if row.AcousticSummary == "" {
			t.Fatalf("row %d has no measurement", i)
		}
		if row.EventLabel != "" {
			t.Fatalf("row %d carries a name the measurement did not produce: %q", i, row.EventLabel)
		}
	}
}
