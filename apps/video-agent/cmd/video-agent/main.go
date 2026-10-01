package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/zylar06/video-agent/internal/agent"
	"github.com/zylar06/video-agent/internal/app"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/edit"
	"github.com/zylar06/video-agent/internal/httpapi"
	"github.com/zylar06/video-agent/internal/store"
)

const help = `video-agent: local long-video understanding and intelligent editing runtime

Usage: video-agent [--data DIR] COMMAND [flags]
  project create --id ID --name NAME
  assets import --project ID --path FILE
  assets list --project ID
  timeline create --file JSON
  timeline get --id ID [--revision N]
  timeline history --id ID
  edit apply --file JSON
  render plan --timeline ID [--revision N] [--preview]
  render export --timeline ID [--revision N] [--output FILE.mp4]
  render preview --timeline ID [--revision N] [--output FILE.mp4]
  jobs get --id ID
  tool list
  tool call --tool TOOL --file JSON
  serve [--addr 127.0.0.1:8090]

JSON files accept '-' for stdin. Direct render commands remain synchronous;
render_submit is asynchronous when called through the internal tool/API. The
HTTP server only listens on loopback and provides the local Web experience.
Set VIDEO_AGENT_FFMPEG / VIDEO_AGENT_FFPROBE to override executable paths.
`

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	result, err := run(ctx, os.Args[1:])
	if envelope, ok := result.(agent.Envelope); ok && !envelope.OK {
		_ = json.NewEncoder(os.Stdout).Encode(envelope)
		os.Exit(1)
	}
	if err != nil {
		code := "invalid_request"
		if errors.Is(err, store.ErrConflict) {
			code = "revision_conflict"
		}
		if errors.Is(err, store.ErrNotFound) {
			code = "not_found"
		}
		if errors.Is(err, store.ErrOperationReuse) {
			code = "operation_id_reuse"
		}
		json.NewEncoder(os.Stderr).Encode(map[string]any{"error": map[string]string{"code": code, "message": err.Error()}, "result": result})
		os.Exit(1)
	}
	if result != nil {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err = enc.Encode(result); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}
