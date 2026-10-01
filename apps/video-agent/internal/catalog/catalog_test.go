package catalog

import (
	"context"
	"reflect"
	"testing"
)

func TestStaticCatalogIsOfflineAndDeterministic(t *testing.T) {
	mock := StaticCatalog{
		Analysis: map[string]AnalysisResult{"asset-a": {Evidence: []Evidence{{ID: "ev-a", ProjectID: "p", AssetID: "asset-a", StartUS: 3_000_000, EndUS: 10_000_000}}}},
		Results:  []SearchResult{{Evidence: Evidence{ID: "z"}, Score: 0.5}, {Evidence: Evidence{ID: "b"}, Score: 0.9}, {Evidence: Evidence{ID: "a"}, Score: 0.9}},
	}
	evidence, err := mock.Analyze(context.Background(), "asset-a")
	if err != nil || len(evidence) != 1 || evidence[0].ID != "ev-a" {
		t.Fatalf("Analyze = %#v, %v", evidence, err)
	}
	got, err := mock.Search(context.Background(), SearchRequest{ProjectID: "p", Query: "结论", Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if ids := []string{got[0].Evidence.ID, got[1].Evidence.ID}; !reflect.DeepEqual(ids, []string{"a", "b"}) {
		t.Fatalf("unstable sort: %v", ids)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := mock.Search(ctx, SearchRequest{}); err == nil {
		t.Fatal("cancelled context must not return mock results")
	}
}
