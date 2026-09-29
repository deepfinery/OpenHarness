package edge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/deepfinery/OpenHarness/connector-go/internal/audit"
	"github.com/deepfinery/OpenHarness/connector-go/internal/mcp"
)

type memWriter struct{ out chan []byte }

func (w *memWriter) Write(_ context.Context, m []byte) error { w.out <- m; return nil }

type harness struct {
	t       *testing.T
	server  *mcp.Server
	w       *memWriter
	backend *MemBackend
}

func setup(t *testing.T, mutate func(*Settings)) *harness {
	backend := NewMemBackend()
	settings := DefaultSettings()
	settings.DeviceID = "os-edge"
	settings.Version = "test"
	settings.ExecutorImage = "openharness-connector:test"
	settings.ExecutorGatewayURL = "wss://harness.example.com:8443/connect"
	settings.ExecutorGatewayCAPEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
	if mutate != nil {
		mutate(&settings)
	}
	log, _ := audit.Open("")
	server := mcp.NewServer("edge-test", "0")
	(&Registrar{Backend: backend, Settings: settings, Audit: log}).Register(server)
	return &harness{t: t, server: server, w: &memWriter{out: make(chan []byte, 16)}, backend: backend}
}

func (h *harness) call(name string, args map[string]any) (map[string]any, string, bool) {
	raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
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
		text := ""
		if len(m.Result.Content) > 0 {
			text = m.Result.Content[0].Text
		}
		return m.Result.StructuredContent, text, m.Result.IsError
	case <-time.After(5 * time.Second):
		h.t.Fatal("no reply")
		return nil, "", false
	}
}

