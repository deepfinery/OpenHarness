// Package linuxtools is the Linux tool set: run_command, files, search, system and processes. Every tool applies
// the local policy itself; the gateway's per-machine allow-list is a second layer.
package linuxtools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/deepfinery/OpenHarness/connector-go/internal/audit"
	"github.com/deepfinery/OpenHarness/connector-go/internal/mcp"
	"github.com/deepfinery/OpenHarness/connector-go/internal/policy"
)

// ToolNames lists the tools in the order they are registered.
var ToolNames = []string{"run_command", "read_file", "write_file", "list_dir", "search_files", "system_info", "process_list"}

// Context is what the tools need from the connector.
type Context struct {
	Policy   *policy.Policy
	Audit    *audit.Log
	Hostname string
	// Sandboxed marks a connector running inside an OpenShell sandbox; it changes only what the tools report.
	Sandboxed bool
	Version   string
}

type cacheEntry struct {
	result *mcp.Result
	at     time.Time
}

// idempotency remembers results of state-changing calls for ten minutes so a replayed call is harmless.
type idempotency struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
}

func (c *idempotency) get(key string) *mcp.Result {
	if key == "" {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, e := range c.entries {
		if time.Since(e.at) > 10*time.Minute {
			delete(c.entries, k)
		}
	}
	if e, ok := c.entries[key]; ok {
		return e.result
	}
	return nil
}
func (c *idempotency) set(key string, result *mcp.Result) {
	if key == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]cacheEntry{}
	}
	c.entries[key] = cacheEntry{result: result, at: time.Now()}
}

// guarded wraps a tool body with policy error handling, audit logging and idempotent replay.
func guarded[A any](ctx *Context, tool string, body func(context.Context, A) (*mcp.Result, error), cache *idempotency, summary func(A) map[string]any) mcp.ToolHandler {
	return func(callCtx context.Context, raw json.RawMessage, meta mcp.Meta) (*mcp.Result, error) {
		var args A
		if err := json.Unmarshal(raw, &args); err != nil {
			return mcp.Failure("invalid arguments: " + err.Error()), nil
		}
		if cache != nil {
			if replay := cache.get(meta.IdempotencyKey); replay != nil {
				ctx.Audit.Write(map[string]any{"tool": tool, "outcome": "ok", "duration_ms": 0, "idempotency_key": meta.IdempotencyKey, "replayed": true})
				return replay, nil
			}
		}
		started := time.Now()
		result, err := body(callCtx, args)
		entry := map[string]any{"tool": tool, "duration_ms": time.Since(started).Milliseconds()}
		if summary != nil {
			entry["arguments"] = summary(args)
		}
		if meta.IdempotencyKey != "" {
			entry["idempotency_key"] = meta.IdempotencyKey
		}
		if err != nil {
			switch {
			case policy.IsPolicyError(err):
				entry["outcome"] = "denied"
			case errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "timed out"):
				entry["outcome"] = "timeout"
			default:
				entry["outcome"] = "error"
			}
			entry["error"] = err.Error()
			ctx.Audit.Write(entry)
			return mcp.Failure(err.Error()), nil
		}
		if cache != nil {
			cache.set(meta.IdempotencyKey, result)
		}
		if result.IsError {
			entry["outcome"] = "error"
			if structured, ok := result.StructuredContent.(map[string]any); ok && structured["timed_out"] == true {
				entry["outcome"] = "timeout"
			}
		} else {
			entry["outcome"] = "ok"
		}
		ctx.Audit.Write(entry)
		return result, nil
	}
}

