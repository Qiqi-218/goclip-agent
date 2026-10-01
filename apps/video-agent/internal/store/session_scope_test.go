package store

import (
	"testing"

	"github.com/zylar06/video-agent/internal/domain"
)

func twoProjects(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	for _, id := range []string{"p1", "p2"} {
		if err := s.CreateProject(domain.Project{ID: id, Name: id}); err != nil {
			t.Fatalf("project %s: %v", id, err)
		}
	}
	return s
}

// A conversation belongs to the project it is about. Without this, opening
// another project shows the previous project's history and the agent answers
// about the wrong assets.
func TestSessionsInIsolatesProjects(t *testing.T) {
	s := twoProjects(t)
	if err := s.CreateSession("s1", "p1", "first"); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := s.CreateSession("s2", "p2", "second"); err != nil {
		t.Fatalf("create: %v", err)
	}

	one, err := s.SessionsIn("p1")
	if err != nil {
		t.Fatalf("sessions in p1: %v", err)
	}
	if len(one) != 1 || one[0].ID != "s1" {
		t.Fatalf("p1 should only see its own conversation, got %+v", one)
	}
	if one[0].ProjectID != "p1" {
		t.Fatalf("project id not reported: %+v", one[0])
	}

	two, err := s.SessionsIn("p2")
	if err != nil {
		t.Fatalf("sessions in p2: %v", err)
	}
	if len(two) != 1 || two[0].ID != "s2" {
		t.Fatalf("p2 should only see its own conversation, got %+v", two)
	}

	all, err := s.Sessions()
	if err != nil {
		t.Fatalf("all sessions: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("the unscoped list should still see both, got %d", len(all))
	}
}

// Re-announcing an existing conversation must not move it to another project:
// its history is about the first project's assets.
func TestCreateSessionDoesNotReassignProject(t *testing.T) {
	s := twoProjects(t)
	if err := s.CreateSession("s1", "p1", "t"); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := s.CreateSession("s1", "p2", "t"); err != nil {
		t.Fatalf("re-create: %v", err)
	}
	owner, err := s.SessionProject("s1")
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	if owner != "p1" {
		t.Fatalf("conversation moved to %q, want p1", owner)
	}
}

// Conversations created before project scoping carry no project. They must stay
// reachable rather than disappearing from the UI.
func TestLegacySessionHasNoProject(t *testing.T) {
	s := twoProjects(t)
	if err := s.CreateSession("legacy", "", "old"); err != nil {
		t.Fatalf("create: %v", err)
	}
	owner, err := s.SessionProject("legacy")
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	if owner != "" {
		t.Fatalf("expected an unscoped legacy conversation, got %q", owner)
	}
	// It must not leak into a project's list.
	one, err := s.SessionsIn("p1")
	if err != nil {
		t.Fatalf("sessions in p1: %v", err)
	}
	if len(one) != 0 {
		t.Fatalf("an unscoped conversation should not appear under a project, got %+v", one)
	}
}

func TestSessionProjectReportsMissing(t *testing.T) {
	s := twoProjects(t)
	if _, err := s.SessionProject("nope"); err == nil {
		t.Fatal("an unknown conversation should report not found")
	}
}

// Deleting a project must not take unrelated conversations with it.
func TestDeleteProjectLeavesOtherSessions(t *testing.T) {
	s := twoProjects(t)
	if err := s.CreateSession("s1", "p1", "a"); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := s.CreateSession("s2", "p2", "b"); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := s.DeleteProject("p1"); err != nil {
		t.Fatalf("delete project: %v", err)
	}
	if _, err := s.SessionProject("s2"); err != nil {
		t.Fatalf("the other project's conversation should survive: %v", err)
	}
}