func TestToolSurfaceAndPolicyWorkflow(t *testing.T) {
	h := setup(t, nil)
	if got := strings.Join(h.server.ToolNames(), ","); got != strings.Join(ToolNames, ",") {
		t.Fatalf("tool order: %s", got)
	}
	status, _, isError := h.call("openshell_status", nil)
	if isError || status["status"].(map[string]any)["status"] != "connected" || status["gateway_info"].(map[string]any)["version"] != "0.1.2" {
		t.Fatalf("status: %v", status)
	}
	if ws, _, _ := h.call("list_workspaces", nil); ws["workspaces"].([]any)[0].(map[string]any)["name"] != "default" {
		t.Fatalf("workspaces: %v", ws)
	}
	policy := map[string]any{"version": 1, "landlock": map[string]any{"compatibility": "hard_requirement"}, "process": map[string]any{"run_as_user": "1000"}, "network_policies": map[string]any{"pypi": map[string]any{"endpoints": []map[string]any{{"host": "pypi.org", "port": 443, "protocol": "rest", "access": "read-only", "enforcement": "enforce"}}, "binaries": []map[string]any{{"path": "/usr/bin/curl"}}}}}
	created, text, isError := h.call("create_sandbox", map[string]any{"name": "agent-one", "image": "registry.example.com/agents/worker:1.0", "policy": policy, "labels": map[string]string{"team": "platform"}, "command": []string{"./worker"}})
	if isError {
		t.Fatalf("create: %s", text)
	}
	if created["managed"] != true || created["labels"].(map[string]any)["openharness.device"] != "os-edge" || created["labels"].(map[string]any)["team"] != "platform" {
		t.Fatalf("created: %v", created)
	}
	if spec := h.backend.Launched[0]; spec.Command[0] != "./worker" || spec.Policy.Landlock.Compatibility != "hard_requirement" || spec.Policy.Process.RunAsUser != "1000" {
		t.Fatalf("spec not forwarded: %+v", spec)
	}
	listed, _, _ := h.call("list_sandboxes", nil)
	if sandboxes := listed["sandboxes"].([]any); len(sandboxes) != 1 || sandboxes[0].(map[string]any)["phase"] != "Ready" {
		t.Fatalf("list: %v", listed)
	}
	detail, _, _ := h.call("get_sandbox", map[string]any{"name": "agent-one"})
	if detail["policy"].(map[string]any)["network_policies"].(map[string]any)["pypi"] == nil || detail["policy_source"] != "sandbox" {
		t.Fatalf("detail: %v", detail)
	}
	if r, _, _ := h.call("exec_in_sandbox", map[string]any{"name": "agent-one", "argv": []string{"echo", "hello", "sandbox"}}); r["exit_code"].(float64) != 0 || strings.TrimSpace(r["stdout"].(string)) != "hello sandbox" {
		t.Fatalf("echo: %v", r)
	}
	if r, _, _ := h.call("exec_in_sandbox", map[string]any{"name": "agent-one", "argv": []string{"curl", "-s", "https://pypi.org/simple/"}}); r["exit_code"].(float64) != 0 {
		t.Fatalf("allowed curl: %v", r)
	}
	denied, _, _ := h.call("exec_in_sandbox", map[string]any{"name": "agent-one", "argv": []string{"curl", "https://api.github.com/repos"}})
	if denied["exit_code"].(float64) != 7 || denied["policy_denied"] != true {
		t.Fatalf("denied curl: %v", denied)
	}
	if events, _ := denied["denials"].([]any); len(events) != 1 || !strings.Contains(events[0].(string), "dest=api.github.com:443") {
		t.Fatalf("denial events should name the refused destination: %v", denied["denials"])
	}
	if fs, _, _ := h.call("exec_in_sandbox", map[string]any{"name": "agent-one", "argv": []string{"touch", "/etc/passwd"}}); fs["policy_denied"] != true {
		t.Fatalf("filesystem denial: %v", fs)
	}
	logs, _, _ := h.call("sandbox_logs", map[string]any{"name": "agent-one", "since": "10m", "source": "sandbox"})
	if !strings.Contains(logs["text"].(string), "policy_denied") || !strings.Contains(logs["text"].(string), "dest=api.github.com:443") {
		t.Fatalf("logs: %v", logs["text"])
	}
	proposals, _, _ := h.call("list_rule_proposals", map[string]any{"name": "agent-one", "status": "pending"})
	chunks := proposals["proposals"].([]any)
	if len(chunks) != 1 || chunks[0].(map[string]any)["endpoints"] != "api.github.com:443" || chunks[0].(map[string]any)["confidence"].(float64) != 92 {
		t.Fatalf("proposals: %v", proposals)
	}
	if _, text, isError := h.call("approve_rule", map[string]any{"name": "agent-one", "chunk_id": chunks[0].(map[string]any)["id"]}); isError {
		t.Fatalf("approve: %s", text)
	}
	if r, _, _ := h.call("exec_in_sandbox", map[string]any{"name": "agent-one", "argv": []string{"curl", "https://api.github.com/repos"}}); r["exit_code"].(float64) != 0 {
		t.Fatalf("approved rule did not take effect: %v", r)
	}
	if p, _, _ := h.call("list_rule_proposals", map[string]any{"name": "agent-one", "status": "pending"}); len(p["proposals"].([]any)) != 0 {
		t.Fatal("approved proposal still pending")
	}
	revisions, _, _ := h.call("list_policy_revisions", map[string]any{"name": "agent-one"})
	if len(revisions["revisions"].([]any)) != 2 {
		t.Fatalf("revisions: %v", revisions)
	}
	base, _, _ := h.call("get_policy", map[string]any{"name": "agent-one"})
	if base["status"] != "effective" || base["policy"].(map[string]any)["network_policies"].(map[string]any)["api_github_com"] == nil {
		t.Fatalf("base policy: %v", base)
	}
	if first, _, _ := h.call("get_policy", map[string]any{"name": "agent-one", "rev": 1}); first["version"].(float64) != 1 || first["status"] != "superseded" {
		t.Fatalf("revision 1: %v", first)
	}
	if full, _, _ := h.call("get_policy", map[string]any{"name": "agent-one", "view": "full"}); full["policy_source"] != "sandbox" {
		t.Fatalf("full policy: %v", full)
	}
	replaced, text, isError := h.call("set_policy", map[string]any{"name": "agent-one", "policy": map[string]any{"version": 1, "network_policies": map[string]any{}}})
	if isError || replaced["version"].(float64) != 3 {
		t.Fatalf("set_policy: %v %s", replaced, text)
	}
	if _, text, isError := h.call("set_policy", map[string]any{"name": "agent-one", "policy": "version: 1\nnetwork_policies: {}"}); !isError || !strings.Contains(text, "JSON object") {
		t.Fatalf("YAML is refused with a clear message: %s", text)
	}
	if _, text, isError := h.call("set_policy", map[string]any{"name": "agent-one", "policy": map[string]any{"version": 1, "network_policies": map[string]any{"reject_on_load": map[string]any{"endpoints": []any{}, "binaries": []any{}}}}}); !isError || !strings.Contains(text, "failed to load") {
		t.Fatalf("a rejected revision is reported: %s", text)
	}
	dry, _, _ := h.call("update_policy_rules", map[string]any{"name": "agent-one", "add_endpoints": []string{"api.openai.com:443:read-write:rest:enforce"}, "binaries": []string{"/usr/bin/python3"}, "rule_name": "openai", "dry_run": true})
	if dry["dry_run"] != true || len(dry["operations"].([]any)) != 1 {
		t.Fatalf("dry run: %v", dry)
	}
	before := len(func() []any {
		r, _, _ := h.call("list_policy_revisions", map[string]any{"name": "agent-one"})
		return r["revisions"].([]any)
	}())
	updated, text, isError := h.call("update_policy_rules", map[string]any{"name": "agent-one", "add_endpoints": []string{"api.openai.com:443:read-write:rest:enforce"}, "binaries": []string{"/usr/bin/python3"}, "rule_name": "openai"})
	if isError {
		t.Fatalf("update: %s", text)
	}
	after := len(func() []any {
		r, _, _ := h.call("list_policy_revisions", map[string]any{"name": "agent-one"})
		return r["revisions"].([]any)
	}())
	if after != before+1 || updated["version"].(float64) != float64(after) {
		t.Fatalf("update did not add a revision: %v", updated)
	}
	if p, _, _ := h.call("get_policy", map[string]any{"name": "agent-one"}); p["policy"].(map[string]any)["network_policies"].(map[string]any)["openai"].(map[string]any)["binaries"].([]any)[0].(map[string]any)["path"] != "/usr/bin/python3" {
		t.Fatalf("binaries not applied: %v", p)
	}
	if _, text, isError := h.call("update_policy_rules", map[string]any{"name": "agent-one", "add_allow": []string{"api.openai.com:443:POST:/v1/*"}}); !isError || !strings.Contains(text, "rule_name") {
		t.Fatalf("allow rules need a scope: %s", text)
	}
	if _, _, isError := h.call("update_policy_rules", map[string]any{"name": "agent-one", "add_allow": []string{"api.openai.com:443:POST:/v1/*"}, "rule_name": "openai", "binaries": []string{"/usr/bin/python3"}}); isError {
		t.Fatal("scoped allow rule")
	}
	if _, _, isError := h.call("update_policy_rules", map[string]any{"name": "agent-one", "remove_endpoints": []string{"api.openai.com:443"}}); isError {
		t.Fatal("remove endpoint")
	}
	if p, _, _ := h.call("get_policy", map[string]any{"name": "agent-one"}); p["policy"].(map[string]any)["network_policies"].(map[string]any)["openai"] != nil {
		t.Fatal("removing the only endpoint removes the rule")
	}
	if r, _, _ := h.call("stop_sandbox", map[string]any{"name": "agent-one"}); r["output"] != "Stopped" {
		t.Fatalf("stop: %v", r)
	}
	if _, _, isError := h.call("exec_in_sandbox", map[string]any{"name": "agent-one", "argv": []string{"echo", "x"}}); !isError {
		t.Fatal("exec on a stopped sandbox is an error")
	}
	h.call("start_sandbox", map[string]any{"name": "agent-one"})
	if _, text, isError := h.call("get_global_policy", nil); !isError || !strings.Contains(text, "not found") {
		t.Fatalf("no global policy: %s", text)
	}
	if _, text, isError := h.call("get_sandbox", map[string]any{"name": "nope"}); !isError || !strings.Contains(text, "not found") {
		t.Fatalf("missing sandbox: %s", text)
	}
	if _, text, isError := h.call("get_sandbox", map[string]any{"name": "Bad Name"}); !isError || !strings.Contains(text, "lowercase") {
		t.Fatalf("names are validated before any call: %s", text)
	}
	if r, _, _ := h.call("delete_sandbox", map[string]any{"name": "agent-one"}); r["output"] != "completed" {
		t.Fatalf("delete: %v", r)
	}
}

