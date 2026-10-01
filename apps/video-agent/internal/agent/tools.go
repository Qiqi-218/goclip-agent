package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
)

type Tool struct {
	Name        string
	Description string
	InputSchema map[string]any
	Execute     func(context.Context, json.RawMessage) (any, error)
}

type Registry struct {
	tools map[string]Tool
}

func NewRegistry() *Registry { return &Registry{tools: map[string]Tool{}} }

func (r *Registry) Register(tool Tool) error {
	if tool.Name == "" || tool.Execute == nil {
		return fmt.Errorf("tool requires name and execute function")
	}
	if _, exists := r.tools[tool.Name]; exists {
		return fmt.Errorf("tool %q already registered", tool.Name)
	}
	r.tools[tool.Name] = tool
	return nil
}

func (r *Registry) Get(name string) (Tool, bool) {
	tool, ok := r.tools[name]
	return tool, ok
}

func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.tools))
	for name := range r.tools {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
