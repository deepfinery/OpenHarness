package linuxtools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/deepfinery/OpenHarness/connector-go/internal/audit"
	"github.com/deepfinery/OpenHarness/connector-go/internal/mcp"
	"github.com/deepfinery/OpenHarness/connector-go/internal/policy"
)

type memWriter struct{ out chan []byte }

func (w *memWriter) Write(_ context.Context, m []byte) error { w.out <- m; return nil }

type harness struct {
	t      *testing.T
	server *mcp.Server
	w      *memWriter
	work   string
	audit  string
}

func setup(t *testing.T, allow []string, readOnly bool) *harness {
	work := t.TempDir()
	if err := os.MkdirAll(filepath.Join(work, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "docs", "readme.md"), []byte("hello from the work dir\nsecond line with needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pol, err := policy.New(policy.Options{WorkDir: work, AllowCommands: allow, MaxOutputBytes: 2000, CommandTimeout: time.Second, ReadOnly: readOnly})
	if err != nil {
		t.Fatal(err)
	}
	auditFile := filepath.Join(t.TempDir(), "audit.jsonl")
	log, err := audit.Open(auditFile)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { log.Close() })
	server := mcp.NewServer("test", "0")
	Register(server, &Context{Policy: pol, Audit: log, Hostname: "unit-host", Version: "test"})
	return &harness{t: t, server: server, w: &memWriter{out: make(chan []byte, 16)}, work: work, audit: auditFile}
}

func (h *harness) call(name string, args map[string]any, key string) (structured map[string]any, text string, isError bool) {
	params := map[string]any{"name": name, "arguments": args}
	if key != "" {
		params["_meta"] = map[string]any{"idempotencyKey": key}
	}
	raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params})
	h.server.HandleFrame(context.Background(), raw, h.w)
	select {
	case reply := <-h.w.out:
		var m struct {
			Result struct {
				Content           []mcp.Content  `json:"content"`
				StructuredContent map[string]any `json:"structuredContent"`
				IsError           bool           `json:"isError"`
			} `json:"result"`
		}
		if err := json.Unmarshal(reply, &m); err != nil {
			h.t.Fatal(err)
		}
		if len(m.Result.Content) > 0 {
			text = m.Result.Content[0].Text
		}
		return m.Result.StructuredContent, text, m.Result.IsError
	case <-time.After(5 * time.Second):
		h.t.Fatal("no reply")
		return nil, "", false
	}
}