func TestExecutorLaunchBuildsAConfinedSandbox(t *testing.T) {
	h := setup(t, func(s *Settings) { s.ExecutorAllowedHosts = []string{"pypi.org:443"} })
	launched, text, isError := h.call("launch_executor", map[string]any{"device_id": "exec-1", "token": "dv_0123456789abcdef0123456789", "allowed_hosts": []string{"api.github.com:443:read-only:rest:enforce"}})
	if isError {
		t.Fatalf("launch: %s", text)
	}
	sandbox := launched["sandbox"].(map[string]any)
	if sandbox["name"] != "exec-1" || sandbox["executor"] != "exec-1" || sandbox["managed"] != true {
		t.Fatalf("executor summary: %v", sandbox)
	}
	spec := h.backend.Launched[0]
	if spec.Image != "openharness-connector:test" || spec.Command[0] != ExecutorBinary {
		t.Fatalf("executor spec: %+v", spec)
	}
	env := spec.Environment
	if env["GATEWAY_URL"] != "wss://harness.example.com:8443/connect" || env["DEVICE_ID"] != "exec-1" || env["DEVICE_TOKEN"] != "dv_0123456789abcdef0123456789" || env["OPENHARNESS_SANDBOXED"] != "true" || env["WORK_DIR"] != "/sandbox" {
		t.Fatalf("executor env: %v", env)
	}
	if decoded, err := base64.StdEncoding.DecodeString(env["GATEWAY_CA_PEM_BASE64"]); err != nil || !strings.Contains(string(decoded), "BEGIN CERTIFICATE") {
		t.Fatalf("the harness CA is handed to the executor base64-encoded: %v %q", err, env["GATEWAY_CA_PEM_BASE64"])
	}
	for k, v := range env {
		if strings.ContainsAny(v, "\n\r") {
			t.Fatalf("executor environment %s must not contain newlines (OpenShell rejects them)", k)
		}
	}
	if _, insecure := env["GATEWAY_ALLOW_INSECURE"]; insecure {
		t.Fatal("wss does not enable insecure transport")
	}
	policy := spec.Policy
	if policy.Landlock == nil || policy.Landlock.Compatibility != "hard_requirement" || policy.Process.RunAsUser != "1000" {
		t.Fatalf("executor policy statics: %+v", policy)
	}
	if !contains(policy.Filesystem.ReadWrite, "/sandbox") || !contains(policy.Filesystem.ReadWrite, "/tmp") {
		t.Fatalf("filesystem: %+v", policy.Filesystem)
	}
	gw := policy.NetworkPolicies["openharness"]
	if gw.Endpoints[0].Host != "harness.example.com" || gw.Endpoints[0].Port != 8443 || gw.Endpoints[0].TLS != 1 || gw.Binaries[0].Path != ExecutorBinary {
		t.Fatalf("gateway rule: %+v", gw)
	}
	names := 0
	for name, rule := range policy.NetworkPolicies {
		if strings.HasPrefix(name, "allowed_") {
			names++
			if rule.Endpoints[0].Protocol != "rest" || rule.Endpoints[0].Enforcement != 1 {
				t.Fatalf("extra host rule %s: %+v", name, rule)
			}
		}
	}
	if names != 2 {
		t.Fatalf("expected the default and requested extra hosts, got %d rules", names)
	}
	if r, _, _ := h.call("exec_in_sandbox", map[string]any{"name": "exec-1", "argv": []string{"curl", "https://harness.example.com:8443/"}}); r["exit_code"].(float64) != 0 {
		t.Fatalf("the executor policy admits the harness gateway: %v", r)
	}
	if r, _, _ := h.call("exec_in_sandbox", map[string]any{"name": "exec-1", "argv": []string{"curl", "https://example.org/"}}); r["policy_denied"] != true {
		t.Fatalf("other destinations are denied: %v", r)
	}
	if _, text, isError := h.call("launch_executor", map[string]any{"device_id": "exec-1", "token": "dv_0123456789abcdef0123456789"}); !isError || !strings.Contains(text, "already exists") {
		t.Fatalf("duplicate executor: %s", text)
	}
	if _, text, isError := h.call("launch_executor", map[string]any{"device_id": "exec-2"}); !isError || !strings.Contains(text, "token") {
		t.Fatalf("token required: %s", text)
	}
}

