package edge

import (
	"context"
	"fmt"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
	"github.com/NVIDIA/OpenShell/sdk/go/openshell/v1/types"
)

// SDKBackend drives a real OpenShell gateway through the official Go SDK.
type SDKBackend struct {
	Client v1.ClientInterface
}

// NewSDKBackend wraps a connected client.
func NewSDKBackend(client v1.ClientInterface) *SDKBackend { return &SDKBackend{Client: client} }

func (b *SDKBackend) Status(ctx context.Context) (*Status, error) {
	health, err := b.Client.Health().Check(ctx)
	if err != nil {
		return nil, err
	}
	status := &Status{Healthy: health.Healthy, Version: health.Version}
	if info, err := b.Client.Health().GetGatewayInfo(ctx); err == nil {
		status.Info = info
		if status.Version == "" {
			status.Version = info.Version
		}
	}
	return status, nil
}
func (b *SDKBackend) Workspaces(ctx context.Context) ([]*v1.Workspace, error) {
	return b.Client.Workspaces().ListAll(ctx)
}
func (b *SDKBackend) ListSandboxes(ctx context.Context, workspace, selector string) ([]*v1.Sandbox, error) {
	return b.Client.Sandboxes().ListAll(ctx, workspace, v1.ListOptions{LabelSelector: selector})
}
func (b *SDKBackend) GetSandbox(ctx context.Context, workspace, name string) (*v1.Sandbox, error) {
	return b.Client.Sandboxes().Get(ctx, workspace, name)
}
func (b *SDKBackend) GetConfig(ctx context.Context, workspace, name string) (*v1.SandboxConfig, error) {
	return b.Client.Config().GetSandbox(ctx, workspace, name)
}
func (b *SDKBackend) CreateSandbox(ctx context.Context, workspace, name string, spec CreateSpec) (*v1.Sandbox, error) {
	sdkSpec := &v1.SandboxSpec{
		Environment: spec.Environment,
		Template:    &v1.SandboxTemplate{Image: spec.Image, Environment: spec.Environment},
		Providers:   spec.Providers,
		Policy:      spec.Policy,
		Command:     spec.Command,
	}
	return b.Client.Sandboxes().Create(ctx, workspace, name, sdkSpec, spec.Labels)
}
func (b *SDKBackend) WaitReady(ctx context.Context, workspace, name string) (*v1.Sandbox, error) {
	return b.Client.Sandboxes().WaitReady(ctx, workspace, name, v1.WaitOptions{PollInterval: time.Second})
}
func (b *SDKBackend) DeleteSandbox(ctx context.Context, workspace, name string) (string, error) {
	result, err := b.Client.Sandboxes().Delete(ctx, workspace, name)
	if err != nil {
		return "", err
	}
	switch result.Outcome {
	case v1.DeletionCompleted:
		return "completed", nil
	case v1.DeletionAccepted:
		return "accepted", nil
	case v1.DeletionAlreadyAbsent:
		return "already_absent", nil
	}
	return "unspecified", nil
}
func (b *SDKBackend) StartSandbox(ctx context.Context, workspace, name string) (*v1.Sandbox, error) {
	return b.Client.Sandboxes().Start(ctx, workspace, name)
}
func (b *SDKBackend) StopSandbox(ctx context.Context, workspace, name string) (*v1.Sandbox, error) {
	return b.Client.Sandboxes().Stop(ctx, workspace, name)
}
func (b *SDKBackend) Exec(ctx context.Context, workspace, name string, argv []string, opts ExecOptions) (*ExecResult, error) {
	if opts.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, opts.Timeout)
		defer cancel()
	}
	result, err := b.Client.Exec().Run(ctx, workspace, name, argv, v1.ExecOptions{Env: opts.Env, WorkDir: opts.WorkDir, NoLoginShell: true})
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("command timed out after %s", opts.Timeout)
		}
		return nil, err
	}
	return &ExecResult{ExitCode: result.ExitCode, Stdout: string(result.Stdout), Stderr: string(result.Stderr)}, nil
}
func (b *SDKBackend) Logs(ctx context.Context, workspace, name string, opts LogOptions) ([]v1.LogLine, error) {
	var options []v1.LogOption
	if opts.Lines > 0 {
		options = append(options, v1.WithLogLines(uint32(opts.Lines)))
	}
	if opts.Since > 0 {
		options = append(options, v1.WithLogSince(time.Now().Add(-opts.Since)))
	}
	if len(opts.Sources) > 0 {
		options = append(options, v1.WithLogSources(opts.Sources...))
	}
	if opts.MinLevel != "" {
		options = append(options, v1.WithLogMinLevel(opts.MinLevel))
	}
	result, err := b.Client.Sandboxes().GetLogs(ctx, workspace, name, options...)
	if err != nil {
		return nil, err
	}
	return result.Lines, nil
}
func (b *SDKBackend) PolicyRevisions(ctx context.Context, workspace, name string) ([]v1.SandboxPolicyRevision, error) {
	return b.Client.Policy().ListAll(ctx, workspace, name)
}
func (b *SDKBackend) PolicyStatus(ctx context.Context, workspace, name string, version uint32) (*v1.PolicyStatusResult, error) {
	if version > 0 {
		return b.Client.Policy().GetStatus(ctx, workspace, name, v1.WithVersion(version))
	}
	return b.Client.Policy().GetStatus(ctx, workspace, name)
}
func (b *SDKBackend) GlobalPolicy(ctx context.Context) (*v1.PolicyStatusResult, error) {
	return b.Client.Policy().GetStatus(ctx, "default", "", types.WithStatusGlobal(true))
}
func (b *SDKBackend) SetPolicy(ctx context.Context, workspace, name string, policy *v1.SandboxPolicy) (*v1.ConfigUpdateResult, error) {
	return b.Client.Config().Update(ctx, workspace, &v1.ConfigUpdate{Name: name, Policy: policy})
}
func (b *SDKBackend) MergePolicy(ctx context.Context, workspace, name string, ops []v1.PolicyMergeOperation) (*v1.ConfigUpdateResult, error) {
	return b.Client.Config().Update(ctx, workspace, &v1.ConfigUpdate{Name: name, MergeOperations: ops})
}
func (b *SDKBackend) Draft(ctx context.Context, workspace, name string) (*v1.DraftPolicy, error) {
	return b.Client.Policy().GetDraft(ctx, workspace, name)
}
func (b *SDKBackend) ApproveChunk(ctx context.Context, workspace, name, chunkID string) (*v1.ApproveResult, error) {
	draft, err := b.Client.Policy().GetDraft(ctx, workspace, name)
	if err != nil {
		return nil, err
	}
	token := ""
	for _, chunk := range draft.Chunks {
		if chunk.ID == chunkID {
			token = chunk.ReviewToken
		}
	}
	return b.Client.Policy().ApproveDraftChunk(ctx, workspace, name, chunkID, token)
}
func (b *SDKBackend) RejectChunk(ctx context.Context, workspace, name, chunkID, reason string) error {
	return b.Client.Policy().RejectDraftChunk(ctx, workspace, name, chunkID, reason)
}
