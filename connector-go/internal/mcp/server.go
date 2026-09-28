// Package mcp is a small MCP server (JSON-RPC 2.0) for connectors: initialize, ping, tools/list, tools/call and
// cancellation. It is transport-agnostic; the protocol client hands it one message at a time.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime/debug"
	"sort"
	"sync"

	"github.com/deepfinery/OpenHarness/connector-go/internal/protocol"
)

// Writer is where replies go; the protocol package provides one per connection.
type Writer = protocol.Writer

// Meta carries the `_meta` of a tools/call request; the orchestrator's idempotency key travels here.
type Meta struct {
	IdempotencyKey string
	Raw            map[string]json.RawMessage
}

// Content is one text block of a tool result.
type Content struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// Result is a tools/call result.
type Result struct {
	Content           []Content `json:"content"`
	StructuredContent any       `json:"structuredContent,omitempty"`
	IsError           bool      `json:"isError,omitempty"`
}

// Text renders a value as pretty JSON text and keeps it as structured content.
func Text(value any) *Result {
	switch v := value.(type) {
	case string:
		return &Result{Content: []Content{{Type: "text", Text: v}}, StructuredContent: map[string]any{"value": v}}
	default:
		body, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			body = []byte(fmt.Sprintf("%v", value))
		}
		return &Result{Content: []Content{{Type: "text", Text: string(body)}}, StructuredContent: value}
	}
}

// Failure is an error result the model can read.
func Failure(message string) *Result {
	return &Result{Content: []Content{{Type: "text", Text: message}}, IsError: true}
}

// ToolHandler runs one call. Returning an error produces an error result, never a JSON-RPC error.
type ToolHandler func(ctx context.Context, args json.RawMessage, meta Meta) (*Result, error)

// Tool is what tools/list advertises and tools/call dispatches to.
type Tool struct {
	Name        string
	Title       string
	Description string
	InputSchema map[string]any
	Annotations map[string]any
	Handler     ToolHandler
}

// Server answers MCP requests for a fixed tool set.
type Server struct {
	name, version string
	mu            sync.Mutex
	tools         map[string]Tool
	order         []string
	inflight      map[string]context.CancelFunc
}

// NewServer names the server as reported in initialize.
func NewServer(name, version string) *Server {
	return &Server{name: name, version: version, tools: map[string]Tool{}, inflight: map[string]context.CancelFunc{}}
}

// AddTool registers a tool; a second tool with the same name replaces the first.
func (s *Server) AddTool(t Tool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.tools[t.Name]; !exists {
		s.order = append(s.order, t.Name)
	}
	s.tools[t.Name] = t
}

// ToolNames lists the registered tools in registration order.
func (s *Server) ToolNames() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.order...)
}

type request struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id"`
	Method  string           `json:"method"`
	Params  json.RawMessage  `json:"params"`
	Result  *json.RawMessage `json:"result"`
	Error   *json.RawMessage `json:"error"`
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

var supportedProtocolVersions = map[string]bool{"2025-06-18": true, "2025-03-26": true, "2024-11-05": true}

// HandleFrame processes one inbound JSON-RPC message. It satisfies protocol.Handler.
func (s *Server) HandleFrame(ctx context.Context, raw json.RawMessage, w Writer) {
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		return
	}
	if req.Method == "" {
		return // a response to something we never sent
	}
	if req.ID == nil {
		s.handleNotification(req)
		return
	}
	id := *req.ID
	switch req.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		version := params.ProtocolVersion
		if !supportedProtocolVersions[version] {
			version = "2025-06-18"
		}
		s.reply(ctx, w, id, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": true}},
			"serverInfo":      map[string]any{"name": s.name, "version": s.version},
		})
	case "ping":
		s.reply(ctx, w, id, map[string]any{})
	case "tools/list":
		s.reply(ctx, w, id, map[string]any{"tools": s.listTools()})
	case "tools/call":
		s.call(ctx, w, id, req.Params)
	default:
		s.replyError(ctx, w, id, -32601, "Method not found")
	}
}

func (s *Server) handleNotification(req request) {
	if req.Method != "notifications/cancelled" {
		return
	}
	var params struct {
		RequestID json.RawMessage `json:"requestId"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return
	}
	s.mu.Lock()
	cancel := s.inflight[string(params.RequestID)]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Server) listTools() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]map[string]any, 0, len(s.order))
	for _, name := range s.order {
		t := s.tools[name]
		entry := map[string]any{"name": t.Name, "description": t.Description, "inputSchema": t.InputSchema}
		if t.Title != "" {
			entry["title"] = t.Title
		}
		if t.Annotations != nil {
			entry["annotations"] = t.Annotations
		}
		out = append(out, entry)
	}
	return out
}

func (s *Server) call(ctx context.Context, w Writer, id json.RawMessage, params json.RawMessage) {
	var p struct {
		Name      string                     `json:"name"`
		Arguments json.RawMessage            `json:"arguments"`
		Meta      map[string]json.RawMessage `json:"_meta"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Name == "" {
		s.replyError(ctx, w, id, -32602, "Invalid params: a tool name is required")
		return
	}
	s.mu.Lock()
	tool, ok := s.tools[p.Name]
	s.mu.Unlock()
	if !ok {
		s.replyError(ctx, w, id, -32602, fmt.Sprintf("Unknown tool: %s", p.Name))
		return
	}
	meta := Meta{Raw: p.Meta}
	if raw, ok := p.Meta["idempotencyKey"]; ok {
		_ = json.Unmarshal(raw, &meta.IdempotencyKey)
	}
	if len(p.Arguments) == 0 {
		p.Arguments = json.RawMessage(`{}`)
	}
	callCtx, cancel := context.WithCancel(ctx)
	key := string(id)
	s.mu.Lock()
	s.inflight[key] = cancel
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		delete(s.inflight, key)
		s.mu.Unlock()
	}()
	result := s.safeCall(callCtx, tool, p.Arguments, meta)
	if result.Content == nil {
		result.Content = []Content{}
	}
	s.reply(ctx, w, id, result)
}

func (s *Server) safeCall(ctx context.Context, tool Tool, args json.RawMessage, meta Meta) (result *Result) {
	defer func() {
		if r := recover(); r != nil {
			result = Failure(fmt.Sprintf("tool %s panicked: %v", tool.Name, r))
			_ = debug.Stack()
		}
	}()
	res, err := tool.Handler(ctx, args, meta)
	if err != nil {
		return Failure(err.Error())
	}
	if res == nil {
		return Text(map[string]any{})
	}
	return res
}

func (s *Server) reply(ctx context.Context, w Writer, id json.RawMessage, result any) {
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	if err != nil {
		s.replyError(ctx, w, id, -32603, "result is not serialisable")
		return
	}
	_ = w.Write(ctx, payload)
}
func (s *Server) replyError(ctx context.Context, w Writer, id json.RawMessage, code int, message string) {
	payload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "error": rpcError{Code: code, Message: message}})
	_ = w.Write(ctx, payload)
}

// Schema helpers keep tool definitions short.

// Object builds a JSON Schema object with the given properties and required names.
func Object(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		sort.Strings(required)
		schema["required"] = required
	}
	return schema
}