func readJSON(path string, out any) error {
	var r io.Reader = os.Stdin
	if path != "-" {
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		r = f
	}
	d := json.NewDecoder(io.LimitReader(r, 4<<20))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("expected exactly one JSON value")
	}
	return nil
}
func run(ctx context.Context, args []string) (any, error) {
	if len(args) == 0 || args[0] == "--help" || args[0] == "help" {
		fmt.Print(help)
		return nil, nil
	}
	global := flag.NewFlagSet("video-agent", flag.ContinueOnError)
	global.SetOutput(io.Discard)
	data := global.String("data", "data", "project data directory")
	if err := global.Parse(args); err != nil {
		return nil, err
	}
	args = global.Args()
	if len(args) == 0 {
		return nil, errors.New("expected command and subcommand; use --help")
	}
	if args[0] == "serve" {
		f := flag.NewFlagSet("serve", flag.ContinueOnError)
		f.SetOutput(io.Discard)
		addr := f.String("addr", "127.0.0.1:8090", "loopback listen address")
		if err := f.Parse(args[1:]); err != nil || f.NArg() != 0 {
			if err != nil {
				return nil, err
			}
			return nil, errors.New("unexpected serve argument")
		}
		if err := loopback(*addr); err != nil {
			return nil, err
		}
		a, err := app.Open(*data)
		if err != nil {
			return nil, err
		}
		defer a.Close()
		srv := httpapi.Server(*addr, httpapi.New(a))
		go func() { <-ctx.Done(); _ = srv.Shutdown(context.Background()) }()
		err = srv.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			return map[string]string{"status": "stopped"}, nil
		}
		return nil, err
	}
	if len(args) < 2 {
		return nil, errors.New("expected command and subcommand; use --help")
	}
	command := args[0] + " " + args[1]
	f := flag.NewFlagSet(command, flag.ContinueOnError)
	f.SetOutput(io.Discard)
	id := f.String("id", "", "id")
	name := f.String("name", "", "project name")
	project := f.String("project", "", "project id")
	path := f.String("path", "", "media path")
	file := f.String("file", "", "JSON file")
	timeline := f.String("timeline", "", "timeline id")
	revision := f.Int("revision", 0, "revision (0=current)")
	output := f.String("output", "", "output MP4")
	preview := f.Bool("preview", false, "preview plan")
	toolName := f.String("tool", "", "internal tool name")
	if err := f.Parse(args[2:]); err != nil {
		return nil, err
	}
	if f.NArg() != 0 || *revision < 0 {
		return nil, errors.New("unexpected positional argument or invalid revision")
	}
	a, err := app.Open(*data)
	if err != nil {
		return nil, err
	}
	defer a.Close()
	switch command {
	case "project create":
		p := domain.Project{ID: *id, Name: *name}
		return p, a.Store.CreateProject(p)
	case "assets import":
		return a.Tools.Import(ctx, a.Store, *project, *path)
	case "assets list":
		if _, err = a.Store.Project(*project); err != nil {
			return nil, err
		}
		return a.Store.Assets(*project)
	case "timeline create":
		var t domain.TimelineRevision
		if err = readJSON(*file, &t); err != nil {
			return nil, err
		}
		return a.CreateTimeline(t)
	case "timeline get":
		if *revision == 0 {
			return a.Store.Current(*id)
		}
		return a.Store.Revision(*id, *revision)
	case "timeline history":
		return a.Store.History(*id)
	case "edit apply":
		var op domain.EditOperation
		if err = readJSON(*file, &op); err != nil {
			return nil, err
		}
		return edit.NewEngine(a.Store).Apply(ctx, op)
	case "render plan":
		return a.Plan(*timeline, *revision, *preview)
	case "render export", "render preview":
		return a.Render(ctx, *timeline, *revision, command == "render preview", *output)
	case "jobs get":
		return a.Store.Job(*id)
	case "tool list":
		return agent.NewService(a).Names(), nil
	case "tool call":
		var raw json.RawMessage
		if err := readJSON(*file, &raw); err != nil {
			return nil, err
		}
		return agent.NewService(a).Call(ctx, *toolName, raw), nil
	default:
		return nil, fmt.Errorf("unknown command %q; use --help", command)
	}
}

// loopback refuses a listen address that is reachable from off the machine
// unless the deployment has said so explicitly and armed a credential.
//
// The action routes create projects, import footage, apply edits and start
// renders. On a loopback address that needs no credential, because reaching it
// already requires running code on this machine. Anywhere else it does, so a
// public listen address is refused when no shared secret is configured — the
// failure is at startup rather than in a review, and it names the variable to
// set.
//
// @param addr - the requested listen address.
// @returns an error when the address is not permitted.
func loopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return errors.New("addr must be host:port")
	}
	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		return nil
	}
	if host == "0.0.0.0" && os.Getenv("VIDEO_AGENT_ALLOW_CONTAINER_LISTEN") == "1" {
		return requireSecretForPublicListen()
	}
	if ip != nil && ip.IsUnspecified() {
		return errors.New("serve only permits a loopback address, or 0.0.0.0 with VIDEO_AGENT_ALLOW_CONTAINER_LISTEN=1")
	}
	return errors.New("serve only permits a loopback address")
}

// requireSecretForPublicListen refuses a public listen address whose deployment
// is not fully configured.
//
// The two checks are independent and both are required. Arming the credential
// first and returning early would let a deployment run with no origin allowlist,
// and the panel would then show a project whose footage it silently cannot load.
//
// @returns an error naming the missing configuration.
func requireSecretForPublicListen() error {
	if strings.TrimSpace(os.Getenv("VIDEO_AGENT_SHARED_SECRET")) == "" {
		return errors.New("a public listen address needs VIDEO_AGENT_SHARED_SECRET, " +
			"or anyone who can reach the port can create projects, import footage and start renders")
	}
	if strings.TrimSpace(os.Getenv("VIDEO_AGENT_ALLOWED_ORIGINS")) == "" {
		return errors.New("a public listen address needs VIDEO_AGENT_ALLOWED_ORIGINS, " +
			"or the workbench panel in the browser cannot read the footage it is showing")
	}
	return nil
}
