package edge

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

// ExecutorBinary is where the connector image installs the connector.
const ExecutorBinary = "/usr/local/bin/openharness-connector"

// ExecutorRequest describes an executor to launch: a sandbox that runs the OpenHarness connector under a policy
// and registers itself in the inventory as a machine.
type ExecutorRequest struct {
	Name         string
	DeviceID     string
	Token        string
	GatewayURL   string
	Image        string
	AllowedHosts []string
	Workspace    string
	CAPEM        string
	Labels       map[string]string
}

// ExecutorPolicy builds the sandbox policy for an executor: its workspace and /tmp writable, Landlock required,
// a non-root identity, and egress only to the harness gateway (relayed, since a self-signed gateway cannot be
// inspected) plus the operator's extra hosts for the tools.
func ExecutorPolicy(gatewayURL string, allowedHosts []string) (*v1.SandboxPolicy, error) {
	u, err := url.Parse(gatewayURL)
	if err != nil || u.Hostname() == "" {
		return nil, fmt.Errorf("invalid harness gateway URL %q", gatewayURL)
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "wss" {
			port = "443"
		} else {
			port = "80"
		}
	}
	gatewayPort, err := strconv.Atoi(port)
	if err != nil {
		return nil, fmt.Errorf("invalid harness gateway port %q", port)
	}
	doc := &PolicyDoc{
		Version:    1,
		Filesystem: &FilesystemDoc{IncludeWorkdir: boolPtr(true), ReadWrite: []string{"/sandbox", "/tmp"}},
		Landlock:   &LandlockDoc{Compatibility: "hard_requirement"},
		Process:    &ProcessDoc{RunAsUser: "1000", RunAsGroup: "1000"},
		NetworkPolicies: map[string]RuleDoc{
			"openharness": {
				Name:      "openharness",
				Endpoints: []EndpointDoc{{Host: u.Hostname(), Port: uint32(gatewayPort), TLS: "skip"}},
				Binaries:  []BinaryDoc{{Path: ExecutorBinary}},
			},
		},
	}
	for i, spec := range allowedHosts {
		ep, err := ParseEndpointSpec(spec)
		if err != nil {
			return nil, err
		}
		if ep.Protocol == "" {
			ep.Protocol = "rest"
		}
		if ep.Access == "" && ep.Protocol != "tcp" {
			ep.Access = "read-only"
		}
		if ep.Enforcement == "" && ep.Protocol != "tcp" {
			ep.Enforcement = "enforce"
		}
		name := "allowed_" + strings.NewReplacer(".", "_", "-", "_", "*", "any").Replace(ep.Host) + "_" + strconv.Itoa(i)
		doc.NetworkPolicies[name] = RuleDoc{Name: name, Endpoints: []EndpointDoc{ep}, Binaries: []BinaryDoc{{Path: "/usr/bin/curl"}, {Path: ExecutorBinary}}}
	}
	return doc.ToSDK()
}

func boolPtr(b bool) *bool { return &b }

// LaunchExecutor creates the executor sandbox and waits until it is ready.
func LaunchExecutor(ctx context.Context, backend Backend, settings Settings, req ExecutorRequest) (*v1.Sandbox, *v1.SandboxPolicy, error) {
	if req.Name == "" {
		req.Name = req.DeviceID
	}
	if req.Image == "" {
		req.Image = settings.ExecutorImage
	}
	if req.GatewayURL == "" {
		req.GatewayURL = settings.ExecutorGatewayURL
	}
	if req.CAPEM == "" {
		req.CAPEM = settings.ExecutorGatewayCAPEM
	}
	if req.Token == "" || req.DeviceID == "" || req.GatewayURL == "" {
		return nil, nil, fmt.Errorf("an executor needs device_id, token and gateway_url")
	}
	if err := settings.image(req.Image); err != nil {
		return nil, nil, err
	}
	hosts := append(append([]string{}, settings.ExecutorAllowedHosts...), req.AllowedHosts...)
	policy, err := ExecutorPolicy(req.GatewayURL, hosts)
	if err != nil {
		return nil, nil, err
	}
	env := map[string]string{
		"GATEWAY_URL":           req.GatewayURL,
		"DEVICE_ID":             req.DeviceID,
		"DEVICE_TOKEN":          req.Token,
		"DEVICE_HOSTNAME":       req.Name,
		"WORK_DIR":              "/sandbox",
		"OPENHARNESS_SANDBOXED": "true",
	}
	if strings.HasPrefix(req.GatewayURL, "ws://") {
		env["GATEWAY_ALLOW_INSECURE"] = "true"
	}
	if req.CAPEM != "" {
		// OpenShell rejects environment values with newlines, so the PEM travels base64-encoded.
		env["GATEWAY_CA_PEM_BASE64"] = base64.StdEncoding.EncodeToString([]byte(req.CAPEM))
	}
	labels := map[string]string{"openharness.device": settings.DeviceID, "openharness.executor": req.DeviceID}
	for k, v := range req.Labels {
		labels[k] = v
	}
	sandbox, err := backend.CreateSandbox(ctx, req.Workspace, req.Name, CreateSpec{Image: req.Image, Environment: env, Command: []string{ExecutorBinary}, Policy: policy, Labels: labels})
	if err != nil {
		return nil, nil, err
	}
	waitCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	ready, err := backend.WaitReady(waitCtx, req.Workspace, req.Name)
	if err != nil {
		return sandbox, policy, fmt.Errorf("sandbox %s was created but did not become ready: %w", req.Name, err)
	}
	return ready, policy, nil
}
