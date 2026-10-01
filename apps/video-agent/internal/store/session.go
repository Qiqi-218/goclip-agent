package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/zylar06/video-agent/internal/domain"
)

// Conversations are persisted so a reloaded page — or a restarted service —
// resumes instead of losing context.
//
// Two shapes are stored, because they answer different questions:
//
//   - session_messages holds the UI transcript (domain.View), appended one turn
//     at a time so an interrupted conversation keeps everything already shown.
//   - session_state holds the model-facing message list, which is what actually
//     resumes a conversation. It cannot be derived from the view: an assistant
//     turn that requested tools carries tool_call ids the view never displays,
//     and providers reject tool results whose originating call is absent.
//
// Rewriting state once per call is acceptable because it is small next to the
// transcripts it summarizes.

const timeLayout = time.RFC3339Nano

// SessionInfo describes one stored conversation for a sidebar.
type SessionInfo struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id,omitempty"`
	Title     string    `json:"title,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Messages  int       `json:"messages"`
}

// CreateSession registers a conversation under a project. Re-creating an
// existing id is a no-op so a client resuming from localStorage can safely
// re-announce its session; the project is never reassigned, because moving a
// conversation to another project would silently change what its history is
// about.
func (s *Store) CreateSession(id, projectID, title string) error {
	if id == "" {
		return errors.New("session id is required")
	}
	now := time.Now().UTC().Format(timeLayout)
	_, err := s.db.Exec(`INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)
		ON CONFLICT(id) DO NOTHING`, id, projectID, title, now, now)
	return err
}

// SessionProject reports which project a conversation belongs to. An empty
// result means the conversation predates project scoping.
func (s *Store) SessionProject(id string) (string, error) {
	var project string
	err := s.db.QueryRow("SELECT project_id FROM sessions WHERE id=?", id).Scan(&project)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return project, err
}

// SessionsIn lists one project's conversations, most recently updated first.
func (s *Store) SessionsIn(projectID string) ([]SessionInfo, error) {
	return s.sessionsWhere("WHERE s.project_id=?", projectID)
}

// AppendSessionMessage stores one transcript entry and, when the user's first
// request arrives, names the conversation after it.
func (s *Store) AppendSessionMessage(sessionID string, message domain.View) error {
	if sessionID == "" {
		return errors.New("session id is required")
	}
	b, err := json.Marshal(message)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var next int
	if err := tx.QueryRow("SELECT COALESCE(MAX(seq),0)+1 FROM session_messages WHERE session_id=?", sessionID).Scan(&next); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO session_messages(session_id,seq,body) VALUES(?,?,?)", sessionID, next, b); err != nil {
		return err
	}
	titles := message.Role == "user" && message.Text != ""
	if _, err := tx.Exec(`UPDATE sessions SET updated_at=?,
		title=CASE WHEN title='' AND ?=1 THEN ? ELSE title END WHERE id=?`,
		time.Now().UTC().Format(timeLayout), boolToInt(titles), truncateRunes(message.Text, 40), sessionID); err != nil {
		return err
	}
	return tx.Commit()
}

// SaveSessionState stores the model-facing message list that resumes a session.
func (s *Store) SaveSessionState(sessionID string, messages []domain.Message) error {
	if sessionID == "" {
		return errors.New("session id is required")
	}
	b, err := json.Marshal(messages)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO session_state(session_id,body) VALUES(?,?)
		ON CONFLICT(session_id) DO UPDATE SET body=excluded.body`, sessionID, b)
	return err
}