// Register adds the Linux tools to the server.
func Register(server *mcp.Server, ctx *Context) {
	commandCache := &idempotency{}
	writeCache := &idempotency{}
	scope := "connector"
	if ctx.Sandboxed {
		scope = "sandbox"
	}
	server.AddTool(mcp.Tool{
		Name:  "run_command",
		Title: "Run a command",
		Description: "Runs a program without a shell. Provide argv as a list (program first). Only allow-listed programs run; " +
			"output is capped and the command is killed at the timeout.",
		InputSchema: mcp.Object(map[string]any{
			"argv":            map[string]any{"type": "array", "items": map[string]any{"type": "string", "minLength": 1}, "minItems": 1, "maxItems": 64, "description": `Program and arguments, e.g. ["ls", "-la", "src"]`},
			"cwd":             map[string]any{"type": "string", "description": "Working directory inside the work directory"},
			"timeout_seconds": map[string]any{"type": "integer", "minimum": 1, "maximum": 3600},
			"stdin":           map[string]any{"type": "string", "maxLength": 200000},
		}, "argv"),
		Handler: guarded(ctx, "run_command", func(callCtx context.Context, a struct {
			Argv           []string `json:"argv"`
			Cwd            string   `json:"cwd"`
			TimeoutSeconds int      `json:"timeout_seconds"`
			Stdin          *string  `json:"stdin"`
		}) (*mcp.Result, error) {
			if len(a.Argv) == 0 || len(a.Argv) > 64 {
				return nil, &policyErr{"argv must hold between 1 and 64 strings"}
			}
			if err := ctx.Policy.CheckCommand(a.Argv); err != nil {
				return nil, err
			}
			cwd := a.Cwd
			if cwd == "" {
				cwd = "."
			}
			dir, err := ctx.Policy.ResolvePath(cwd, false)
			if err != nil {
				return nil, err
			}
			timeout := ctx.Policy.Timeout(a.TimeoutSeconds)
			started := time.Now()
			run, err := runProcess(callCtx, a.Argv, dir, timeout, ctx.Policy.MaxOutputBytes(), a.Stdin)
			if err != nil {
				return nil, err
			}
			structured := map[string]any{
				"exit_code": run.ExitCode, "signal": run.Signal, "stdout": run.Stdout, "stderr": run.Stderr,
				"truncated": run.Truncated, "timed_out": run.TimedOut, "duration_ms": time.Since(started).Milliseconds(),
				"argv": a.Argv, "execution_scope": scope, "effective_access": "restricted",
			}
			parts := []string{fmt.Sprintf("[execution scope: %s, restricted]", scope)}
			// A timed-out command is a definite outcome: the process was killed. Its partial output is still evidence.
			if run.TimedOut {
				parts = append(parts, fmt.Sprintf("[timed out after %d s; the command was killed. Partial output follows. A larger timeout_seconds works up to the connector's COMMAND_TIMEOUT_SECONDS.]", int(timeout.Seconds())))
			}
			if run.Stdout != "" {
				parts = append(parts, run.Stdout)
			}
			if run.Stderr != "" {
				parts = append(parts, "[stderr]\n"+run.Stderr)
			}
			if !run.TimedOut {
				exit := fmt.Sprintf("[exit %d]", run.ExitCode)
				if run.Signal != nil {
					exit = fmt.Sprintf("[exit %s]", *run.Signal)
				}
				parts = append(parts, exit)
			}
			return &mcp.Result{Content: []mcp.Content{{Type: "text", Text: strings.Join(parts, "\n")}}, StructuredContent: structured, IsError: run.TimedOut || run.ExitCode != 0}, nil
		}, commandCache, func(a struct {
			Argv           []string `json:"argv"`
			Cwd            string   `json:"cwd"`
			TimeoutSeconds int      `json:"timeout_seconds"`
			Stdin          *string  `json:"stdin"`
		}) map[string]any {
			out := map[string]any{"argv": a.Argv}
			if a.Cwd != "" {
				out["cwd"] = a.Cwd
			}
			if a.Stdin != nil {
				out["stdin_bytes"] = len(*a.Stdin)
			}
			return out
		}),
	})
	server.AddTool(mcp.Tool{
		Name:        "read_file",
		Title:       "Read a file",
		Description: "Reads a UTF-8 text file inside the work directory. Large files are truncated to the output cap.",
		InputSchema: mcp.Object(map[string]any{
			"path":      map[string]any{"type": "string", "minLength": 1},
			"max_bytes": map[string]any{"type": "integer", "minimum": 1},
		}, "path"),
		Handler: guarded(ctx, "read_file", func(_ context.Context, a struct {
			Path     string `json:"path"`
			MaxBytes int    `json:"max_bytes"`
		}) (*mcp.Result, error) {
			target, err := ctx.Policy.ResolvePath(a.Path, false)
			if err != nil {
				return nil, err
			}
			info, err := os.Stat(target)
			if err != nil {
				return nil, err
			}
			if !info.Mode().IsRegular() {
				return nil, &policyErr{"not a regular file"}
			}
			limit := ctx.Policy.MaxOutputBytes()
			if a.MaxBytes > 0 && a.MaxBytes < limit {
				limit = a.MaxBytes
			}
			f, err := os.Open(target)
			if err != nil {
				return nil, err
			}
			defer f.Close()
			buf := make([]byte, min64(int64(limit), info.Size()))
			n, err := io.ReadFull(f, buf)
			if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
				return nil, err
			}
			return mcp.Text(map[string]any{"path": target, "size": info.Size(), "truncated": info.Size() > int64(n), "content": string(buf[:n])}), nil
		}, nil, func(a struct {
			Path     string `json:"path"`
			MaxBytes int    `json:"max_bytes"`
		}) map[string]any {
			return map[string]any{"path": a.Path}
		}),
	})
	server.AddTool(mcp.Tool{
		Name:        "write_file",
		Title:       "Write a file",
		Description: "Writes UTF-8 text to a file inside the work directory. Disabled in read-only mode.",
		InputSchema: mcp.Object(map[string]any{
			"path":    map[string]any{"type": "string", "minLength": 1},
			"content": map[string]any{"type": "string", "maxLength": 5000000},
			"mode":    map[string]any{"type": "string", "enum": []string{"overwrite", "append", "create"}, "default": "overwrite", "description": "create fails if the file exists"},
		}, "content", "path"),
		Handler: guarded(ctx, "write_file", func(_ context.Context, a struct {
			Path    string `json:"path"`
			Content string `json:"content"`
			Mode    string `json:"mode"`
		}) (*mcp.Result, error) {
			if len(a.Content) > 5_000_000 {
				return nil, &policyErr{"content exceeds 5 MB"}
			}
			target, err := ctx.Policy.ResolvePath(a.Path, true)
			if err != nil {
				return nil, err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return nil, err
			}
			flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
			switch a.Mode {
			case "", "overwrite":
				a.Mode = "overwrite"
			case "append":
				flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
			case "create":
				flags = os.O_WRONLY | os.O_CREATE | os.O_EXCL
			default:
				return nil, &policyErr{"mode must be overwrite, append or create"}
			}
			f, err := os.OpenFile(target, flags, 0o644)
			if err != nil {
				return nil, err
			}
			defer f.Close()
			if _, err := f.WriteString(a.Content); err != nil {
				return nil, err
			}
			return mcp.Text(map[string]any{"path": target, "bytes": len(a.Content), "mode": a.Mode}), nil
		}, writeCache, func(a struct {
			Path    string `json:"path"`
			Content string `json:"content"`
			Mode    string `json:"mode"`
		}) map[string]any {
			return map[string]any{"path": a.Path, "mode": a.Mode, "content_bytes": len(a.Content)}
		}),
	})
	server.AddTool(mcp.Tool{
		Name:        "list_dir",
		Title:       "List a directory",
		Description: "Lists entries (name, type, size, modified) up to a small depth inside the work directory.",
		InputSchema: mcp.Object(map[string]any{
			"path":  map[string]any{"type": "string", "default": "."},
			"depth": map[string]any{"type": "integer", "minimum": 1, "maximum": 4, "default": 1},
		}),
		Handler: guarded(ctx, "list_dir", func(_ context.Context, a struct {
			Path  string `json:"path"`
			Depth int    `json:"depth"`
		}) (*mcp.Result, error) {
			if a.Path == "" {
				a.Path = "."
			}
			if a.Depth <= 0 {
				a.Depth = 1
			}
			if a.Depth > 4 {
				a.Depth = 4
			}
			root, err := ctx.Policy.ResolvePath(a.Path, false)
			if err != nil {
				return nil, err
			}
			type entry struct {
				Path     string `json:"path"`
				Type     string `json:"type"`
				Size     int64  `json:"size"`
				Modified string `json:"modified"`
			}
			entries := []entry{}
			var walk func(dir string, level int) error
			walk = func(dir string, level int) error {
				items, err := os.ReadDir(dir)
				if err != nil {
					return err
				}
				for _, item := range items {
					if len(entries) >= 2000 {
						return nil
					}
					full := filepath.Join(dir, item.Name())
					info, _ := item.Info()
					kind := "other"
					switch {
					case item.Type()&fs.ModeSymlink != 0:
						kind = "symlink"
					case item.IsDir():
						kind = "dir"
					case item.Type().IsRegular():
						kind = "file"
					}
					rel, _ := filepath.Rel(root, full)
					if rel == "" {
						rel = "."
					}
					e := entry{Path: rel, Type: kind}
					if info != nil {
						e.Size = info.Size()
						e.Modified = info.ModTime().UTC().Format(time.RFC3339)
					}
					entries = append(entries, e)
					if item.IsDir() && item.Type()&fs.ModeSymlink == 0 && level < a.Depth {
						if err := walk(full, level+1); err != nil {
							return err
						}
					}
				}
				return nil
			}
			if err := walk(root, 1); err != nil {
				return nil, err
			}
			return mcp.Text(map[string]any{"path": root, "entries": entries, "truncated": len(entries) >= 2000}), nil
		}, nil, nil),
	})
	server.AddTool(mcp.Tool{
		Name:        "search_files",
		Title:       "Search files",
		Description: "Finds files by name glob and/or text content (regular expression) under a directory inside the work directory.",
		InputSchema: mcp.Object(map[string]any{
			"path":         map[string]any{"type": "string", "default": "."},
			"name_pattern": map[string]any{"type": "string", "maxLength": 200, "description": "Glob on the file name, e.g. *.log"},
			"content":      map[string]any{"type": "string", "maxLength": 500, "description": "Regular expression matched against file text"},
			"max_results":  map[string]any{"type": "integer", "minimum": 1, "maximum": 500, "default": 100},
		}),
		Handler: guarded(ctx, "search_files", func(_ context.Context, a struct {
			Path        string `json:"path"`
			NamePattern string `json:"name_pattern"`
			Content     string `json:"content"`
			MaxResults  int    `json:"max_results"`
		}) (*mcp.Result, error) {
			if a.Path == "" {
				a.Path = "."
			}
			if a.MaxResults <= 0 || a.MaxResults > 500 {
				a.MaxResults = 100
			}
			root, err := ctx.Policy.ResolvePath(a.Path, false)
			if err != nil {
				return nil, err
			}
			var contentRe *regexp.Regexp
			if a.Content != "" {
				contentRe, err = regexp.Compile("(?i)" + a.Content)
				if err != nil {
					return nil, fmt.Errorf("invalid content pattern: %w", err)
				}
			}
			type match struct {
				Path string `json:"path"`
				Line int    `json:"line,omitempty"`
				Text string `json:"text,omitempty"`
			}
			matches := []match{}
			visited := 0
			var walk func(dir string)
			walk = func(dir string) {
				items, err := os.ReadDir(dir)
				if err != nil {
					return
				}
				for _, item := range items {
					if len(matches) >= a.MaxResults || visited > 20_000 {
						return
					}
					full := filepath.Join(dir, item.Name())
					if item.Type()&fs.ModeSymlink != 0 {
						continue
					}
					if item.IsDir() {
						if item.Name() == "node_modules" || item.Name() == ".git" {
							continue
						}
						walk(full)
						continue
					}
					if !item.Type().IsRegular() {
						continue
					}
					visited++
					if a.NamePattern != "" {
						if ok, _ := filepath.Match(a.NamePattern, item.Name()); !ok {
							if ok2, _ := filepath.Match(strings.ToLower(a.NamePattern), strings.ToLower(item.Name())); !ok2 {
								continue
							}
						}
					}
					rel, _ := filepath.Rel(root, full)
					if contentRe == nil {
						matches = append(matches, match{Path: rel})
						continue
					}
					info, err := item.Info()
					if err != nil || info.Size() > 1_000_000 {
						continue
					}
					data, err := os.ReadFile(full)
					if err != nil {
						continue
					}
					for i, line := range strings.Split(string(data), "\n") {
						if contentRe.MatchString(line) {
							if len(line) > 300 {
								line = line[:300]
							}
							matches = append(matches, match{Path: rel, Line: i + 1, Text: line})
							if len(matches) >= a.MaxResults {
								break
							}
						}
					}
				}
			}
			walk(root)
			return mcp.Text(map[string]any{"path": root, "matches": matches, "files_visited": visited, "truncated": len(matches) >= a.MaxResults}), nil
		}, nil, nil),
	})
	server.AddTool(mcp.Tool{
		Name:        "system_info",
		Title:       "System information",
		Description: "Host name, kernel, CPU, memory, load and the connector's own scope and policy.",
		InputSchema: mcp.Object(map[string]any{}),
		Handler: guarded(ctx, "system_info", func(_ context.Context, _ struct{}) (*mcp.Result, error) {
			info := map[string]any{
				"execution_scope": scope,
				"command_access":  "Connector allow-list; host visibility is not implied",
				"file_tool_scope": "connector work directory",
				"hostname":        ctx.Hostname,
				"platform":        runtime.GOOS,
				"arch":            runtime.GOARCH,
				"cpus":            runtime.NumCPU(),
				"work_dir":        ctx.Policy.WorkDir,
				"read_only":       ctx.Policy.ReadOnly(),
				"allow_commands":  ctx.Policy.AllowCommands(),
				"connector":       "openharness-connector " + ctx.Version,
				"sandboxed":       ctx.Sandboxed,
				"go":              runtime.Version(),
			}
			var uts syscall.Utsname
			if err := syscall.Uname(&uts); err == nil {
				info["release"] = utsString(uts.Release[:])
				info["kernel"] = utsString(uts.Sysname[:]) + " " + utsString(uts.Release[:]) + " " + utsString(uts.Version[:])
			}
			if mem, err := os.ReadFile("/proc/meminfo"); err == nil {
				for _, line := range strings.Split(string(mem), "\n") {
					fields := strings.Fields(line)
					if len(fields) < 2 {
						continue
					}
					kb, _ := strconv.ParseInt(fields[1], 10, 64)
					switch fields[0] {
					case "MemTotal:":
						info["memory_total_bytes"] = kb * 1024
					case "MemAvailable:":
						info["memory_free_bytes"] = kb * 1024
					}
				}
			}
			if load, err := os.ReadFile("/proc/loadavg"); err == nil {
				fields := strings.Fields(string(load))
				if len(fields) >= 3 {
					avg := make([]float64, 0, 3)
					for _, f := range fields[:3] {
						v, _ := strconv.ParseFloat(f, 64)
						avg = append(avg, v)
					}
					info["load_average"] = avg
				}
			}
			if up, err := os.ReadFile("/proc/uptime"); err == nil {
				fields := strings.Fields(string(up))
				if len(fields) >= 1 {
					v, _ := strconv.ParseFloat(fields[0], 64)
					info["uptime_seconds"] = v
				}
			}
			if u, err := user.Current(); err == nil {
				info["user"] = u.Username
			}
			if model, err := cpuModel(); err == nil && model != "" {
				info["cpu_model"] = model
			}
			return mcp.Text(info), nil
		}, nil, nil),
	})
	server.AddTool(mcp.Tool{
		Name:        "process_list",
		Title:       "List processes",
		Description: "Processes visible in the connector's PID namespace.",
		InputSchema: mcp.Object(map[string]any{}),
		Handler: guarded(ctx, "process_list", func(_ context.Context, _ struct{}) (*mcp.Result, error) {
			type proc struct {
				PID   int    `json:"pid"`
				PPID  int    `json:"ppid,omitempty"`
				Name  string `json:"name"`
				State string `json:"state,omitempty"`
				RSSKB int    `json:"rss_kb,omitempty"`
				UID   int    `json:"uid"`
			}
			entries, err := os.ReadDir("/proc")
			if err != nil {
				return nil, errors.New("process information is unavailable on this platform (/proc missing)")
			}
			procs := []proc{}
			for _, e := range entries {
				pid, err := strconv.Atoi(e.Name())
				if err != nil {
					continue
				}
				status, err := os.ReadFile(filepath.Join("/proc", e.Name(), "status"))
				if err != nil {
					continue
				}
				p := proc{PID: pid}
				for _, line := range strings.Split(string(status), "\n") {
					key, value, ok := strings.Cut(line, ":")
					if !ok {
						continue
					}
					value = strings.TrimSpace(value)
					switch key {
					case "Name":
						p.Name = value
					case "PPid":
						p.PPID, _ = strconv.Atoi(value)
					case "State":
						p.State = value
					case "VmRSS":
						p.RSSKB, _ = strconv.Atoi(strings.Fields(value)[0])
					case "Uid":
						p.UID, _ = strconv.Atoi(strings.Fields(value)[0])
					}
				}
				procs = append(procs, p)
				if len(procs) >= 2000 {
					break
				}
			}
			if len(procs) == 0 {
				return nil, errors.New("process information is unavailable on this platform (/proc missing)")
			}
			return mcp.Text(map[string]any{"count": len(procs), "processes": procs}), nil
		}, nil, nil),
	})
}

