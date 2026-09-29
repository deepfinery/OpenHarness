package edge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
	"github.com/deepfinery/OpenHarness/connector-go/internal/audit"
	"github.com/deepfinery/OpenHarness/connector-go/internal/mcp"
)

// ToolNames lists the edge tools in registration order.
var ToolNames = []string{
	"openshell_status", "list_workspaces", "list_sandboxes", "get_sandbox", "create_sandbox", "delete_sandbox",
	"start_sandbox", "stop_sandbox", "exec_in_sandbox", "sandbox_logs", "list_policy_revisions", "get_policy",
	"set_policy", "update_policy_rules", "list_rule_proposals", "approve_rule", "reject_rule", "get_global_policy",
	"launch_executor",
}

var (
	sandboxNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	workspaceRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	durationRe    = regexp.MustCompile(`^\d{1,6}(s|m|h)$`)
)

// Registrar binds the tools to a backend under the edge settings.
type Registrar struct {
	Backend  Backend
	Settings Settings
	Audit    *audit.Log
}

type sandboxSummary struct {
	Name                 string            `json:"name"`
	ID                   string            `json:"id"`
	Workspace            string            `json:"workspace"`
	Phase                string            `json:"phase"`
	CreatedAt            string            `json:"created_at"`
	Labels               map[string]string `json:"labels"`
	CurrentPolicyVersion uint32            `json:"current_policy_version"`
	ExitCode             *int32            `json:"exit_code"`
	Conditions           []map[string]any  `json:"conditions"`
	Image                string            `json:"image,omitempty"`
	Managed              bool              `json:"managed"`
	Executor             string            `json:"executor,omitempty"`
}

func (r *Registrar) summarize(s *v1.Sandbox) sandboxSummary {
	out := sandboxSummary{Name: s.Name, ID: s.ID, Workspace: s.Workspace, Phase: string(s.Status.Phase), CreatedAt: s.CreatedAt.UTC().Format(time.RFC3339), Labels: s.Labels, CurrentPolicyVersion: s.Status.CurrentPolicyVersion, ExitCode: s.Status.ExitCode, Conditions: []map[string]any{}}
	if out.Labels == nil {
		out.Labels = map[string]string{}
	}
	for _, c := range s.Status.Conditions {
		out.Conditions = append(out.Conditions, map[string]any{"type": c.Type, "status": c.Status, "reason": c.Reason, "message": c.Message})
	}
	if s.Spec.Template != nil {
		out.Image = s.Spec.Template.Image
	}
	out.Managed = s.Labels["openharness.device"] == r.Settings.DeviceID
	out.Executor = s.Labels["openharness.executor"]
	return out
}

// manageable loads a sandbox and checks the edge may change it.
func (r *Registrar) manageable(ctx context.Context, workspace, name string) (*v1.Sandbox, error) {
	s, err := r.Backend.GetSandbox(ctx, workspace, name)
	if err != nil {
		return nil, err
	}
	if !r.Settings.ManageAllSandboxes && s.Labels["openharness.device"] != r.Settings.DeviceID {
		return nil, denied("sandbox %s was not created by this edge; manage_all_sandboxes is off", name)
	}
	return s, nil
}

func revisionView(scope, sandbox string, rev v1.SandboxPolicyRevision, active uint32, includePolicy bool) map[string]any {
	view := map[string]any{"scope": scope, "version": rev.Version, "hash": rev.PolicyHash, "status": LoadStatusName(rev.Status), "active_version": active}
	if sandbox != "" {
		view["sandbox"] = sandbox
	}
	if !rev.CreatedAt.IsZero() {
		view["created_at"] = rev.CreatedAt.UTC().Format(time.RFC3339)
		view["created_at_ms"] = rev.CreatedAt.UnixMilli()
	}
	if !rev.LoadedAt.IsZero() {
		view["loaded_at"] = rev.LoadedAt.UTC().Format(time.RFC3339)
		view["loaded_at_ms"] = rev.LoadedAt.UnixMilli()
	}
	if rev.LoadError != "" {
		view["load_error"] = rev.LoadError
	}
	if len(rev.Provenance) > 0 {
		view["provenance"] = rev.Provenance
	}
	if includePolicy {
		view["policy"] = FromSDK(rev.Policy)
	}
	return view
}

func chunkView(c v1.PolicyChunk) map[string]any {
	view := map[string]any{"id": c.ID, "status": c.Status, "rule_name": c.RuleName, "binary": c.Binary, "confidence": int(c.Confidence*100 + 0.5), "rationale": c.Rationale, "hits": c.HitCount, "stage": c.Stage}
	if c.SecurityNotes != "" {
		view["security_notes"] = c.SecurityNotes
	}
	if c.ValidationResult != "" {
		view["prover"] = c.ValidationResult
	}
	if c.ApplicationError != "" {
		view["application_error"] = c.ApplicationError
	}
	if c.RejectionReason != "" {
		view["rejection_reason"] = c.RejectionReason
	}
	if c.ProposedRule != nil {
		var endpoints, binaries []string
		for _, e := range c.ProposedRule.Endpoints {
			endpoints = append(endpoints, fmt.Sprintf("%s:%d", e.Host, e.Port))
		}
		for _, b := range c.ProposedRule.Binaries {
			binaries = append(binaries, b.Path)
		}
		view["endpoints"] = strings.Join(endpoints, ", ")
		view["binaries"] = strings.Join(binaries, ", ")
		view["proposed_rule"] = FromSDK(&v1.SandboxPolicy{NetworkPolicies: map[string]v1.NetworkPolicyRule{c.RuleName: *c.ProposedRule}}).NetworkPolicies[c.RuleName]
	}
	if !c.FirstSeen.IsZero() {
		view["first_seen"] = c.FirstSeen.UTC().Format(time.RFC3339)
	}
	if !c.LastSeen.IsZero() {
		view["last_seen"] = c.LastSeen.UTC().Format(time.RFC3339)
	}
	return view
}

