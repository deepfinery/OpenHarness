package edge

import (
	"fmt"
	"strings"
)

// Settings is the edge's local policy: what any caller, agent or console, may do through this edge.
type Settings struct {
	// DeviceID is the edge's own machine id; it labels the sandboxes the edge creates.
	DeviceID string
	Version  string
	// Workspace is used unless a call names another allowed one.
	Workspace string
	// Workspaces are additional OpenShell workspaces calls may target.
	Workspaces            []string
	AllowPolicyChanges    bool
	AllowSandboxLifecycle bool
	AllowExec             bool
	// AllowedImages are image references or prefixes create_sandbox may use; empty allows any.
	AllowedImages []string
	// MaxSandboxes caps sandboxes this edge created and still exist.
	MaxSandboxes int
	// ManageAllSandboxes false restricts changes to sandboxes labelled by this edge.
	ManageAllSandboxes bool
	// ExecutorImage is the image executors are created from; it must contain openharness-connector.
	ExecutorImage string
	// ExecutorAllowedHosts are extra `host:port` destinations every executor policy allows for curl.
	ExecutorAllowedHosts []string
	// ExecutorGatewayCAPEM is handed to executors so they trust a self-signed harness gateway.
	ExecutorGatewayCAPEM string
	// ExecutorGatewayURL is the harness gateway executors dial; defaults to the edge's own gateway URL.
	ExecutorGatewayURL string
}

// DefaultSettings are permissive within one workspace, like a freshly installed connector.
func DefaultSettings() Settings {
	return Settings{Workspace: "default", AllowPolicyChanges: true, AllowSandboxLifecycle: true, AllowExec: true, MaxSandboxes: 20, ManageAllSandboxes: true, ExecutorImage: "openharness-connector:local"}
}

// PolicyError is a refusal by the edge's own settings.
type PolicyError struct{ msg string }

func (e *PolicyError) Error() string { return e.msg }

func denied(format string, args ...any) error { return &PolicyError{fmt.Sprintf(format, args...)} }

func (s Settings) workspace(requested string) (string, error) {
	if requested == "" || requested == s.Workspace {
		return s.Workspace, nil
	}
	for _, ws := range s.Workspaces {
		if ws == requested {
			return requested, nil
		}
	}
	return "", denied("workspace is not allowed by the edge settings: %s", requested)
}
func (s Settings) lifecycle() error {
	if !s.AllowSandboxLifecycle {
		return denied("sandbox lifecycle changes are disabled by the edge settings")
	}
	return nil
}
func (s Settings) exec() error {
	if !s.AllowExec {
		return denied("exec_in_sandbox is disabled by the edge settings")
	}
	return nil
}
func (s Settings) policyChanges() error {
	if !s.AllowPolicyChanges {
		return denied("policy changes are disabled by the edge settings")
	}
	return nil
}
func (s Settings) image(image string) error {
	if len(s.AllowedImages) == 0 {
		return nil
	}
	if image == "" {
		return denied("choose an image from the edge allow-list")
	}
	for _, allowed := range s.AllowedImages {
		if image == allowed || strings.HasPrefix(image, allowed) {
			return nil
		}
	}
	return denied("image is not on the edge allow-list: %s", image)
}
