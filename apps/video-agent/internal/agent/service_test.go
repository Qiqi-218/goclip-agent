package agent_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/zylar06/video-agent/internal/agent"
	"github.com/zylar06/video-agent/internal/app"
	"github.com/zylar06/video-agent/internal/domain"
)

func call(t *testing.T, s *agent.Service, name string, in any) agent.Envelope {
	t.Helper()
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	return s.Call(context.Background(), name, b)
}

func TestEvidenceSearchProposalAndRevisionGuard(t *testing.T) {
	a, err := app.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := a.Store.CreateProject(domain.Project{ID: "p", Name: "P3"}); err != nil {
		t.Fatal(err)
	}
	asset, err := a.Store.PutAsset(domain.MediaAsset{ID: "a", ProjectID: "p", Path: "/fixture.mp4", ContentHash: "hash", DurationUS: 30_000_000, Width: 1280, Height: 720, FPS: "30/1", Status: "ready"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.CreateTimeline(domain.TimelineRevision{ID: "t", ProjectID: "p", FPSNum: 30, FPSDen: 1, Width: 1280, Height: 720}); err != nil {
		t.Fatal(err)
	}
	s := agent.NewService(a)
	// Frame sampling and the loudness curve are both on unless explicitly
	// skipped, so an analysis over a missing asset fails while measuring it
	// rather than skipping straight to the transcript stage. Every combination
	// must fail cleanly instead of silently returning a thinner result.
	missing := call(t, s, "analyze", map[string]any{"project_id": "p", "asset_id": asset.ID})
	if missing.OK {
		t.Fatalf("expected the sampler to fail on a missing asset: %+v", missing)
	}
	// Turning off one dimension still leaves the other measuring the same
	// unreadable asset, so this fails too — the point is that opting out of
	// frames does not quietly turn into a subtitles-only pass.
	noFrames := call(t, s, "analyze", map[string]any{"project_id": "p", "asset_id": asset.ID, "skip_visual": true})
	if noFrames.OK {
		t.Fatalf("expected the loudness measurement to fail on a missing asset: %+v", noFrames)
	}
	// Only opting out of both reaches the provider check with nothing measured.
	skipped := call(t, s, "analyze", map[string]any{
		"project_id": "p", "asset_id": asset.ID, "skip_visual": true, "skip_audio": true,
	})
	if skipped.OK || skipped.Error.Code != "model_unavailable" {
		t.Fatalf("expected unavailable analyzer with both dimensions skipped: %+v", skipped)
	}
	e := call(t, s, "evidence_add", domain.Evidence{ID: "ev-1", ProjectID: "p", AssetID: asset.ID, StartUS: 2_000_000, EndUS: 5_000_000, Transcript: "绝杀进球 全场欢呼", AnalyzerVersion: "srt-v1", Provider: "fixture"})
	if !e.OK {
		t.Fatalf("evidence: %+v", e)
	}
	// With nothing left to measure, the run indexes what the caller supplied by
	// hand and succeeds — the fixture asset is a path that does not exist, so a
	// dimension left on would fail here instead.
	analyzed := call(t, s, "analyze", map[string]any{
		"project_id": "p", "asset_id": asset.ID, "skip_visual": true, "skip_audio": true,
	})
	if !analyzed.OK {
		t.Fatalf("analyze indexed evidence: %+v", analyzed)
	}
	match := call(t, s, "search", map[string]any{"project_id": "p", "query": "进球", "limit": 3})
	if !match.OK {
		t.Fatalf("search: %+v", match)
	}
	// A miss is a legitimate answer, not a tool failure: reporting it as an error
	// made the model treat search as broken and retry the same lookup with
	// synonyms. It must come back as a successful empty result instead.
	noMatch := call(t, s, "search", map[string]any{"project_id": "p", "query": "颁奖", "limit": 3})
	if !noMatch.OK {
		t.Fatalf("a search miss must succeed, got %+v", noMatch)
	}
	payload, _ := json.Marshal(noMatch.Result)
	var miss struct {
		Count   int    `json:"count"`
		Matches []any  `json:"matches"`
		Note    string `json:"note"`
	}
	if err := json.Unmarshal(payload, &miss); err != nil {
		t.Fatalf("search result shape: %v (%s)", err, payload)
	}
	if miss.Count != 0 || len(miss.Matches) != 0 || miss.Note == "" {
		t.Fatalf("expected an explained empty result, got %s", payload)
	}
	// Proposal drafting still needs real hits, so it stays strict.
	noProposal := call(t, s, "proposal_create", map[string]any{"timeline_id": "t", "query": "颁奖", "limit": 1})
	if noProposal.OK || noProposal.Error.Code != "no_match" {
		t.Fatalf("expected no_match from proposal_create, got %+v", noProposal)
	}
	p := call(t, s, "proposal_create", map[string]any{"timeline_id": "t", "query": "绝杀", "limit": 1})
	if !p.OK {
		t.Fatalf("proposal: %+v", p)
	}
	b, _ := json.Marshal(p.Result)
	var proposal domain.EditProposal
	if err := json.Unmarshal(b, &proposal); err != nil {
		t.Fatal(err)
	}
	if len(proposal.Operations) != 1 || proposal.Operations[0].BaseRevision != 1 {
		t.Fatalf("bad proposal: %+v", proposal)
	}
	applied := call(t, s, "edit_apply", proposal.Operations[0])
	if !applied.OK {
		t.Fatalf("apply: %+v", applied)
	}
	stale := proposal.Operations[0]
	stale.ID = "stale-op"
	conflict := call(t, s, "edit_apply", stale)
	if conflict.OK || conflict.Error.Code != "revision_conflict" {
		t.Fatalf("expected conflict: %+v", conflict)
	}
}