type call struct {
	r    *Registrar
	name string
}

// run wraps a tool body with argument decoding, audit logging and error mapping.
// deniedStderr recognises the error text of a command that the sandbox policy stopped: the stand-in's explicit
// marker, Landlock and seccomp refusals, and the EACCES a Landlock-jailed process gets on a path outside its policy.
var deniedStderr = regexp.MustCompile(`(?i)policy_denied|blocked by (the )?(sandbox )?policy|Landlock|Operation not permitted|Permission denied`)

// deniedEvent matches the supervisor's OCSF denial events and the stand-in's policy_denied lines.
var deniedEvent = regexp.MustCompile(`(?i)\bDENIED\b|policy_denied`)

// formatLogLine renders one sandbox log line the way sandbox_logs and the console show it.
func formatLogLine(l v1.LogLine) string {
	var fields []string
	for k, v := range l.Fields {
		fields = append(fields, k+"="+v)
	}
	sort.Strings(fields)
	return strings.TrimSpace(fmt.Sprintf("%s %s %s %s", l.Timestamp.UTC().Format(time.RFC3339), l.Level, l.Message, strings.Join(fields, " ")))
}

// denialsSince returns the policy denial events the sandbox recorded since a command started (at most ten), so an
// exec result can say what the policy refused even when the command itself only saw a failed connection or an
// EACCES. The supervisor forwards its events to the gateway a moment after the fact (well under a second in
// practice), so when the command failed the lookup is repeated for up to two seconds before giving up.
// Connection resets caused by a policy reload are not denials of the command and are left out. Log retrieval
// failures are not the caller's problem: the result then relies on the command's own error text.
func (r *Registrar) denialsSince(ctx context.Context, workspace, name string, started time.Time, wait bool) []string {
	deadline := time.Now().Add(2 * time.Second)
	for {
		denials := r.denialsOnce(ctx, workspace, name, started)
		if len(denials) > 0 || !wait || time.Now().After(deadline) {
			return denials
		}
		select {
		case <-ctx.Done():
			return denials
		case <-time.After(400 * time.Millisecond):
		}
	}
}

func (r *Registrar) denialsOnce(ctx context.Context, workspace, name string, started time.Time) []string {
	denials := []string{}
	lines, err := r.Backend.Logs(ctx, workspace, name, LogOptions{Since: time.Since(started) + 5*time.Second, Lines: 500})
	if err != nil {
		return denials
	}
	for _, l := range lines {
		if l.Timestamp.Before(started.Add(-time.Second)) {
			continue
		}
		formatted := formatLogLine(l)
		if !deniedEvent.MatchString(formatted) || strings.Contains(formatted, "policy generation is stale") {
			continue
		}
		denials = append(denials, formatted)
		if len(denials) == 10 {
			break
		}
	}
	return denials
}

func (r *Registrar) run(name string, body func(ctx context.Context, args json.RawMessage) (any, error)) mcp.ToolHandler {
	return func(ctx context.Context, args json.RawMessage, meta mcp.Meta) (*mcp.Result, error) {
		started := time.Now()
		value, err := body(ctx, args)
		entry := map[string]any{"tool": name, "duration_ms": time.Since(started).Milliseconds()}
		if meta.IdempotencyKey != "" {
			entry["idempotency_key"] = meta.IdempotencyKey
		}
		if err != nil {
			var pe *PolicyError
			switch {
			case errors.As(err, &pe):
				entry["outcome"] = "denied"
			case ctx.Err() != nil:
				entry["outcome"] = "timeout"
			default:
				entry["outcome"] = "error"
			}
			entry["error"] = err.Error()
			r.Audit.Write(entry)
			return mcp.Failure(err.Error()), nil
		}
		entry["outcome"] = "ok"
		r.Audit.Write(entry)
		if res, ok := value.(*mcp.Result); ok {
			return res, nil
		}
		return mcp.Text(value), nil
	}
}

func decode[T any](raw json.RawMessage, into *T) error {
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	return nil
}

func validName(name string) error {
	if !sandboxNameRe.MatchString(name) {
		return fmt.Errorf("sandbox name must be lowercase letters, digits and dashes: %q", name)
	}
	return nil
}
func (r *Registrar) workspace(requested string) (string, error) {
	if requested != "" && !workspaceRe.MatchString(requested) {
		return "", fmt.Errorf("invalid workspace name %q", requested)
	}
	return r.Settings.workspace(requested)
}

var workspaceSchema = map[string]any{"type": "string", "description": "OpenShell workspace; the edge's default when omitted"}
var nameSchema = map[string]any{"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,62}$"}