// SessionState returns the stored model-facing messages. A conversation with no
// saved state yet returns nil rather than an error.
func (s *Store) SessionState(sessionID string) ([]domain.Message, error) {
	var b []byte
	err := s.db.QueryRow("SELECT body FROM session_state WHERE session_id=?", sessionID).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []domain.Message
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SessionMessages returns the UI transcript in order.
func (s *Store) SessionMessages(sessionID string) ([]domain.View, error) {
	rows, err := s.db.Query("SELECT body FROM session_messages WHERE session_id=? ORDER BY seq", sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.View{}
	for rows.Next() {
		var b []byte
		var v domain.View
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(b, &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Sessions lists every stored conversation, most recently updated first.
func (s *Store) Sessions() ([]SessionInfo, error) {
	return s.sessionsWhere("", nil)
}

// sessionsWhere lists conversations matching an optional filter.
func (s *Store) sessionsWhere(where string, args ...any) ([]SessionInfo, error) {
	rows, err := s.db.Query(`SELECT s.id, s.project_id, s.title, s.created_at, s.updated_at,
		(SELECT COUNT(*) FROM session_messages m WHERE m.session_id=s.id)
		FROM sessions s `+where+` ORDER BY s.updated_at DESC, s.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionInfo{}
	for rows.Next() {
		var info SessionInfo
		var created, updated string
		if err := rows.Scan(&info.ID, &info.ProjectID, &info.Title, &created, &updated, &info.Messages); err != nil {
			return nil, err
		}
		// A malformed timestamp must not hide the conversation from the user.
		info.CreatedAt, _ = time.Parse(timeLayout, created)
		info.UpdatedAt, _ = time.Parse(timeLayout, updated)
		out = append(out, info)
	}
	return out, rows.Err()
}

// DeleteSession removes a conversation, its transcript and its saved state.
func (s *Store) DeleteSession(id string) error {
	for _, stmt := range []string{
		"DELETE FROM session_messages WHERE session_id=?",
		"DELETE FROM session_state WHERE session_id=?",
		"DELETE FROM sessions WHERE id=?",
	} {
		if _, err := s.db.Exec(stmt, id); err != nil {
			return err
		}
	}
	return nil
}

// Deleting project-scoped data.
//
// These run as ordered statements rather than one transaction because the
// schema carries no ON DELETE CASCADE for project rows: children must go first
// or the foreign keys reject the delete. Order is the dependency order, and each
// step is idempotent, so a partially completed delete can be re-run safely.

// DeleteAsset removes an asset together with everything derived from it:
// analysis runs, evidence, its clips in any timeline, and the render jobs that
// produced those timelines' output.
func (s *Store) DeleteAsset(project, asset string) error {
	for _, stmt := range []string{
		"DELETE FROM evidence WHERE project_id=? AND asset_id=?",
		"DELETE FROM analysis_runs WHERE project_id=? AND asset_id=?",
		"DELETE FROM assets WHERE project_id=? AND id=?",
	} {
		if _, err := s.db.Exec(stmt, project, asset); err != nil {
			return err
		}
	}
	return nil
}

// DeleteTimeline removes a timeline, every revision, its operations and the
// render jobs for it. Output files already written are left on disk: deleting
// the user's rendered video because they tidied up a draft would be destructive
// in a way they did not ask for.
func (s *Store) DeleteTimeline(id string) error {
	for _, stmt := range []string{
		"DELETE FROM jobs WHERE timeline_id=?",
		"DELETE FROM operations WHERE timeline_id=?",
		"DELETE FROM revisions WHERE timeline_id=?",
		"DELETE FROM timelines WHERE id=?",
	} {
		if _, err := s.db.Exec(stmt, id); err != nil {
			return err
		}
	}
	return nil
}

// DeleteProject removes a project and everything belonging to it. Rendered files
// are left on disk for the same reason as DeleteTimeline.
func (s *Store) DeleteProject(id string) error {
	timelines, err := s.ProjectTimelines(id)
	if err != nil {
		return err
	}
	for _, t := range timelines {
		if err := s.DeleteTimeline(t.ID); err != nil {
			return err
		}
	}
	assets, err := s.Assets(id)
	if err != nil {
		return err
	}
	for assetID := range assets {
		if err := s.DeleteAsset(id, assetID); err != nil {
			return err
		}
	}
	for _, stmt := range []string{
		"DELETE FROM evidence WHERE project_id=?",
		"DELETE FROM analysis_runs WHERE project_id=?",
		"DELETE FROM projects WHERE id=?",
	} {
		if _, err := s.db.Exec(stmt, id); err != nil {
			return err
		}
	}
	return nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// truncateRunes shortens a session title without splitting a multi-byte rune.
func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}