func TestSettingsBoundEveryCaller(t *testing.T) {
	h := setup(t, func(s *Settings) {
		s.AllowPolicyChanges = false
		s.AllowedImages = []string{"registry.example.com/agents/"}
		s.ManageAllSandboxes = false
		s.MaxSandboxes = 2
		s.Workspaces = []string{"team-ml"}
	})
	if _, err := h.backend.CreateSandbox(context.Background(), "default", "operator-owned", CreateSpec{Image: "ubuntu"}); err != nil {
		t.Fatal(err)
	}
	expect := func(tool string, args map[string]any, want string) {
		t.Helper()
		if _, text, isError := h.call(tool, args); !isError || !strings.Contains(text, want) {
			t.Fatalf("%s: expected %q, got %q (error=%v)", tool, want, text, isError)
		}
	}
	expect("set_policy", map[string]any{"name": "operator-owned", "policy": map[string]any{"version": 1}}, "policy changes are disabled")
	expect("approve_rule", map[string]any{"name": "operator-owned", "chunk_id": "x"}, "policy changes are disabled")
	expect("update_policy_rules", map[string]any{"name": "operator-owned", "add_endpoints": []string{"a.b:443"}}, "policy changes are disabled")
	expect("create_sandbox", map[string]any{"name": "evil", "image": "docker.io/library/alpine"}, "not on the edge allow-list")
	expect("create_sandbox", map[string]any{"name": "evil"}, "choose an image")
	expect("delete_sandbox", map[string]any{"name": "operator-owned"}, "not created by this edge")
	expect("exec_in_sandbox", map[string]any{"name": "operator-owned", "argv": []string{"echo"}}, "not created by this edge")
	expect("list_sandboxes", map[string]any{"workspace": "prod"}, "workspace is not allowed")
	expect("list_sandboxes", map[string]any{"workspace": "team-ml"}, `workspace "team-ml" not found`)
	if r, _, _ := h.call("list_sandboxes", nil); r["sandboxes"].([]any)[0].(map[string]any)["managed"] != false {
		t.Fatal("operator sandboxes are listed as unmanaged")
	}
	if _, text, isError := h.call("create_sandbox", map[string]any{"name": "agent-three", "image": "registry.example.com/agents/worker:2.0"}); isError {
		t.Fatalf("allowed image: %s", text)
	}
	if _, text, isError := h.call("create_sandbox", map[string]any{"name": "agent-four", "image": "registry.example.com/agents/worker:2.0"}); isError {
		t.Fatalf("second allowed image: %s", text)
	}
	expect("create_sandbox", map[string]any{"name": "agent-five", "image": "registry.example.com/agents/worker:2.0"}, "sandbox limit (2)")
	if _, _, isError := h.call("update_policy_rules", map[string]any{"name": "agent-three", "add_endpoints": []string{"a.example:443"}, "dry_run": true}); isError {
		t.Fatal("a dry run changes nothing and stays allowed")
	}
	locked := setup(t, func(s *Settings) { s.AllowSandboxLifecycle = false; s.AllowExec = false })
	locked.backend.CreateSandbox(context.Background(), "default", "agent-one", CreateSpec{Image: "x"})
	if _, text, isError := locked.call("delete_sandbox", map[string]any{"name": "agent-one"}); !isError || !strings.Contains(text, "lifecycle changes are disabled") {
		t.Fatalf("lifecycle: %s", text)
	}
	if _, text, isError := locked.call("exec_in_sandbox", map[string]any{"name": "agent-one", "argv": []string{"echo"}}); !isError || !strings.Contains(text, "exec_in_sandbox is disabled") {
		t.Fatalf("exec: %s", text)
	}
	if _, _, isError := locked.call("get_policy", map[string]any{"name": "agent-one"}); isError {
		t.Fatal("reads stay available")
	}
}