func TestToolsApplyPolicyAndReportStructuredResults(t *testing.T) {
	h := setup(t, []string{"echo", "cat", "sleep", "sh", "pwd"}, false)
	if names := h.server.ToolNames(); strings.Join(names, ",") != strings.Join(ToolNames, ",") {
		t.Fatalf("tool order: %v", names)
	}
	s, text, isError := h.call("run_command", map[string]any{"argv": []string{"echo", "hello", "world"}}, "")
	if isError || s["exit_code"].(float64) != 0 || strings.TrimSpace(s["stdout"].(string)) != "hello world" || !strings.Contains(text, "[exit 0]") {
		t.Fatalf("echo: %v %q %v", s, text, isError)
	}
	if s["execution_scope"] != "connector" || s["effective_access"] != "restricted" {
		t.Fatalf("scope labels: %v", s)
	}
	if _, text, isError := h.call("run_command", map[string]any{"argv": []string{"rm", "-rf", "x"}}, ""); !isError || !strings.Contains(text, "denied by policy") {
		t.Fatalf("rm must be denied: %q", text)
	}
	if _, text, isError := h.call("run_command", map[string]any{"argv": []string{"curl", "x"}}, ""); !isError || !strings.Contains(text, "allow-list") {
		t.Fatalf("curl must be refused: %q", text)
	}
	if _, text, isError := h.call("run_command", map[string]any{"argv": []string{"sh", "-c", "echo $((1+1))"}}, ""); isError || !strings.Contains(text, "2") {
		t.Fatalf("sh is allowed here: %q", text)
	}
	if s, _, _ := h.call("run_command", map[string]any{"argv": []string{"pwd"}, "cwd": "docs"}, ""); !strings.HasSuffix(strings.TrimSpace(s["stdout"].(string)), "/docs") {
		t.Fatalf("cwd inside the jail: %v", s)
	}
	if _, text, isError := h.call("run_command", map[string]any{"argv": []string{"pwd"}, "cwd": "../.."}, ""); !isError || !strings.Contains(text, "outside the work directory") {
		t.Fatalf("cwd outside the jail: %q", text)
	}
	if s, _, isError := h.call("run_command", map[string]any{"argv": []string{"sh", "-c", "exit 3"}}, ""); !isError || s["exit_code"].(float64) != 3 {
		t.Fatalf("non-zero exit is an error result with the code: %v", s)
	}
	if _, text, isError := h.call("run_command", map[string]any{"argv": []string{"sleep", "5"}, "timeout_seconds": 1}, ""); !isError || !strings.Contains(text, "timed out") {
		t.Fatalf("timeout: %q", text)
	}
	if s, _, _ := h.call("run_command", map[string]any{"argv": []string{"cat"}, "stdin": "from stdin"}, ""); s["stdout"] != "from stdin" {
		t.Fatalf("stdin: %v", s)
	}
	big := strings.Repeat("x", 5000)
	if s, _, _ := h.call("run_command", map[string]any{"argv": []string{"echo", big}}, ""); s["truncated"] != true || len(s["stdout"].(string)) > 2000 {
		t.Fatalf("output cap: %v", s["truncated"])
	}
	// Idempotent replay: the same key returns the first result without running again.
	first, _, _ := h.call("run_command", map[string]any{"argv": []string{"sh", "-c", "echo $RANDOM$RANDOM"}}, "run:1")
	second, _, _ := h.call("run_command", map[string]any{"argv": []string{"sh", "-c", "echo $RANDOM$RANDOM"}}, "run:1")
	if first["stdout"] != second["stdout"] {
		t.Fatal("replay with the same idempotency key must return the stored result")
	}

	s, _, isError = h.call("read_file", map[string]any{"path": "docs/readme.md"}, "")
	if isError || !strings.Contains(s["content"].(string), "needle") || s["truncated"] != false {
		t.Fatalf("read_file: %v", s)
	}
	if s, _, _ := h.call("read_file", map[string]any{"path": "docs/readme.md", "max_bytes": 5}, ""); s["content"] != "hello" || s["truncated"] != true {
		t.Fatalf("read_file cap: %v", s)
	}
	if _, text, isError := h.call("read_file", map[string]any{"path": "/etc/passwd"}, ""); !isError || !strings.Contains(text, "outside") {
		t.Fatalf("read outside the jail: %q", text)
	}
	if _, _, isError := h.call("read_file", map[string]any{"path": "docs"}, ""); !isError {
		t.Fatal("reading a directory is an error")
	}
	if s, _, isError := h.call("write_file", map[string]any{"path": "out/new.txt", "content": "one"}, "w:1"); isError || s["bytes"].(float64) != 3 {
		t.Fatalf("write_file: %v", s)
	}
	h.call("write_file", map[string]any{"path": "out/new.txt", "content": "two", "mode": "append"}, "")
	if data, _ := os.ReadFile(filepath.Join(h.work, "out", "new.txt")); string(data) != "onetwo" {
		t.Fatalf("append: %q", data)
	}
	if _, _, isError := h.call("write_file", map[string]any{"path": "out/new.txt", "content": "x", "mode": "create"}, ""); !isError {
		t.Fatal("create refuses an existing file")
	}
	h.call("write_file", map[string]any{"path": "out/new.txt", "content": "IGNORED", "mode": "overwrite"}, "w:1")
	if data, _ := os.ReadFile(filepath.Join(h.work, "out", "new.txt")); string(data) != "onetwo" {
		t.Fatal("a replayed write must not run again")
	}
	if s, _, _ := h.call("list_dir", map[string]any{"path": ".", "depth": 2}, ""); !containsPath(s["entries"].([]any), "docs/readme.md") {
		t.Fatalf("list_dir depth 2: %v", s)
	}
	if s, _, _ := h.call("search_files", map[string]any{"path": ".", "content": "NEEDLE"}, ""); len(s["matches"].([]any)) != 1 || s["matches"].([]any)[0].(map[string]any)["line"].(float64) != 2 {
		t.Fatalf("search_files content: %v", s)
	}
	if s, _, _ := h.call("search_files", map[string]any{"name_pattern": "*.md"}, ""); len(s["matches"].([]any)) != 1 {
		t.Fatalf("search_files glob: %v", s)
	}
	if s, _, isError := h.call("system_info", map[string]any{}, ""); isError || s["hostname"] != "unit-host" || s["execution_scope"] != "connector" || s["work_dir"] == nil {
		t.Fatalf("system_info: %v", s)
	}
	if s, _, isError := h.call("process_list", map[string]any{}, ""); isError || s["count"].(float64) < 1 {
		t.Fatalf("process_list: %v", s)
	}
	entries, _ := os.ReadFile(h.audit)
	if !strings.Contains(string(entries), `"outcome":"denied"`) || !strings.Contains(string(entries), `"tool":"run_command"`) || !strings.Contains(string(entries), `"replayed":true`) {
		t.Fatalf("audit log incomplete:\n%s", entries)
	}
	if strings.Contains(string(entries), "from stdin") || strings.Contains(string(entries), "IGNORED") {
		t.Fatal("audit must not record stdin or file contents")
	}
}

func TestReadOnlyAndSandboxScope(t *testing.T) {
	h := setup(t, []string{"echo"}, true)
	if _, text, isError := h.call("write_file", map[string]any{"path": "x", "content": "y"}, ""); !isError || !strings.Contains(text, "read-only") {
		t.Fatalf("read-only: %q", text)
	}
	work := t.TempDir()
	pol, _ := policy.New(policy.Options{WorkDir: work, AllowCommands: []string{"echo"}})
	log, _ := audit.Open("")
	server := mcp.NewServer("test", "0")
	Register(server, &Context{Policy: pol, Audit: log, Hostname: "sandbox-1", Sandboxed: true, Version: "test"})
	sb := &harness{t: t, server: server, w: &memWriter{out: make(chan []byte, 4)}, work: work}
	if s, _, _ := sb.call("run_command", map[string]any{"argv": []string{"echo", "x"}}, ""); s["execution_scope"] != "sandbox" {
		t.Fatalf("sandboxed connectors label their scope: %v", s)
	}
	if s, _, _ := sb.call("system_info", map[string]any{}, ""); s["sandboxed"] != true {
		t.Fatalf("system_info reports sandboxing: %v", s)
	}
}

func containsPath(entries []any, path string) bool {
	for _, e := range entries {
		if e.(map[string]any)["path"] == path {
			return true
		}
	}
	return false
}
