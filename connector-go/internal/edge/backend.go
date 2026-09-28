// Package edge exposes an OpenShell gateway to OpenHarness as MCP tools. It runs beside the OpenShell gateway on
// the private network, talks to it over its gRPC API through the official Go SDK, and dials out to the harness
// like any connector. It also launches executors: sandboxes that run the OpenHarness connector under a policy.
package edge

import (
	"context"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

// Status is what openshell_status reports about the gateway.
type Status struct {
	Healthy bool            `json:"healthy"`
	Version string          `json:"version"`
	Info    *v1.GatewayInfo `json:"info,omitempty"`
}

// CreateSpec is the subset of a sandbox spec the edge exposes.
type CreateSpec struct {
	Image       string
	Environment map[string]string
	Command     []string
	Policy      *v1.SandboxPolicy
	Labels      map[string]string
	Providers   []string
}

// ExecOptions bound one command.
type ExecOptions struct {
	WorkDir string
	Env     map[string]string
	Timeout time.Duration
}

// ExecResult is the collected output of a command.
type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

// LogOptions filter a log request.
type LogOptions struct {
	Lines    int
	Since    time.Duration
	Sources  []string
	MinLevel string
}

// Backend is the part of the OpenShell gateway the edge needs. The SDK implements it for real gateways; the
// in-memory implementation serves tests and the isolated test stack.
type Backend interface {
	Status(ctx context.Context) (*Status, error)
	Workspaces(ctx context.Context) ([]*v1.Workspace, error)
	ListSandboxes(ctx context.Context, workspace, selector string) ([]*v1.Sandbox, error)
	GetSandbox(ctx context.Context, workspace, name string) (*v1.Sandbox, error)
	GetConfig(ctx context.Context, workspace, name string) (*v1.SandboxConfig, error)
	CreateSandbox(ctx context.Context, workspace, name string, spec CreateSpec) (*v1.Sandbox, error)
	WaitReady(ctx context.Context, workspace, name string) (*v1.Sandbox, error)
	DeleteSandbox(ctx context.Context, workspace, name string) (string, error)
	StartSandbox(ctx context.Context, workspace, name string) (*v1.Sandbox, error)
	StopSandbox(ctx context.Context, workspace, name string) (*v1.Sandbox, error)
	Exec(ctx context.Context, workspace, name string, argv []string, opts ExecOptions) (*ExecResult, error)
	Logs(ctx context.Context, workspace, name string, opts LogOptions) ([]v1.LogLine, error)
	PolicyRevisions(ctx context.Context, workspace, name string) ([]v1.SandboxPolicyRevision, error)
	PolicyStatus(ctx context.Context, workspace, name string, version uint32) (*v1.PolicyStatusResult, error)
	GlobalPolicy(ctx context.Context) (*v1.PolicyStatusResult, error)
	SetPolicy(ctx context.Context, workspace, name string, policy *v1.SandboxPolicy) (*v1.ConfigUpdateResult, error)
	MergePolicy(ctx context.Context, workspace, name string, ops []v1.PolicyMergeOperation) (*v1.ConfigUpdateResult, error)
	Draft(ctx context.Context, workspace, name string) (*v1.DraftPolicy, error)
	ApproveChunk(ctx context.Context, workspace, name, chunkID string) (*v1.ApproveResult, error)
	RejectChunk(ctx context.Context, workspace, name, chunkID, reason string) error
}

// LoadStatusName renders a policy load status the way the CLI does.
func LoadStatusName(s v1.PolicyLoadStatus) string {
	switch s {
	case v1.PolicyLoadStatusPending:
		return "pending"
	case v1.PolicyLoadStatusLoaded:
		return "loaded"
	case v1.PolicyLoadStatusFailed:
		return "failed"
	case v1.PolicyLoadStatusSuperseded:
		return "superseded"
	default:
		return "unspecified"
	}
}