// Register adds every edge tool to the server.
func (r *Registrar) Register(server *mcp.Server) {
	s := &r.Settings
	server.AddTool(mcp.Tool{Name: "openshell_status", Title: "OpenShell status", Description: "Reachability and version of the OpenShell gateway this edge manages, its compute drivers, and the edge settings in force.", InputSchema: mcp.Object(map[string]any{}),
		Handler: r.run("openshell_status", func(ctx context.Context, _ json.RawMessage) (any, error) {
			status, err := r.Backend.Status(ctx)
			if err != nil {
				return nil, err
			}
			drivers := []string{}
			if status.Info != nil {
				for _, d := range status.Info.ComputeDrivers {
					drivers = append(drivers, d.Name)
				}
			}
			state := "connected"
			if !status.Healthy {
				state = "unhealthy"
			}
			return map[string]any{
				"edge_version": s.Version,
				"status":       map[string]any{"status": state, "version": status.Version, "server": "openshell gateway", "authentication": map[string]any{"status": "authenticated"}},
				"gateway_info": map[string]any{"version": status.Version, "compute_drivers": drivers, "healthy": status.Healthy},
				"edge_settings": map[string]any{
					"workspace": s.Workspace, "workspaces": append([]string{s.Workspace}, s.Workspaces...),
					"allow_policy_changes": s.AllowPolicyChanges, "allow_sandbox_lifecycle": s.AllowSandboxLifecycle, "allow_exec": s.AllowExec,
					"allowed_images": s.AllowedImages, "max_sandboxes": s.MaxSandboxes, "manage_all_sandboxes": s.ManageAllSandboxes,
					"executor_image": s.ExecutorImage, "executor_allowed_hosts": s.ExecutorAllowedHosts,
				},
				// Kept for consumers that read the connector_policy shape.
				"connector_policy": map[string]any{"workspace": s.Workspace, "allow_policy_changes": s.AllowPolicyChanges, "allow_sandbox_lifecycle": s.AllowSandboxLifecycle, "allow_exec": s.AllowExec, "allowed_images": s.AllowedImages, "max_sandboxes": s.MaxSandboxes, "manage_all_sandboxes": s.ManageAllSandboxes},
			}, nil
		})})
	server.AddTool(mcp.Tool{Name: "list_workspaces", Title: "List workspaces", Description: "OpenShell workspaces visible to the edge.", InputSchema: mcp.Object(map[string]any{}),
		Handler: r.run("list_workspaces", func(ctx context.Context, _ json.RawMessage) (any, error) {
			workspaces, err := r.Backend.Workspaces(ctx)
			if err != nil {
				return nil, err
			}
			out := []map[string]any{}
			for _, w := range workspaces {
				out = append(out, map[string]any{"name": w.Name, "id": w.ID, "created_at": w.CreatedAt.UTC().Format(time.RFC3339), "status": string(w.Phase), "labels": w.Labels})
			}
			return map[string]any{"workspaces": out}, nil
		})})
	server.AddTool(mcp.Tool{Name: "list_sandboxes", Title: "List sandboxes", Description: "Sandboxes in a workspace with phase, labels and policy version. `managed` marks the ones this edge created; `executor` names the OpenHarness machine a sandbox runs.", InputSchema: mcp.Object(map[string]any{"selector": map[string]any{"type": "string", "description": "label selector, key=value[,key=value]"}, "workspace": workspaceSchema}),
		Handler: r.run("list_sandboxes", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Selector  string `json:"selector"`
				Workspace string `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			list, err := r.Backend.ListSandboxes(ctx, ws, a.Selector)
			if err != nil {
				return nil, err
			}
			out := []sandboxSummary{}
			for _, sb := range list {
				out = append(out, r.summarize(sb))
			}
			return map[string]any{"sandboxes": out, "next_page_token": ""}, nil
		})})
	server.AddTool(mcp.Tool{Name: "get_sandbox", Title: "Get sandbox", Description: "Full detail of one sandbox: conditions, policy source and active policy.", InputSchema: mcp.Object(map[string]any{"name": nameSchema, "workspace": workspaceSchema}, "name"),
		Handler: r.run("get_sandbox", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Name      string `json:"name"`
				Workspace string `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			if err := validName(a.Name); err != nil {
				return nil, err
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			sb, err := r.Backend.GetSandbox(ctx, ws, a.Name)
			if err != nil {
				return nil, err
			}
			view := map[string]any{}
			data, _ := json.Marshal(r.summarize(sb))
			_ = json.Unmarshal(data, &view)
			view["spec"] = map[string]any{"command": sb.Spec.Command, "providers": sb.Spec.Providers}
			if cfg, err := r.Backend.GetConfig(ctx, ws, a.Name); err == nil {
				view["policy"] = FromSDK(cfg.Policy)
				view["revision"] = cfg.PolicyVersion
				view["policy_hash"] = cfg.PolicyHash
				view["policy_source"] = policySourceName(cfg.PolicySource)
				if cfg.GlobalPolicyVersion > 0 {
					view["global_policy_version"] = cfg.GlobalPolicyVersion
				}
			} else {
				view["policy_error"] = err.Error()
			}
			return view, nil
		})})
	server.AddTool(mcp.Tool{Name: "create_sandbox", Title: "Create sandbox", Description: "Create a sandbox from an image with an optional policy (JSON), labels, providers, environment and a detached main command. The sandbox is labelled as created by this edge.", InputSchema: mcp.Object(map[string]any{
		"name": nameSchema, "image": map[string]any{"type": "string"}, "command": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"policy": map[string]any{"description": "policy as a JSON object (or a JSON string)"}, "labels": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}},
		"providers": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}, "env": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}}, "workspace": workspaceSchema,
	}, "name"),
		Handler: r.run("create_sandbox", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Name      string            `json:"name"`
				Image     string            `json:"image"`
				Command   []string          `json:"command"`
				Policy    json.RawMessage   `json:"policy"`
				Labels    map[string]string `json:"labels"`
				Providers []string          `json:"providers"`
				Env       map[string]string `json:"env"`
				Workspace string            `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			if err := validName(a.Name); err != nil {
				return nil, err
			}
			if err := s.lifecycle(); err != nil {
				return nil, err
			}
			if err := s.image(a.Image); err != nil {
				return nil, err
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			if err := r.capacity(ctx, ws); err != nil {
				return nil, err
			}
			var policy *v1.SandboxPolicy
			if len(a.Policy) > 0 && string(a.Policy) != "null" {
				doc, err := ParsePolicyDoc(a.Policy)
				if err != nil {
					return nil, err
				}
				if policy, err = doc.ToSDK(); err != nil {
					return nil, err
				}
			}
			labels := map[string]string{"openharness.device": s.DeviceID}
			for k, v := range a.Labels {
				labels[k] = v
			}
			created, err := r.Backend.CreateSandbox(ctx, ws, a.Name, CreateSpec{Image: a.Image, Environment: a.Env, Command: a.Command, Policy: policy, Labels: labels, Providers: a.Providers})
			if err != nil {
				return nil, err
			}
			return r.summarize(created), nil
		})})
	for _, action := range []string{"delete", "start", "stop"} {
		action := action
		desc := map[string]string{"delete": "Delete a sandbox. Its processes stop and its state is removed; copy out anything needed first.", "start": "Start a stopped sandbox.", "stop": "Stop a sandbox while preserving its workspace."}[action]
		server.AddTool(mcp.Tool{Name: action + "_sandbox", Title: strings.ToUpper(action[:1]) + action[1:] + " sandbox", Description: desc, InputSchema: mcp.Object(map[string]any{"name": nameSchema, "workspace": workspaceSchema}, "name"),
			Handler: r.run(action+"_sandbox", func(ctx context.Context, raw json.RawMessage) (any, error) {
				var a struct {
					Name      string `json:"name"`
					Workspace string `json:"workspace"`
				}
				if err := decode(raw, &a); err != nil {
					return nil, err
				}
				if err := validName(a.Name); err != nil {
					return nil, err
				}
				if err := s.lifecycle(); err != nil {
					return nil, err
				}
				ws, err := r.workspace(a.Workspace)
				if err != nil {
					return nil, err
				}
				if _, err := r.manageable(ctx, ws, a.Name); err != nil {
					return nil, err
				}
				var output any
				switch action {
				case "delete":
					outcome, err := r.Backend.DeleteSandbox(ctx, ws, a.Name)
					if err != nil {
						return nil, err
					}
					output = outcome
				case "start":
					sb, err := r.Backend.StartSandbox(ctx, ws, a.Name)
					if err != nil {
						return nil, err
					}
					output = string(sb.Status.Phase)
				case "stop":
					sb, err := r.Backend.StopSandbox(ctx, ws, a.Name)
					if err != nil {
						return nil, err
					}
					output = string(sb.Status.Phase)
				}
				return map[string]any{"name": a.Name, "action": action, "output": output}, nil
			})})
	}
	server.AddTool(mcp.Tool{Name: "exec_in_sandbox", Title: "Run a command in a sandbox", Description: "Run a program inside a sandbox (argv list, no shell) and return its exit code and output. Network and filesystem denials come from the sandbox policy and are reported as they happen.", InputSchema: mcp.Object(map[string]any{
		"name": nameSchema, "argv": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "minItems": 1, "maxItems": 200},
		"workdir": map[string]any{"type": "string"}, "timeout_seconds": map[string]any{"type": "integer", "minimum": 1, "maximum": 3600}, "env": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}}, "workspace": workspaceSchema,
	}, "argv", "name"),
		Handler: r.run("exec_in_sandbox", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Name           string            `json:"name"`
				Argv           []string          `json:"argv"`
				WorkDir        string            `json:"workdir"`
				TimeoutSeconds int               `json:"timeout_seconds"`
				Env            map[string]string `json:"env"`
				Workspace      string            `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			if err := validName(a.Name); err != nil {
				return nil, err
			}
			if len(a.Argv) == 0 {
				return nil, errors.New("argv must hold at least one string")
			}
			if err := s.exec(); err != nil {
				return nil, err
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			if !s.ManageAllSandboxes {
				if _, err := r.manageable(ctx, ws, a.Name); err != nil {
					return nil, err
				}
			}
			timeout := 120 * time.Second
			if a.TimeoutSeconds > 0 {
				timeout = time.Duration(a.TimeoutSeconds) * time.Second
			}
			started := time.Now()
			result, err := r.Backend.Exec(ctx, ws, a.Name, a.Argv, ExecOptions{WorkDir: a.WorkDir, Env: a.Env, Timeout: timeout})
			if err != nil {
				return nil, err
			}
			deniedByPolicy := deniedStderr.MatchString(result.Stderr)
			// The kernel and the egress proxy refuse silently as far as the command is concerned (curl reports a
			// connection failure, touch a permission error), so attach the supervisor's denial events recorded while
			// the command ran: they name the binary, the destination or path and the reason.
			denials := r.denialsSince(ctx, ws, a.Name, started, result.ExitCode != 0 || deniedByPolicy)
			if len(denials) > 0 {
				deniedByPolicy = true
			}
			view := map[string]any{"name": a.Name, "argv": a.Argv, "exit_code": result.ExitCode, "stdout": result.Stdout, "stderr": result.Stderr, "policy_denied": deniedByPolicy, "denials": denials, "timed_out": false, "truncated": false}
			res := mcp.Text(view)
			return res, nil
		})})
	server.AddTool(mcp.Tool{Name: "sandbox_logs", Title: "Sandbox logs", Description: "Recent sandbox and gateway log lines, including policy denials (destination, binary and reason).", InputSchema: mcp.Object(map[string]any{
		"name": nameSchema, "since": map[string]any{"type": "string", "pattern": `^\d{1,6}(s|m|h)$`}, "source": map[string]any{"type": "string", "enum": []string{"sandbox", "gateway", "all"}},
		"lines": map[string]any{"type": "integer", "minimum": 1, "maximum": 5000}, "level": map[string]any{"type": "string", "enum": []string{"error", "warn", "info", "debug", "trace"}}, "workspace": workspaceSchema,
	}, "name"),
		Handler: r.run("sandbox_logs", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Name      string `json:"name"`
				Since     string `json:"since"`
				Source    string `json:"source"`
				Lines     int    `json:"lines"`
				Level     string `json:"level"`
				Workspace string `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			if err := validName(a.Name); err != nil {
				return nil, err
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			opts := LogOptions{Lines: a.Lines, MinLevel: strings.ToUpper(a.Level)}
			if opts.Lines == 0 {
				opts.Lines = 200
			}
			if a.Since != "" {
				if !durationRe.MatchString(a.Since) {
					return nil, fmt.Errorf("since must look like 10m or 1h")
				}
				n, _ := strconv.Atoi(a.Since[:len(a.Since)-1])
				unit := map[byte]time.Duration{'s': time.Second, 'm': time.Minute, 'h': time.Hour}[a.Since[len(a.Since)-1]]
				opts.Since = time.Duration(n) * unit
			}
			if a.Source != "" && a.Source != "all" {
				opts.Sources = []string{a.Source}
			}
			lines, err := r.Backend.Logs(ctx, ws, a.Name, opts)
			if err != nil {
				return nil, err
			}
			var text []string
			structured := []map[string]any{}
			for _, l := range lines {
				text = append(text, formatLogLine(l))
				structured = append(structured, map[string]any{"timestamp": l.Timestamp.UTC().Format(time.RFC3339), "level": l.Level, "source": l.Source, "message": l.Message, "fields": l.Fields})
			}
			return map[string]any{"name": a.Name, "text": strings.Join(text, "\n"), "lines": structured, "truncated": false}, nil
		})})
	server.AddTool(mcp.Tool{Name: "list_policy_revisions", Title: "Policy revisions", Description: "Revision history of a sandbox policy: version, hash, load status and any load error.", InputSchema: mcp.Object(map[string]any{"name": nameSchema, "workspace": workspaceSchema}, "name"),
		Handler: r.run("list_policy_revisions", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Name      string `json:"name"`
				Workspace string `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			if err := validName(a.Name); err != nil {
				return nil, err
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			revisions, err := r.Backend.PolicyRevisions(ctx, ws, a.Name)
			if err != nil {
				return nil, err
			}
			out := []map[string]any{}
			for _, rev := range revisions {
				out = append(out, revisionView("sandbox", a.Name, rev, 0, false))
			}
			return map[string]any{"name": a.Name, "revisions": out}, nil
		})})
	server.AddTool(mcp.Tool{Name: "get_policy", Title: "Get policy", Description: "A sandbox policy as JSON. `base` is the policy set for the sandbox (the right starting point for edits); `full` is the effective policy the sandbox enforces. Omit rev for the current revision.", InputSchema: mcp.Object(map[string]any{"name": nameSchema, "view": map[string]any{"type": "string", "enum": []string{"base", "full"}, "default": "base"}, "rev": map[string]any{"type": "integer", "minimum": 1}, "workspace": workspaceSchema}, "name"),
		Handler: r.run("get_policy", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Name      string `json:"name"`
				View      string `json:"view"`
				Rev       uint32 `json:"rev"`
				Workspace string `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			if err := validName(a.Name); err != nil {
				return nil, err
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			if a.View == "full" && a.Rev == 0 {
				cfg, err := r.Backend.GetConfig(ctx, ws, a.Name)
				if err != nil {
					return nil, err
				}
				return map[string]any{"scope": "sandbox", "sandbox": a.Name, "version": cfg.PolicyVersion, "active_version": cfg.PolicyVersion, "hash": cfg.PolicyHash, "status": "effective", "policy_source": policySourceName(cfg.PolicySource), "config_revision": cfg.ConfigRevision, "policy": FromSDK(cfg.Policy)}, nil
			}
			status, err := r.Backend.PolicyStatus(ctx, ws, a.Name, a.Rev)
			if err != nil {
				return nil, err
			}
			view := revisionView("sandbox", a.Name, status.Revision, status.ActiveVersion, true)
			if a.Rev == 0 {
				view["status"] = "effective"
			}
			return view, nil
		})})
	server.AddTool(mcp.Tool{Name: "set_policy", Title: "Replace policy", Description: "Replace the whole policy of a running sandbox with a JSON policy and wait for the sandbox to load it. Only network sections take effect on a running sandbox; filesystem, Landlock and process settings need a new sandbox.", InputSchema: mcp.Object(map[string]any{"name": nameSchema, "policy": map[string]any{"description": "policy as a JSON object (or a JSON string)"}, "wait": map[string]any{"type": "boolean", "default": true}, "timeout_seconds": map[string]any{"type": "integer"}, "workspace": workspaceSchema}, "name", "policy"),
		Handler: r.run("set_policy", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Name      string          `json:"name"`
				Policy    json.RawMessage `json:"policy"`
				Workspace string          `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			if err := validName(a.Name); err != nil {
				return nil, err
			}
			if err := s.policyChanges(); err != nil {
				return nil, err
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			if _, err := r.manageable(ctx, ws, a.Name); err != nil {
				return nil, err
			}
			doc, err := ParsePolicyDoc(a.Policy)
			if err != nil {
				return nil, err
			}
			policy, err := doc.ToSDK()
			if err != nil {
				return nil, err
			}
			result, err := r.Backend.SetPolicy(ctx, ws, a.Name, policy)
			if err != nil {
				return nil, err
			}
			return map[string]any{"name": a.Name, "version": result.Version, "hash": result.PolicyHash, "output": fmt.Sprintf("Policy revision %d loaded on %s", result.Version, a.Name), "waited": true}, nil
		})})
	server.AddTool(mcp.Tool{Name: "update_policy_rules", Title: "Update network rules", Description: "Incrementally add or remove network rules on a running sandbox. Endpoints use host:port[:access[:protocol[:enforcement]]], for example api.github.com:443:read-only:rest:enforce; allow/deny rules use host:port:METHOD:path and need rule_name and the complete binaries list (or any_binary). dry_run shows the operations without applying them.", InputSchema: mcp.Object(map[string]any{
		"name": nameSchema, "add_endpoints": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}, "remove_endpoints": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"add_allow": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}, "add_deny": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"remove_rules": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}, "binaries": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"rule_name": map[string]any{"type": "string"}, "any_binary": map[string]any{"type": "boolean"}, "dry_run": map[string]any{"type": "boolean"}, "wait": map[string]any{"type": "boolean"}, "timeout_seconds": map[string]any{"type": "integer"}, "workspace": workspaceSchema,
	}, "name"),
		Handler: r.run("update_policy_rules", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Name            string   `json:"name"`
				AddEndpoints    []string `json:"add_endpoints"`
				RemoveEndpoints []string `json:"remove_endpoints"`
				AddAllow        []string `json:"add_allow"`
				AddDeny         []string `json:"add_deny"`
				RemoveRules     []string `json:"remove_rules"`
				Binaries        []string `json:"binaries"`
				RuleName        string   `json:"rule_name"`
				AnyBinary       bool     `json:"any_binary"`
				DryRun          bool     `json:"dry_run"`
				Workspace       string   `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			if err := validName(a.Name); err != nil {
				return nil, err
			}
			if !a.DryRun {
				if err := s.policyChanges(); err != nil {
					return nil, err
				}
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			if _, err := r.manageable(ctx, ws, a.Name); err != nil {
				return nil, err
			}
			ops, described, err := r.mergeOperations(ctx, ws, a.Name, a.AddEndpoints, a.RemoveEndpoints, a.AddAllow, a.AddDeny, a.RemoveRules, a.Binaries, a.RuleName, a.AnyBinary)
			if err != nil {
				return nil, err
			}
			if len(ops) == 0 {
				return nil, errors.New("nothing to change: pass add_endpoints, remove_endpoints, add_allow, add_deny or remove_rules")
			}
			if a.DryRun {
				return map[string]any{"name": a.Name, "dry_run": true, "operations": described, "output": fmt.Sprintf("%d operation(s) would be applied", len(ops))}, nil
			}
			result, err := r.Backend.MergePolicy(ctx, ws, a.Name, ops)
			if err != nil {
				return nil, err
			}
			return map[string]any{"name": a.Name, "dry_run": false, "version": result.Version, "hash": result.PolicyHash, "operations": described, "output": fmt.Sprintf("Policy revision %d loaded on %s", result.Version, a.Name)}, nil
		})})
	server.AddTool(mcp.Tool{Name: "list_rule_proposals", Title: "Rule proposals", Description: "Network rules the policy advisor drafted from denied requests, with confidence, rationale and prover result. Pending ones wait for approval.", InputSchema: mcp.Object(map[string]any{"name": nameSchema, "status": map[string]any{"type": "string", "enum": []string{"pending", "approved", "rejected"}}, "workspace": workspaceSchema}, "name"),
		Handler: r.run("list_rule_proposals", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Name      string `json:"name"`
				Status    string `json:"status"`
				Workspace string `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			if err := validName(a.Name); err != nil {
				return nil, err
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			draft, err := r.Backend.Draft(ctx, ws, a.Name)
			if err != nil {
				return nil, err
			}
			out := []map[string]any{}
			for _, c := range draft.Chunks {
				if a.Status == "" || c.Status == a.Status {
					out = append(out, chunkView(c))
				}
			}
			return map[string]any{"name": a.Name, "proposals": out, "draft_version": draft.DraftVersion, "summary": draft.RollingSummary}, nil
		})})
	for _, decision := range []string{"approve", "reject"} {
		decision := decision
		props := map[string]any{"name": nameSchema, "chunk_id": map[string]any{"type": "string"}, "workspace": workspaceSchema}
		desc := "Approve a drafted network rule; it hot-reloads into the running sandbox."
		if decision == "reject" {
			props["reason"] = map[string]any{"type": "string"}
			desc = "Reject a drafted network rule with a reason the agent can read."
		}
		server.AddTool(mcp.Tool{Name: decision + "_rule", Title: strings.ToUpper(decision[:1]) + decision[1:] + " a rule proposal", Description: desc, InputSchema: mcp.Object(props, "chunk_id", "name"),
			Handler: r.run(decision+"_rule", func(ctx context.Context, raw json.RawMessage) (any, error) {
				var a struct {
					Name      string `json:"name"`
					ChunkID   string `json:"chunk_id"`
					Reason    string `json:"reason"`
					Workspace string `json:"workspace"`
				}
				if err := decode(raw, &a); err != nil {
					return nil, err
				}
				if err := validName(a.Name); err != nil {
					return nil, err
				}
				if a.ChunkID == "" {
					return nil, errors.New("chunk_id is required")
				}
				if err := s.policyChanges(); err != nil {
					return nil, err
				}
				ws, err := r.workspace(a.Workspace)
				if err != nil {
					return nil, err
				}
				if _, err := r.manageable(ctx, ws, a.Name); err != nil {
					return nil, err
				}
				if decision == "approve" {
					result, err := r.Backend.ApproveChunk(ctx, ws, a.Name, a.ChunkID)
					if err != nil {
						return nil, err
					}
					return map[string]any{"name": a.Name, "chunk_id": a.ChunkID, "version": result.PolicyVersion, "output": fmt.Sprintf("Approved rule chunk %s on %s (policy revision %d)", a.ChunkID, a.Name, result.PolicyVersion)}, nil
				}
				if err := r.Backend.RejectChunk(ctx, ws, a.Name, a.ChunkID, a.Reason); err != nil {
					return nil, err
				}
				return map[string]any{"name": a.Name, "chunk_id": a.ChunkID, "output": fmt.Sprintf("Rejected rule chunk %s on %s", a.ChunkID, a.Name)}, nil
			})})
	}
	server.AddTool(mcp.Tool{Name: "get_global_policy", Title: "Global policy", Description: "The gateway-global policy, when an administrator applied one. It overrides every sandbox policy; this edge never changes it.", InputSchema: mcp.Object(map[string]any{"view": map[string]any{"type": "string", "enum": []string{"base", "full"}}}),
		Handler: r.run("get_global_policy", func(ctx context.Context, _ json.RawMessage) (any, error) {
			status, err := r.Backend.GlobalPolicy(ctx)
			if err != nil {
				return nil, err
			}
			return revisionView("global", "", status.Revision, status.ActiveVersion, true), nil
		})})
	server.AddTool(mcp.Tool{Name: "launch_executor", Title: "Launch an executor sandbox", Description: "Create a sandbox that runs the OpenHarness connector under an OpenShell policy, so it appears in the inventory as a machine whose every command is kernel-confined. Needs the machine's device id and enrollment token; the policy allows only the harness gateway plus the listed hosts.", InputSchema: mcp.Object(map[string]any{
		"name": nameSchema, "device_id": nameSchema, "token": map[string]any{"type": "string"}, "gateway_url": map[string]any{"type": "string"}, "image": map[string]any{"type": "string"},
		"allowed_hosts": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "extra destinations as host:port[:access[:protocol[:enforcement]]]"}, "ca_pem": map[string]any{"type": "string"}, "workspace": workspaceSchema,
	}, "device_id", "token"),
		Handler: r.run("launch_executor", func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Name         string   `json:"name"`
				DeviceID     string   `json:"device_id"`
				Token        string   `json:"token"`
				GatewayURL   string   `json:"gateway_url"`
				Image        string   `json:"image"`
				AllowedHosts []string `json:"allowed_hosts"`
				CAPEM        string   `json:"ca_pem"`
				Workspace    string   `json:"workspace"`
			}
			if err := decode(raw, &a); err != nil {
				return nil, err
			}
			if a.Name == "" {
				a.Name = a.DeviceID
			}
			if err := validName(a.Name); err != nil {
				return nil, err
			}
			if err := validName(a.DeviceID); err != nil {
				return nil, fmt.Errorf("device_id: %w", err)
			}
			if err := s.lifecycle(); err != nil {
				return nil, err
			}
			ws, err := r.workspace(a.Workspace)
			if err != nil {
				return nil, err
			}
			if err := r.capacity(ctx, ws); err != nil {
				return nil, err
			}
			sandbox, policy, err := LaunchExecutor(ctx, r.Backend, *s, ExecutorRequest{Name: a.Name, DeviceID: a.DeviceID, Token: a.Token, GatewayURL: a.GatewayURL, Image: a.Image, AllowedHosts: a.AllowedHosts, Workspace: ws, CAPEM: a.CAPEM})
			if err != nil {
				return nil, err
			}
			summary := r.summarize(sandbox)
			return map[string]any{"sandbox": summary, "name": summary.Name, "device_id": a.DeviceID, "policy": FromSDK(policy), "output": fmt.Sprintf("Executor %s is %s; it registers as machine %s", summary.Name, summary.Phase, a.DeviceID)}, nil
		})})
}

