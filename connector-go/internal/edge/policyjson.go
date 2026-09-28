package edge

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
	"github.com/NVIDIA/OpenShell/sdk/go/openshell/v1/types"
)

// PolicyDoc is the JSON shape of an OpenShell sandbox policy as documented (snake_case, the same keys as the YAML
// policy files). The console edits this shape; the edge converts it to the SDK's typed policy and back.
type PolicyDoc struct {
	Version         uint32             `json:"version"`
	Filesystem      *FilesystemDoc     `json:"filesystem_policy,omitempty"`
	Landlock        *LandlockDoc       `json:"landlock,omitempty"`
	Process         *ProcessDoc        `json:"process,omitempty"`
	NetworkPolicies map[string]RuleDoc `json:"network_policies"`
}
type FilesystemDoc struct {
	IncludeWorkdir *bool    `json:"include_workdir,omitempty"`
	ReadOnly       []string `json:"read_only,omitempty"`
	ReadWrite      []string `json:"read_write,omitempty"`
}
type LandlockDoc struct {
	Compatibility string `json:"compatibility,omitempty"`
}
type ProcessDoc struct {
	RunAsUser  string `json:"run_as_user,omitempty"`
	RunAsGroup string `json:"run_as_group,omitempty"`
}
type RuleDoc struct {
	Name      string        `json:"name,omitempty"`
	Endpoints []EndpointDoc `json:"endpoints"`
	Binaries  []BinaryDoc   `json:"binaries"`
}
type EndpointDoc struct {
	Host        string      `json:"host"`
	Port        uint32      `json:"port,omitempty"`
	Ports       []uint32    `json:"ports,omitempty"`
	Protocol    string      `json:"protocol,omitempty"`
	Enforcement string      `json:"enforcement,omitempty"`
	Access      string      `json:"access,omitempty"`
	Path        string      `json:"path,omitempty"`
	TLS         string      `json:"tls,omitempty"`
	AllowedIPs  []string    `json:"allowed_ips,omitempty"`
	Rules       []AllowDoc  `json:"rules,omitempty"`
	DenyRules   []MatchDoc  `json:"deny_rules,omitempty"`
	MCP         *McpDoc     `json:"mcp,omitempty"`
	Provenance  *Provenance `json:"provenance,omitempty"`
}
type AllowDoc struct {
	Allow MatchDoc `json:"allow"`
}
type MatchDoc struct {
	Method  string `json:"method,omitempty"`
	Path    string `json:"path,omitempty"`
	Command string `json:"command,omitempty"`
}
type McpDoc struct {
	Versions []string `json:"versions,omitempty"`
}
type Provenance struct {
	ProviderCredentialed bool `json:"provider_credentialed,omitempty"`
	AdvisorProposed      bool `json:"advisor_proposed,omitempty"`
}
type BinaryDoc struct {
	Path string `json:"path"`
}

// ParsePolicyDoc accepts a JSON object or a JSON string holding one.
func ParsePolicyDoc(raw json.RawMessage) (*PolicyDoc, error) {
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return nil, err
		}
		raw = json.RawMessage(text)
		trimmed = strings.TrimSpace(text)
	}
	if !strings.HasPrefix(trimmed, "{") {
		return nil, fmt.Errorf("the policy must be a JSON object (YAML is not accepted here; convert it to JSON first)")
	}
	var doc PolicyDoc
	dec := json.NewDecoder(strings.NewReader(trimmed))
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("invalid policy JSON: %w", err)
	}
	if doc.Version == 0 {
		doc.Version = 1
	}
	if doc.Version != 1 {
		return nil, fmt.Errorf("unsupported policy version %d", doc.Version)
	}
	// Validate the enumerations now so a bad document is refused before anything is sent to the gateway.
	if _, err := doc.ToSDK(); err != nil {
		return nil, err
	}
	return &doc, nil
}

