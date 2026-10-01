package domain

import "testing"

func TestTimelineValidateReferencesAssetRanges(t *testing.T) {
	assets := map[string]MediaAsset{"a": {ID: "a", ProjectID: "p", Path: "a.mp4", DurationUS: 10_000_000, Width: 1920, Height: 1080}}
	timeline := TimelineRevision{ID: "tl", ProjectID: "p", Revision: 1, FPSNum: 30, FPSDen: 1, Width: 1920, Height: 1080, Items: []ClipItem{{ID: "c", AssetID: "a", SourceOutUS: 5_000_000, DurationFrames: 150}}}
	if err := timeline.Validate(assets); err != nil {
		t.Fatal(err)
	}
	timeline.Items[0].SourceOutUS = 11_000_000
	if err := timeline.Validate(assets); err == nil {
		t.Fatal("expected source range error")
	}
}

func TestTimelineRejectsAmbiguousTimingAndForeignAssets(t *testing.T) {
	a := MediaAsset{ID: "a", ProjectID: "p", Path: "a.mp4", DurationUS: 10_000_000, Width: 320, Height: 180}
	base := TimelineRevision{ID: "t", ProjectID: "p", Revision: 1, FPSNum: 30000, FPSDen: 1001, Width: 320, Height: 180, Items: []ClipItem{{ID: "c", AssetID: "a", SourceOutUS: 1_001_000, DurationFrames: 30}}}
	if err := base.Validate(map[string]MediaAsset{"a": a}); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*TimelineRevision){func(t *TimelineRevision) { t.Items[0].StartFrame = 1 }, func(t *TimelineRevision) { t.Items[0].DurationFrames = 31 }, func(t *TimelineRevision) { t.ProjectID = "other" }, func(t *TimelineRevision) { t.Width = 321 }, func(t *TimelineRevision) { t.FPSNum = 0 }} {
		copy := base.Clone()
		mutate(&copy)
		if err := copy.Validate(map[string]MediaAsset{"a": a}); err == nil {
			t.Fatalf("accepted invalid timeline: %+v", copy)
		}
	}
}