func policySourceName(s v1.PolicySource) string {
	if s == v1.PolicySourceGlobal {
		return "global"
	}
	return "sandbox"
}

// capacity enforces MaxSandboxes over the sandboxes this edge created.
func (r *Registrar) capacity(ctx context.Context, workspace string) error {
	list, err := r.Backend.ListSandboxes(ctx, workspace, "openharness.device="+r.Settings.DeviceID)
	if err != nil {
		return err
	}
	if len(list) >= r.Settings.MaxSandboxes {
		return denied("the edge's sandbox limit (%d) is reached", r.Settings.MaxSandboxes)
	}
	return nil
}

// mergeOperations translates the CLI-style rule arguments into SDK merge operations.
func (r *Registrar) mergeOperations(ctx context.Context, ws, name string, addEndpoints, removeEndpoints, addAllow, addDeny, removeRules, binaries []string, ruleName string, anyBinary bool) ([]v1.PolicyMergeOperation, []map[string]any, error) {
	var ops []v1.PolicyMergeOperation
	var described []map[string]any
	bins := make([]v1.PolicyNetworkBinary, 0, len(binaries))
	for _, b := range binaries {
		if !strings.HasPrefix(b, "/") {
			return nil, nil, fmt.Errorf("binaries must be absolute paths: %s", b)
		}
		bins = append(bins, v1.PolicyNetworkBinary{Path: b})
	}
	for _, spec := range addEndpoints {
		ep, err := ParseEndpointSpec(spec)
		if err != nil {
			return nil, nil, err
		}
		rule := ruleName
		if rule == "" {
			rule = strings.NewReplacer(".", "_", "-", "_", "*", "any").Replace(ep.Host)
		}
		doc := RuleDoc{Name: rule, Endpoints: []EndpointDoc{ep}}
		converted, err := doc.toSDK(rule)
		if err != nil {
			return nil, nil, err
		}
		converted.Binaries = bins
		ops = append(ops, v1.PolicyMergeOperation{AddRule: &v1.AddNetworkRule{RuleName: rule, Rule: converted}})
		described = append(described, map[string]any{"add_rule": rule, "endpoint": spec, "binaries": binaries})
	}
	if len(removeEndpoints) > 0 {
		cfg, err := r.Backend.GetConfig(ctx, ws, name)
		if err != nil {
			return nil, nil, err
		}
		for _, spec := range removeEndpoints {
			host, portText, ok := strings.Cut(spec, ":")
			port, perr := strconv.Atoi(portText)
			if !ok || perr != nil {
				return nil, nil, fmt.Errorf("remove_endpoints entries must be host:port: %s", spec)
			}
			found := false
			if cfg.Policy != nil {
				for rname, rule := range cfg.Policy.NetworkPolicies {
					for _, ep := range rule.Endpoints {
						if ep.Host == host && int(ep.Port) == port {
							ops = append(ops, v1.PolicyMergeOperation{RemoveEndpoint: &v1.RemoveNetworkEndpoint{RuleName: rname, Host: host, Port: uint32(port)}})
							described = append(described, map[string]any{"remove_endpoint": spec, "rule": rname})
							found = true
						}
					}
				}
			}
			if !found {
				return nil, nil, fmt.Errorf("no rule lists endpoint %s", spec)
			}
		}
	}
	for _, rule := range removeRules {
		ops = append(ops, v1.PolicyMergeOperation{RemoveRule: &v1.RemoveNetworkRule{RuleName: rule}})
		described = append(described, map[string]any{"remove_rule": rule})
	}
	if len(addAllow)+len(addDeny) > 0 {
		if ruleName == "" || (len(bins) == 0 && !anyBinary) {
			return nil, nil, errors.New("add_allow and add_deny need rule_name and the complete binaries list (or any_binary)")
		}
		parse := func(spec string) (host string, ports []uint32, method, path string, err error) {
			parts := strings.SplitN(spec, ":", 4)
			if len(parts) != 4 {
				return "", nil, "", "", fmt.Errorf("rules must look like host:port[,port]:METHOD:path: %s", spec)
			}
			for _, p := range strings.Split(parts[1], ",") {
				n, err := strconv.Atoi(p)
				if err != nil {
					return "", nil, "", "", fmt.Errorf("invalid port in %s", spec)
				}
				ports = append(ports, uint32(n))
			}
			return parts[0], ports, parts[2], parts[3], nil
		}
		for _, spec := range addAllow {
			host, ports, method, path, err := parse(spec)
			if err != nil {
				return nil, nil, err
			}
			ops = append(ops, v1.PolicyMergeOperation{AddAllowRules: &v1.AddAllowRules{Target: &v1.L7RuleTarget{RuleName: ruleName, Host: host, Ports: ports, Binaries: bins, AnyBinary: anyBinary}, Rules: []v1.L7Rule{{Allow: &v1.L7Allow{Method: method, Path: path}}}}})
			described = append(described, map[string]any{"add_allow": spec, "rule": ruleName})
		}
		for _, spec := range addDeny {
			host, ports, method, path, err := parse(spec)
			if err != nil {
				return nil, nil, err
			}
			ops = append(ops, v1.PolicyMergeOperation{AddDenyRules: &v1.AddDenyRules{Target: &v1.L7RuleTarget{RuleName: ruleName, Host: host, Ports: ports, Binaries: bins, AnyBinary: anyBinary}, DenyRules: []v1.L7DenyRule{{Method: method, Path: path}}}})
			described = append(described, map[string]any{"add_deny": spec, "rule": ruleName})
		}
	}
	return ops, described, nil
}