type policyErr struct{ msg string }

func (e *policyErr) Error() string { return e.msg }
func (e *policyErr) Is(target error) bool {
	_, ok := target.(*policy.Error)
	return ok
}

type processResult struct {
	ExitCode  int
	Signal    *string
	Stdout    string
	Stderr    string
	Truncated bool
	TimedOut  bool
}

// cappedBuffer keeps at most limit bytes and remembers whether anything was dropped.
type cappedBuffer struct {
	mu        sync.Mutex
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	room := c.limit - c.buf.Len()
	if room <= 0 {
		c.truncated = true
		return len(p), nil
	}
	if len(p) > room {
		c.truncated = true
		c.buf.Write(p[:room])
		return len(p), nil
	}
	c.buf.Write(p)
	return len(p), nil
}

func runProcess(ctx context.Context, argv []string, dir string, timeout time.Duration, maxBytes int, stdin *string) (*processResult, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = safeEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// Kill the whole process group at the deadline so children cannot outlive the command.
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return cmd.Process.Kill()
	}
	stdout := &cappedBuffer{limit: maxBytes}
	stderr := &cappedBuffer{limit: maxBytes}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if stdin != nil {
		cmd.Stdin = strings.NewReader(*stdin)
	}
	err := cmd.Run()
	result := &processResult{Stdout: stdout.buf.String(), Stderr: stderr.buf.String(), Truncated: stdout.truncated || stderr.truncated}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		result.TimedOut = true
		result.ExitCode = -1
		return result, nil
	}
	if ctx.Err() != nil {
		return nil, fmt.Errorf("command cancelled: %w", ctx.Err())
	}
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		result.ExitCode = 0
	case errors.As(err, &exitErr):
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			sig := status.Signal().String()
			result.Signal = &sig
			result.ExitCode = -1
		} else {
			result.ExitCode = exitErr.ExitCode()
		}
	default:
		return nil, fmt.Errorf("could not start %s: %w", argv[0], err)
	}
	return result, nil
}

func safeEnv() []string {
	env := []string{"TERM=dumb"}
	for _, key := range []string{"PATH", "HOME", "LANG"} {
		if v := os.Getenv(key); v != "" {
			env = append(env, key+"="+v)
		}
	}
	if os.Getenv("LANG") == "" {
		env = append(env, "LANG=C.UTF-8")
	}
	if os.Getenv("PATH") == "" {
		env = append(env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}
	return env
}

func utsString(chars []int8) string {
	b := make([]byte, 0, len(chars))
	for _, c := range chars {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}

func cpuModel() (string, error) {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if key, value, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(key) == "model name" {
			return strings.TrimSpace(value), nil
		}
	}
	return "", nil
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