func enforcementFromName(name string) (v1.NetworkEnforcementMode, error) {
	switch strings.ToLower(name) {
	case "":
		return v1.NetworkEnforcementModeUnspecified, nil
	case "enforce":
		return v1.NetworkEnforcementModeEnforce, nil
	case "audit":
		return v1.NetworkEnforcementModeAudit, nil
	}
	return 0, fmt.Errorf("enforcement must be enforce or audit, not %q", name)
}
func enforcementName(m v1.NetworkEnforcementMode) string {
	switch m {
	case v1.NetworkEnforcementModeEnforce:
		return "enforce"
	case v1.NetworkEnforcementModeAudit:
		return "audit"
	}
	return ""
}
func accessFromName(name string) (v1.NetworkAccessPreset, error) {
	switch strings.ToLower(name) {
	case "":
		return v1.NetworkAccessPresetUnspecified, nil
	case "read-only", "read_only", "readonly":
		return v1.NetworkAccessPresetReadOnly, nil
	case "read-write", "read_write", "readwrite":
		return v1.NetworkAccessPresetReadWrite, nil
	case "full":
		return v1.NetworkAccessPresetFull, nil
	}
	return 0, fmt.Errorf("access must be read-only, read-write or full, not %q", name)
}
func accessName(a v1.NetworkAccessPreset) string {
	switch a {
	case v1.NetworkAccessPresetReadOnly:
		return "read-only"
	case v1.NetworkAccessPresetReadWrite:
		return "read-write"
	case v1.NetworkAccessPresetFull:
		return "full"
	}
	return ""
}

// ToSDK converts a policy document into the SDK's typed policy.
func (d *PolicyDoc) ToSDK() (*v1.SandboxPolicy, error) {
	p := &v1.SandboxPolicy{Version: d.Version}
	if d.Filesystem != nil {
		fs := &v1.FilesystemPolicy{ReadOnly: append([]string{}, d.Filesystem.ReadOnly...), ReadWrite: append([]string{}, d.Filesystem.ReadWrite...)}
		if d.Filesystem.IncludeWorkdir != nil {
			fs.IncludeWorkdir = *d.Filesystem.IncludeWorkdir
		}
		p.Filesystem = fs
	}
	if d.Landlock != nil {
		p.Landlock = &v1.LandlockPolicy{Compatibility: d.Landlock.Compatibility}
	}
	if d.Process != nil {
		p.Process = &v1.ProcessPolicy{RunAsUser: d.Process.RunAsUser, RunAsGroup: d.Process.RunAsGroup}
	}
	if d.NetworkPolicies != nil {
		p.NetworkPolicies = map[string]v1.NetworkPolicyRule{}
		for name, rule := range d.NetworkPolicies {
			converted, err := rule.toSDK(name)
			if err != nil {
				return nil, fmt.Errorf("network_policies.%s: %w", name, err)
			}
			p.NetworkPolicies[name] = converted
		}
	}
	return p, nil
}

func (r RuleDoc) toSDK(name string) (v1.NetworkPolicyRule, error) {
	rule := v1.NetworkPolicyRule{Name: name, Endpoints: []v1.PolicyNetworkEndpoint{}, Binaries: []v1.PolicyNetworkBinary{}}
	if r.Name != "" {
		rule.Name = r.Name
	}
	for _, e := range r.Endpoints {
		if e.Host == "" {
			return rule, fmt.Errorf("an endpoint needs a host")
		}
		enforcement, err := enforcementFromName(e.Enforcement)
		if err != nil {
			return rule, err
		}
		access, err := accessFromName(e.Access)
		if err != nil {
			return rule, err
		}
		ep := v1.PolicyNetworkEndpoint{Host: e.Host, Port: e.Port, Ports: e.Ports, Protocol: strings.ToLower(e.Protocol), Enforcement: enforcement, Access: access, Path: e.Path, AllowedIPs: e.AllowedIPs}
		if strings.EqualFold(e.TLS, "skip") {
			ep.TLS = v1.NetworkTLSModeSkip
		}
		for _, a := range e.Rules {
			ep.Rules = append(ep.Rules, v1.L7Rule{Allow: &v1.L7Allow{Method: a.Allow.Method, Path: a.Allow.Path, Command: a.Allow.Command}})
		}
		for _, d := range e.DenyRules {
			ep.DenyRules = append(ep.DenyRules, v1.L7DenyRule{Method: d.Method, Path: d.Path, Command: d.Command})
		}
		if e.MCP != nil {
			ep.Mcp = &types.McpOptions{Versions: append([]string{}, e.MCP.Versions...)}
		}
		rule.Endpoints = append(rule.Endpoints, ep)
	}
	for _, b := range r.Binaries {
		if b.Path == "" {
			return rule, fmt.Errorf("a binary needs a path")
		}
		rule.Binaries = append(rule.Binaries, v1.PolicyNetworkBinary{Path: b.Path})
	}
	return rule, nil
}

