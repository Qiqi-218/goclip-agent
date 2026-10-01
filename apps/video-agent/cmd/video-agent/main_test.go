package main

import (
	"context"
	"testing"
)

func TestToolListAndProjectNameFlagsDoNotConflict(t *testing.T) {
	data := t.TempDir()
	if _, err := run(context.Background(), []string{"--data", data, "tool", "list"}); err != nil {
		t.Fatalf("tool list: %v", err)
	}
	if _, err := run(context.Background(), []string{"--data", data, "project", "create", "--id", "p", "--name", "project name"}); err != nil {
		t.Fatalf("project create: %v", err)
	}
}

// TestServeRejectsNonLoopbackUnlessContainerOverride pins the gate on a public
// listen address. The container override alone used to be enough, which meant a
// deployment could reach the internet with nothing guarding the routes that
// create projects, import footage and start renders.
func TestServeRejectsNonLoopbackUnlessContainerOverride(t *testing.T) {
	// Pinned rather than inherited: the deployment this checkout is developed
	// against exports these, and a test reading the ambient environment would
	// prove nothing about the gate.
	t.Setenv("VIDEO_AGENT_ALLOW_CONTAINER_LISTEN", "")
	t.Setenv("VIDEO_AGENT_SHARED_SECRET", "")
	t.Setenv("VIDEO_AGENT_ALLOWED_ORIGINS", "")

	if err := loopback("0.0.0.0:8090"); err == nil {
		t.Fatal("unrestricted listen address was accepted")
	}
	if err := loopback("192.168.1.5:8090"); err == nil {
		t.Fatal("a routable address was accepted")
	}

	t.Setenv("VIDEO_AGENT_ALLOW_CONTAINER_LISTEN", "1")
	if err := loopback("0.0.0.0:8090"); err == nil {
		t.Fatal("the override alone admitted a public address with no credential")
	}

	t.Setenv("VIDEO_AGENT_SHARED_SECRET", "s3cret")
	if err := loopback("0.0.0.0:8090"); err == nil {
		t.Fatal("a public address was admitted with no origin allowlist, so the panel could not read footage")
	}

	t.Setenv("VIDEO_AGENT_ALLOWED_ORIGINS", "https://example.invalid")
	if err := loopback("0.0.0.0:8090"); err != nil {
		t.Fatalf("a fully configured public address was refused: %v", err)
	}
}

// TestLoopbackAdmitsLocalAddresses keeps local development unchanged: the gate
// must never be the reason a developer cannot start the service.
func TestLoopbackAdmitsLocalAddresses(t *testing.T) {
	t.Setenv("VIDEO_AGENT_ALLOW_CONTAINER_LISTEN", "")
	for _, addr := range []string{"127.0.0.1:8090", "localhost:8090", "[::1]:8090"} {
		if err := loopback(addr); err != nil {
			t.Fatalf("%s was refused: %v", addr, err)
		}
	}
	if err := loopback("not-an-address"); err == nil {
		t.Fatal("a malformed address was accepted")
	}
}
