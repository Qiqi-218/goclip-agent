package httpapi

import (
	"sort"
	"sync"
	"time"
)

// actionCall is one finished action call, as the observer recorded it.
type actionCall struct {
	Action string    `json:"action"`
	Start  time.Time `json:"start"`
	End    time.Time `json:"end"`
}

// actionObserver records when each action call ran and how many ran at once.
//
// It exists because "the agent dispatched these in parallel" is otherwise
// unfalsifiable from outside: a caller sees only that both answers arrived. Two
// calls that overlapped in wall-clock time on the service cannot have been
// serialized by the caller, so the overlap is the evidence.
type actionObserver struct {
	mu     sync.Mutex
	live   map[string]int
	peak   map[string]int
	counts map[string]int
	calls  []actionCall
	limit  int
}

/** newActionObserver returns an observer that retains the last `limit` calls. */
func newActionObserver(limit int) *actionObserver {
	return &actionObserver{
		live:   map[string]int{},
		peak:   map[string]int{},
		counts: map[string]int{},
		limit:  limit,
	}
}

// begin marks one action call as started and returns its finish function.
// @param action - the action name being dispatched.
// @returns a function to call when the action settles.
func (o *actionObserver) begin(action string) func() {
	start := time.Now()
	o.mu.Lock()
	o.live[action]++
	if o.live[action] > o.peak[action] {
		o.peak[action] = o.live[action]
	}
	o.counts[action]++
	o.mu.Unlock()
	return func() {
		end := time.Now()
		o.mu.Lock()
		o.live[action]--
		o.calls = append(o.calls, actionCall{Action: action, Start: start, End: end})
		if len(o.calls) > o.limit {
			o.calls = o.calls[len(o.calls)-o.limit:]
		}
		o.mu.Unlock()
	}
}

// overlaps reports, per action, how many pairs of recorded calls ran at the same
// time. A non-zero count is proof that the caller dispatched that action
// concurrently rather than one call at a time.
// @returns one entry per action that has a recorded overlap.
func (o *actionObserver) overlaps() map[string]int {
	o.mu.Lock()
	calls := make([]actionCall, len(o.calls))
	copy(calls, o.calls)
	o.mu.Unlock()

	byAction := map[string][]actionCall{}
	for _, call := range calls {
		byAction[call.Action] = append(byAction[call.Action], call)
	}
	out := map[string]int{}
	for action, group := range byAction {
		sort.Slice(group, func(i, j int) bool { return group[i].Start.Before(group[j].Start) })
		for i := range group {
			for j := i + 1; j < len(group); j++ {
				// The second call starts before the first ends.
				if group[j].Start.Before(group[i].End) {
					out[action]++
				}
			}
		}
	}
	return out
}

// snapshot reports the observer's counters as the diagnostics route returns them.
// @returns peak concurrency, call counts, and overlapping pairs per action.
func (o *actionObserver) snapshot() map[string]any {
	o.mu.Lock()
	peak := map[string]int{}
	for k, v := range o.peak {
		peak[k] = v
	}
	counts := map[string]int{}
	for k, v := range o.counts {
		counts[k] = v
	}
	retained := len(o.calls)
	o.mu.Unlock()

	overlaps := o.overlaps()
	maxPeak := 0
	for _, v := range peak {
		if v > maxPeak {
			maxPeak = v
		}
	}
	concurrent := 0
	for _, v := range overlaps {
		concurrent += v
	}
	return map[string]any{
		"peak_concurrency":    peak,
		"max_peak":            maxPeak,
		"counts":              counts,
		"overlapping_pairs":   overlaps,
		"concurrent_observed": concurrent > 0,
		"retained_calls":      retained,
	}
}