// FromSDK converts the SDK's typed policy into the documented JSON shape.
func FromSDK(p *v1.SandboxPolicy) *PolicyDoc {
	if p == nil {
		return nil
	}
	doc := &PolicyDoc{Version: p.Version, NetworkPolicies: map[string]RuleDoc{}}
	if doc.Version == 0 {
		doc.Version = 1
	}
	if p.Filesystem != nil {
		include := p.Filesystem.IncludeWorkdir
		doc.Filesystem = &FilesystemDoc{IncludeWorkdir: &include, ReadOnly: p.Filesystem.ReadOnly, ReadWrite: p.Filesystem.ReadWrite}
	}
	if p.Landlock != nil {
		doc.Landlock = &LandlockDoc{Compatibility: p.Landlock.Compatibility}
	}
	if p.Process != nil {
		doc.Process = &ProcessDoc{RunAsUser: p.Process.RunAsUser, RunAsGroup: p.Process.RunAsGroup}
	}
	names := make([]string, 0, len(p.NetworkPolicies))
	for name := range p.NetworkPolicies {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		rule := p.NetworkPolicies[name]
		out := RuleDoc{Name: rule.Name, Endpoints: []EndpointDoc{}, Binaries: []BinaryDoc{}}
		for _, e := range rule.Endpoints {
			ep := EndpointDoc{Host: e.Host, Port: e.Port, Ports: e.Ports, Protocol: e.Protocol, Enforcement: enforcementName(e.Enforcement), Access: accessName(e.Access), Path: e.Path, AllowedIPs: e.AllowedIPs}
			if e.TLS == v1.NetworkTLSModeSkip {
				ep.TLS = "skip"
			}
			for _, a := range e.Rules {
				if a.Allow != nil {
					ep.Rules = append(ep.Rules, AllowDoc{Allow: MatchDoc{Method: a.Allow.Method, Path: a.Allow.Path, Command: a.Allow.Command}})
				}
			}
			for _, d := range e.DenyRules {
				ep.DenyRules = append(ep.DenyRules, MatchDoc{Method: d.Method, Path: d.Path, Command: d.Command})
			}
			if e.Mcp != nil && len(e.Mcp.Versions) > 0 {
				ep.MCP = &McpDoc{Versions: e.Mcp.Versions}
			}
			if e.ProviderCredentialed || e.AdvisorProposed {
				ep.Provenance = &Provenance{ProviderCredentialed: e.ProviderCredentialed, AdvisorProposed: e.AdvisorProposed}
			}
			out.Endpoints = append(out.Endpoints, ep)
		}
		for _, b := range rule.Binaries {
			out.Binaries = append(out.Binaries, BinaryDoc{Path: b.Path})
		}
		doc.NetworkPolicies[name] = out
	}
	return doc
}

// ParseEndpointSpec parses the CLI-style `host:port[:access[:protocol[:enforcement]]]` form used by the
// update_policy_rules tool and the console's quick rule form.
func ParseEndpointSpec(spec string) (EndpointDoc, error) {
	parts := strings.Split(spec, ":")
	if len(parts) < 2 || parts[0] == "" {
		return EndpointDoc{}, fmt.Errorf("endpoint %q must look like host:port[:access[:protocol[:enforcement]]]", spec)
	}
	var port uint32
	if _, err := fmt.Sscanf(parts[1], "%d", &port); err != nil || port == 0 || port > 65535 {
		return EndpointDoc{}, fmt.Errorf("endpoint %q has an invalid port", spec)
	}
	ep := EndpointDoc{Host: parts[0], Port: port}
	if len(parts) > 2 {
		ep.Access = parts[2]
	}
	if len(parts) > 3 {
		ep.Protocol = parts[3]
	}
	if len(parts) > 4 {
		ep.Enforcement = parts[4]
	}
	if ep.Protocol == "tcp" {
		ep.Access, ep.Enforcement = "", ""
	}
	if _, err := accessFromName(ep.Access); err != nil {
		return EndpointDoc{}, err
	}
	if _, err := enforcementFromName(ep.Enforcement); err != nil {
		return EndpointDoc{}, err
	}
	return ep, nil
}
