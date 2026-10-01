package httpapi

import (
	"testing"
	"time"
)

// TestObserverProvesOverlap covers the observation the concurrency diagnostics
// rest on: two calls that ran at the same time must be reported as overlapping,
// and two that did not must not be.
func TestObserverProvesOverlap(t *testing.T) {
	o := newActionObserver(16)

	// Serialized: the second call begins after the first ends.
	first := o.begin("find_in_video")
	time.Sleep(2 * time.Millisecond)
	first()
	second := o.begin("find_in_video")
	time.Sleep(2 * time.Millisecond)
	second()

	if got := o.snapshot(); got["concurrent_observed"] != false {
		t.Fatalf("serialized calls reported as concurrent: %v", got["overlapping_pairs"])
	}

	// Concurrent: both begin before either ends.
	a := o.begin("find_in_video")
	b := o.begin("find_in_video")
	time.Sleep(3 * time.Millisecond)
	a()
	b()

	snap := o.snapshot()
	if snap["concurrent_observed"] != true {
		t.Fatalf("overlapping calls were not reported: %v", snap)
	}
	if snap["max_peak"] != 2 {
		t.Fatalf("peak concurrency: %v, want 2", snap["max_peak"])
	}
	pairs, ok := snap["overlapping_pairs"].(map[string]int)
	if !ok {
		t.Fatalf("overlapping_pairs has type %T", snap["overlapping_pairs"])
	}
	if pairs["find_in_video"] != 1 {
		t.Fatalf("overlapping pairs for find_in_video: %d, want 1", pairs["find_in_video"])
	}
	if counts, ok := snap["counts"].(map[string]int); !ok || counts["find_in_video"] != 4 {
		t.Fatalf("counts: %v", snap["counts"])
	}
}

// TestObserverKeepsOnlyTheMostRecentCalls pins the retention bound: an
// unbounded recorder would grow with every request a long session makes.
func TestObserverKeepsOnlyTheMostRecentCalls(t *testing.T) {
	o := newActionObserver(3)
	for i := 0; i < 10; i++ {
		done := o.begin("project_list")
		done()
	}
	if got := o.snapshot()["retained_calls"]; got != 3 {
		t.Fatalf("retained %v calls, want 3", got)
	}
}

// TestObserverReportsPeakPerAction keeps the two counters apart: a peak belongs
// to the action that reached it, so a burst of one action cannot make another
// look concurrent.
func TestObserverReportsPeakPerAction(t *testing.T) {
	o := newActionObserver(16)
	a := o.begin("find_in_video")
	b := o.begin("find_in_video")
	a()
	b()
	c := o.begin("project_list")
	c()

	peak, ok := o.snapshot()["peak_concurrency"].(map[string]int)
	if !ok {
		t.Fatal("peak_concurrency is not a per-action map")
	}
	if peak["find_in_video"] != 2 {
		t.Fatalf("find_in_video peak: %d, want 2", peak["find_in_video"])
	}
	if peak["project_list"] != 1 {
		t.Fatalf("project_list peak: %d, want 1", peak["project_list"])
	}
}