func TestPolicyJSONRoundTrip(t *testing.T) {
	doc, err := ParsePolicyDoc(json.RawMessage(`{"version":1,"filesystem_policy":{"include_workdir":true,"read_only":["/usr"],"read_write":["/tmp"]},"landlock":{"compatibility":"hard_requirement"},"process":{"run_as_user":"1500","run_as_group":"1500"},"network_policies":{"gh":{"endpoints":[{"host":"api.github.com","port":443,"protocol":"rest","access":"read-only","enforcement":"enforce","rules":[{"allow":{"method":"POST","path":"/repos/*/issues"}}],"deny_rules":[{"method":"DELETE","path":"/**"}]}],"binaries":[{"path":"/usr/bin/curl"}]},"db":{"endpoints":[{"host":"db.internal","port":5432,"protocol":"tcp"}],"binaries":[{"path":"/usr/bin/psql"}]}}}`))
	if err != nil {
		t.Fatal(err)
	}
	sdk, err := doc.ToSDK()
	if err != nil {
		t.Fatal(err)
	}
	gh := sdk.NetworkPolicies["gh"]
	if gh.Endpoints[0].Access != 1 || gh.Endpoints[0].Enforcement != 1 || gh.Endpoints[0].Rules[0].Allow.Method != "POST" || gh.Endpoints[0].DenyRules[0].Method != "DELETE" {
		t.Fatalf("enum mapping: %+v", gh.Endpoints[0])
	}
	back := FromSDK(sdk)
	if back.NetworkPolicies["gh"].Endpoints[0].Access != "read-only" || back.NetworkPolicies["gh"].Endpoints[0].Enforcement != "enforce" || back.NetworkPolicies["db"].Endpoints[0].Protocol != "tcp" || *back.Filesystem.IncludeWorkdir != true {
		t.Fatalf("round trip: %+v", back)
	}
	if _, err := ParsePolicyDoc(json.RawMessage(`{"version":2}`)); err == nil {
		t.Fatal("unknown versions are refused")
	}
	if _, err := ParsePolicyDoc(json.RawMessage(`{"network_policies":{"x":{"endpoints":[{"host":"a","port":1,"access":"maybe"}],"binaries":[]}}}`)); err == nil {
		t.Fatal("bad access presets are refused")
	}
	if _, err := ParsePolicyDoc(json.RawMessage(`"{\"version\":1,\"network_policies\":{}}"`)); err != nil {
		t.Fatalf("JSON strings holding a policy are accepted: %v", err)
	}
	ep, err := ParseEndpointSpec("api.openai.com:443:read-write:rest:audit")
	if err != nil || ep.Host != "api.openai.com" || ep.Port != 443 || ep.Access != "read-write" || ep.Protocol != "rest" || ep.Enforcement != "audit" {
		t.Fatalf("endpoint spec: %+v %v", ep, err)
	}
	if _, err := ParseEndpointSpec("nohost"); err == nil {
		t.Fatal("endpoint specs need a port")
	}
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}
