package edge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
	"github.com/NVIDIA/OpenShell/sdk/go/openshell/v1/types"
)

// MemBackend is an in-memory OpenShell stand-in for tests and the isolated test stack. It keeps sandboxes,
// policy revisions, logs and advisor drafts, and emulates what a sandbox policy does to `curl` and file writes so
// the rest of the system can be exercised without a kernel-confined sandbox.
type MemBackend struct {
	mu        sync.Mutex
	seq       int
	sandboxes map[string]*memSandbox // key workspace/name
	// Launched receives the create specs of launched sandboxes, so tests can inspect executor launches.
	Launched []CreateSpec
}

type memSandbox struct {
	sandbox   v1.Sandbox
	spec      CreateSpec
	policy    *v1.SandboxPolicy
	revisions []v1.SandboxPolicyRevision
	logs      []v1.LogLine
	chunks    []v1.PolicyChunk
}

// NewMemBackend starts empty, with a `default` workspace.
func NewMemBackend() *MemBackend { return &MemBackend{sandboxes: map[string]*memSandbox{}} }

func key(workspace, name string) string { return workspace + "/" + name }
func notFound(what string) error {
	return &types.StatusError{Code: types.ErrorNotFound, Message: what + " not found"}
}
func policyHash(p *v1.SandboxPolicy) string {
	data, _ := json.Marshal(FromSDK(p))
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (m *MemBackend) get(workspace, name string) (*memSandbox, error) {
	if workspace != "default" {
		return nil, &types.StatusError{Code: types.ErrorNotFound, Message: fmt.Sprintf("workspace %q not found", workspace)}
	}
	s, ok := m.sandboxes[key(workspace, name)]
	if !ok {
		return nil, notFound("sandbox " + name)
	}
	return s, nil
}
func (m *MemBackend) log(s *memSandbox, level, message string, fields map[string]string) {
	s.logs = append(s.logs, v1.LogLine{Timestamp: time.Now(), Level: level, Target: "supervisor", Message: message, Source: "sandbox", Fields: fields})
}
func (m *MemBackend) addRevision(s *memSandbox, policy *v1.SandboxPolicy, provenance string) v1.SandboxPolicyRevision {
	version := uint32(len(s.revisions) + 1)
	rev := v1.SandboxPolicyRevision{Version: version, PolicyHash: policyHash(policy), Status: v1.PolicyLoadStatusLoaded, CreatedAt: time.Now(), LoadedAt: time.Now(), Policy: policy, Provenance: map[string]string{"source": provenance}}
	for i := range s.revisions {
		if s.revisions[i].Status == v1.PolicyLoadStatusLoaded {
			s.revisions[i].Status = v1.PolicyLoadStatusSuperseded
		}
	}
	s.revisions = append(s.revisions, rev)
	s.policy = policy
	s.sandbox.Status.CurrentPolicyVersion = version
	m.log(s, "INFO", fmt.Sprintf("policy revision %d loaded", version), map[string]string{"hash": rev.PolicyHash[:12]})
	return rev
}

func (m *MemBackend) Status(context.Context) (*Status, error) {
	return &Status{Healthy: true, Version: "0.1.2", Info: &v1.GatewayInfo{Status: types.ServiceStatusHealthy, Version: "0.1.2", ComputeDrivers: []v1.ComputeDriverInfo{{Name: "docker", DriverName: "docker", DriverVersion: "0.1.2"}}}}, nil
}
func (m *MemBackend) Workspaces(context.Context) ([]*v1.Workspace, error) {
	return []*v1.Workspace{{ID: "ws-1", Name: "default", CreatedAt: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}}, nil
}
func (m *MemBackend) ListSandboxes(_ context.Context, workspace, selector string) ([]*v1.Sandbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if workspace != "default" {
		return nil, &types.StatusError{Code: types.ErrorNotFound, Message: fmt.Sprintf("workspace %q not found", workspace)}
	}
	want := map[string]string{}
	for _, part := range strings.Split(selector, ",") {
		if k, v, ok := strings.Cut(strings.TrimSpace(part), "="); ok {
			want[k] = v
		}
	}
	var out []*v1.Sandbox
	for _, s := range m.sandboxes {
		matches := true
		for k, v := range want {
			if s.sandbox.Labels[k] != v {
				matches = false
			}
		}
		if matches {
			copy := s.sandbox
			out = append(out, &copy)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}
func (m *MemBackend) GetSandbox(_ context.Context, workspace, name string) (*v1.Sandbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	copy := s.sandbox
	return &copy, nil
}
func (m *MemBackend) GetConfig(_ context.Context, workspace, name string) (*v1.SandboxConfig, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	return &v1.SandboxConfig{Policy: s.policy, PolicyVersion: s.sandbox.Status.CurrentPolicyVersion, PolicyHash: policyHash(s.policy), PolicySource: v1.PolicySourceSandbox, ConfigRevision: uint64(len(s.revisions))}, nil
}
func (m *MemBackend) CreateSandbox(_ context.Context, workspace, name string, spec CreateSpec) (*v1.Sandbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if workspace != "default" {
		return nil, &types.StatusError{Code: types.ErrorNotFound, Message: fmt.Sprintf("workspace %q not found", workspace)}
	}
	if _, exists := m.sandboxes[key(workspace, name)]; exists {
		return nil, &types.StatusError{Code: types.ErrorAlreadyExists, Message: fmt.Sprintf("sandbox %q already exists", name)}
	}
	if strings.Contains(spec.Image, "forbidden") {
		return nil, &types.StatusError{Code: types.ErrorPermissionDenied, Message: "failed to pull image " + spec.Image + ": access denied"}
	}
	m.seq++
	policy := spec.Policy
	if policy == nil {
		policy = &v1.SandboxPolicy{Version: 1, Filesystem: &v1.FilesystemPolicy{IncludeWorkdir: true}, NetworkPolicies: map[string]v1.NetworkPolicyRule{}}
	}
	labels := map[string]string{}
	for k, v := range spec.Labels {
		labels[k] = v
	}
	s := &memSandbox{
		sandbox: v1.Sandbox{ID: fmt.Sprintf("sb-%d", m.seq), Name: name, Workspace: workspace, CreatedAt: time.Now(), Labels: labels, ResourceVersion: 1,
			Spec:   v1.SandboxSpec{Environment: spec.Environment, Template: &v1.SandboxTemplate{Image: spec.Image}, Command: spec.Command, Providers: spec.Providers},
			Status: v1.SandboxStatus{Phase: types.SandboxReady, Conditions: []v1.SandboxCondition{{Type: "Ready", Status: "True", Reason: "Running"}}}},
		spec: spec,
	}
	m.log(s, "INFO", "sandbox started", map[string]string{"image": spec.Image})
	m.addRevision(s, policy, "create")
	m.sandboxes[key(workspace, name)] = s
	m.Launched = append(m.Launched, spec)
	copy := s.sandbox
	return &copy, nil
}
func (m *MemBackend) WaitReady(ctx context.Context, workspace, name string) (*v1.Sandbox, error) {
	return m.GetSandbox(ctx, workspace, name)
}
func (m *MemBackend) DeleteSandbox(_ context.Context, workspace, name string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.get(workspace, name); err != nil {
		return "", err
	}
	delete(m.sandboxes, key(workspace, name))
	return "completed", nil
}
func (m *MemBackend) setPhase(workspace, name string, phase types.SandboxPhase) (*v1.Sandbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	s.sandbox.Status.Phase = phase
	m.log(s, "INFO", "sandbox "+strings.ToLower(string(phase)), nil)
	copy := s.sandbox
	return &copy, nil
}
func (m *MemBackend) StartSandbox(_ context.Context, workspace, name string) (*v1.Sandbox, error) {
	return m.setPhase(workspace, name, types.SandboxReady)
}
func (m *MemBackend) StopSandbox(_ context.Context, workspace, name string) (*v1.Sandbox, error) {
	return m.setPhase(workspace, name, types.SandboxStopped)
}

func hostAllowed(policy *v1.SandboxPolicy, host string) bool {
	for _, rule := range policy.NetworkPolicies {
		for _, ep := range rule.Endpoints {
			if ep.Host == host || (strings.HasPrefix(ep.Host, "*.") && strings.HasSuffix(host, ep.Host[1:])) {
				return true
			}
		}
	}
	return false
}

// Exec emulates a few programs and the sandbox policy's answer to them.
func (m *MemBackend) Exec(_ context.Context, workspace, name string, argv []string, opts ExecOptions) (*ExecResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	if s.sandbox.Status.Phase != types.SandboxReady {
		return nil, &types.StatusError{Code: types.ErrorInvalidArgument, Message: fmt.Sprintf("sandbox %q is %s; start it first", name, s.sandbox.Status.Phase)}
	}
	if len(argv) == 0 {
		return nil, &types.StatusError{Code: types.ErrorInvalidArgument, Message: "a command is required"}
	}
	m.log(s, "INFO", "exec", map[string]string{"argv": strings.Join(argv, " ")})
	workdir := opts.WorkDir
	if workdir == "" {
		workdir = "/sandbox"
	}
	switch argv[0] {
	case "echo":
		return &ExecResult{Stdout: strings.Join(argv[1:], " ") + "\n"}, nil
	case "true":
		return &ExecResult{}, nil
	case "false":
		return &ExecResult{ExitCode: 1}, nil
	case "pwd":
		return &ExecResult{Stdout: workdir + "\n"}, nil
	case "uname":
		return &ExecResult{Stdout: "Linux " + name + " 6.8.0-openshell #1 SMP x86_64 GNU/Linux\n"}, nil
	case "printenv":
		if len(argv) > 1 {
			if v, ok := opts.Env[argv[1]]; ok {
				return &ExecResult{Stdout: v + "\n"}, nil
			}
			if v, ok := s.spec.Environment[argv[1]]; ok {
				return &ExecResult{Stdout: v + "\n"}, nil
			}
			return &ExecResult{ExitCode: 1}, nil
		}
		return &ExecResult{Stdout: "PATH=/usr/bin\n"}, nil
	case "touch":
		path := ""
		if len(argv) > 1 {
			path = argv[1]
		}
		if strings.HasPrefix(path, "/sandbox") || strings.HasPrefix(path, "/tmp") {
			return &ExecResult{}, nil
		}
		m.log(s, "WARN", "policy_denied", map[string]string{"kind": "filesystem", "op": "write", "path": path, "enforcement": "landlock"})
		return &ExecResult{ExitCode: 1, Stderr: fmt.Sprintf("touch: cannot touch '%s': Operation not permitted\n", path)}, nil
	case "curl":
		var target string
		for _, a := range argv[1:] {
			if strings.HasPrefix(a, "http://") || strings.HasPrefix(a, "https://") {
				target = a
			}
		}
		if target == "" {
			return &ExecResult{ExitCode: 2, Stderr: "curl: no URL specified\n"}, nil
		}
		u, err := url.Parse(target)
		if err != nil {
			return &ExecResult{ExitCode: 3, Stderr: "curl: bad URL\n"}, nil
		}
		host := u.Hostname()
		if hostAllowed(s.policy, host) {
			m.log(s, "INFO", "request_allowed", map[string]string{"dest": host + ":443", "binary": "/usr/bin/curl", "method": "GET"})
			return &ExecResult{Stdout: fmt.Sprintf("HTTP/1.1 200 OK\n{\"ok\":true,\"host\":%q}\n", host)}, nil
		}
		m.log(s, "WARN", "policy_denied", map[string]string{"dest": host + ":443", "binary": "/usr/bin/curl", "method": "GET", "path": "/", "reason": "no_matching_rule"})
		found := false
		for i := range s.chunks {
			if s.chunks[i].Status == "pending" && s.chunks[i].ProposedRule != nil && s.chunks[i].ProposedRule.Endpoints[0].Host == host {
				s.chunks[i].HitCount++
				s.chunks[i].LastSeen = time.Now()
				found = true
			}
		}
		if !found {
			m.seq++
			ruleName := strings.NewReplacer(".", "_", "-", "_").Replace(host)
			s.chunks = append(s.chunks, v1.PolicyChunk{
				ID: fmt.Sprintf("chunk-%d", m.seq), Status: "pending", RuleName: ruleName, Binary: "/usr/bin/curl", Confidence: 0.92, HitCount: 1,
				Rationale: fmt.Sprintf("curl attempted %s:443 and was denied", host), CreatedAt: time.Now(), FirstSeen: time.Now(), LastSeen: time.Now(), Stage: "initial",
				ValidationResult: "no new findings", ReviewToken: "review-" + fmt.Sprint(m.seq),
				ProposedRule: &v1.NetworkPolicyRule{Name: ruleName, Endpoints: []v1.PolicyNetworkEndpoint{{Host: host, Port: 443, Protocol: "rest", Access: v1.NetworkAccessPresetReadOnly, Enforcement: v1.NetworkEnforcementModeEnforce}}, Binaries: []v1.PolicyNetworkBinary{{Path: "/usr/bin/curl"}}},
			})
		}
		return &ExecResult{ExitCode: 7, Stderr: fmt.Sprintf("curl: (7) policy_denied: connection to %s:443 was blocked by the sandbox policy\n", host)}, nil
	case "sleep":
		return &ExecResult{}, nil
	}
	return &ExecResult{ExitCode: 127, Stderr: fmt.Sprintf("sh: 1: %s: not found\n", argv[0])}, nil
}
func (m *MemBackend) Logs(_ context.Context, workspace, name string, opts LogOptions) ([]v1.LogLine, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	var out []v1.LogLine
	for _, line := range s.logs {
		if opts.Since > 0 && time.Since(line.Timestamp) > opts.Since {
			continue
		}
		if len(opts.Sources) > 0 && !containsString(opts.Sources, line.Source) && !containsString(opts.Sources, "all") {
			continue
		}
		out = append(out, line)
	}
	if opts.Lines > 0 && len(out) > opts.Lines {
		out = out[len(out)-opts.Lines:]
	}
	return out, nil
}
func (m *MemBackend) PolicyRevisions(_ context.Context, workspace, name string) ([]v1.SandboxPolicyRevision, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	out := make([]v1.SandboxPolicyRevision, len(s.revisions))
	for i, r := range s.revisions {
		r.Policy = nil
		out[i] = r
	}
	return out, nil
}
func (m *MemBackend) PolicyStatus(_ context.Context, workspace, name string, version uint32) (*v1.PolicyStatusResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	if version == 0 {
		version = uint32(len(s.revisions))
	}
	if version == 0 || int(version) > len(s.revisions) {
		return nil, notFound(fmt.Sprintf("policy revision %d", version))
	}
	return &v1.PolicyStatusResult{Revision: s.revisions[version-1], ActiveVersion: s.sandbox.Status.CurrentPolicyVersion}, nil
}
func (m *MemBackend) GlobalPolicy(context.Context) (*v1.PolicyStatusResult, error) {
	return nil, notFound("global policy")
}
func (m *MemBackend) SetPolicy(_ context.Context, workspace, name string, policy *v1.SandboxPolicy) (*v1.ConfigUpdateResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	if _, bad := policy.NetworkPolicies["reject_on_load"]; bad {
		version := uint32(len(s.revisions) + 1)
		s.revisions = append(s.revisions, v1.SandboxPolicyRevision{Version: version, PolicyHash: policyHash(policy), Status: v1.PolicyLoadStatusFailed, LoadError: "sandbox rejected revision: binary /usr/bin/none does not exist", CreatedAt: time.Now()})
		return nil, &types.StatusError{Code: types.ErrorInvalidArgument, Message: fmt.Sprintf("revision %d failed to load: binary /usr/bin/none does not exist", version)}
	}
	rev := m.addRevision(s, policy, "console")
	return &v1.ConfigUpdateResult{Version: rev.Version, PolicyHash: rev.PolicyHash}, nil
}
func (m *MemBackend) MergePolicy(_ context.Context, workspace, name string, ops []v1.PolicyMergeOperation) (*v1.ConfigUpdateResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	next := FromSDK(s.policy)
	for _, op := range ops {
		switch {
		case op.AddRule != nil:
			rule := op.AddRule.Rule
			existing, ok := next.NetworkPolicies[op.AddRule.RuleName]
			converted := FromSDK(&v1.SandboxPolicy{NetworkPolicies: map[string]v1.NetworkPolicyRule{op.AddRule.RuleName: rule}}).NetworkPolicies[op.AddRule.RuleName]
			if ok {
				existing.Endpoints = append(existing.Endpoints, converted.Endpoints...)
				if len(converted.Binaries) > 0 {
					existing.Binaries = converted.Binaries
				}
				next.NetworkPolicies[op.AddRule.RuleName] = existing
			} else {
				next.NetworkPolicies[op.AddRule.RuleName] = converted
			}
		case op.RemoveRule != nil:
			if _, ok := next.NetworkPolicies[op.RemoveRule.RuleName]; !ok {
				return nil, notFound("rule " + op.RemoveRule.RuleName)
			}
			delete(next.NetworkPolicies, op.RemoveRule.RuleName)
		case op.RemoveEndpoint != nil:
			rule, ok := next.NetworkPolicies[op.RemoveEndpoint.RuleName]
			if !ok {
				return nil, notFound("rule " + op.RemoveEndpoint.RuleName)
			}
			kept := rule.Endpoints[:0]
			for _, ep := range rule.Endpoints {
				if !(ep.Host == op.RemoveEndpoint.Host && ep.Port == op.RemoveEndpoint.Port) {
					kept = append(kept, ep)
				}
			}
			rule.Endpoints = kept
			if len(kept) == 0 {
				delete(next.NetworkPolicies, op.RemoveEndpoint.RuleName)
			} else {
				next.NetworkPolicies[op.RemoveEndpoint.RuleName] = rule
			}
		case op.AddAllowRules != nil, op.AddDenyRules != nil:
			target := op.AddAllowRules
			var deny *v1.AddDenyRules
			if target == nil {
				deny = op.AddDenyRules
			}
			var t *v1.L7RuleTarget
			if target != nil {
				t = target.Target
			} else {
				t = deny.Target
			}
			rule, ok := next.NetworkPolicies[t.RuleName]
			if !ok {
				return nil, notFound("rule " + t.RuleName)
			}
			for i := range rule.Endpoints {
				if rule.Endpoints[i].Host == t.Host {
					if target != nil {
						for _, r := range target.Rules {
							if r.Allow != nil {
								rule.Endpoints[i].Rules = append(rule.Endpoints[i].Rules, AllowDoc{Allow: MatchDoc{Method: r.Allow.Method, Path: r.Allow.Path}})
							}
						}
					} else {
						for _, d := range deny.DenyRules {
							rule.Endpoints[i].DenyRules = append(rule.Endpoints[i].DenyRules, MatchDoc{Method: d.Method, Path: d.Path})
						}
					}
				}
			}
			next.NetworkPolicies[t.RuleName] = rule
		}
	}
	policy, err := next.ToSDK()
	if err != nil {
		return nil, err
	}
	rev := m.addRevision(s, policy, "merge")
	return &v1.ConfigUpdateResult{Version: rev.Version, PolicyHash: rev.PolicyHash}, nil
}
func (m *MemBackend) Draft(_ context.Context, workspace, name string) (*v1.DraftPolicy, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	return &v1.DraftPolicy{Chunks: append([]v1.PolicyChunk{}, s.chunks...), DraftVersion: uint64(len(s.chunks))}, nil
}
func (m *MemBackend) ApproveChunk(_ context.Context, workspace, name, chunkID string) (*v1.ApproveResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return nil, err
	}
	for i := range s.chunks {
		if s.chunks[i].ID == chunkID {
			if s.chunks[i].Status != "pending" {
				return nil, &types.StatusError{Code: types.ErrorInvalidArgument, Message: "draft chunk is already " + s.chunks[i].Status}
			}
			s.chunks[i].Status = "approved"
			s.chunks[i].DecidedAt = time.Now()
			next := FromSDK(s.policy)
			converted := FromSDK(&v1.SandboxPolicy{NetworkPolicies: map[string]v1.NetworkPolicyRule{s.chunks[i].RuleName: *s.chunks[i].ProposedRule}}).NetworkPolicies[s.chunks[i].RuleName]
			for e := range converted.Endpoints {
				converted.Endpoints[e].Provenance = &Provenance{AdvisorProposed: true}
			}
			next.NetworkPolicies[s.chunks[i].RuleName] = converted
			policy, err := next.ToSDK()
			if err != nil {
				return nil, err
			}
			rev := m.addRevision(s, policy, "advisor:"+chunkID)
			return &v1.ApproveResult{PolicyVersion: rev.Version, PolicyHash: rev.PolicyHash}, nil
		}
	}
	return nil, notFound("draft chunk " + chunkID)
}
func (m *MemBackend) RejectChunk(_ context.Context, workspace, name, chunkID, reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.get(workspace, name)
	if err != nil {
		return err
	}
	for i := range s.chunks {
		if s.chunks[i].ID == chunkID {
			s.chunks[i].Status = "rejected"
			s.chunks[i].RejectionReason = reason
			s.chunks[i].DecidedAt = time.Now()
			return nil
		}
	}
	return notFound("draft chunk " + chunkID)
}

func containsString(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}
