# GPU clusters

Create a cluster in **Machines & clusters → Clusters**, copy its one-time enrollment configuration to a root-readable `cluster.env` file, then run from a fresh repository checkout on each Linux node:

```sh
sudo sh connector-linux/install-cluster.sh /path/to/cluster.env --host-access
```

Docker is the only installer dependency beyond standard Linux utilities. The installer builds the connector from this repository, uses a stable ID derived from `/etc/machine-id`, and replaces only its own labeled container. Cloned VMs must have unique machine IDs. Use a reachable gateway hostname in the env file (not `localhost` inside Docker). The same token enrolls every node in that cluster, with no per-node enrollment ceremony. Legacy individual machine enrollment remains available.

`--host-access` explicitly runs the connector as root with `--privileged --pid=host`. Typed GPU tools enter the host namespaces using `nsenter` and execute the host's NVIDIA/DCGM/systemd programs. Without this option the connector is an ordinary unprivileged container. The orchestrator containers stay unprivileged. No Docker socket is mounted into remote connectors. Host drivers, `nvidia-smi`, `dcgmi`, and systemd/journal utilities must already be installed; unavailable commands return diagnostic errors, not invented telemetry.

A shared credential grants enrollment and impersonation within its cluster; distribute it only to trusted nodes. The gateway stores an Argon2 hash, derives ownership from the cluster, refuses collisions with other enrollments, caps registered identities, and independently restricts cluster tools to `system_info`, `gpu_inspect`, and permitted `gpu_remediate` actions. Disabling a node or cluster revokes access; rotation disconnects all members, and every node needs the new env file. Registered identity capacity is retained when a device is removed; re-enrolling the same ID reuses its slot.

## Monitoring

Create or edit a monitoring agent directly in the cluster settings, or choose an existing saved agent, then enable monitoring. The editor includes the model, instructions, notebook, skills and guardrail policy. The default interval is five minutes and concurrency is four. Each cycle snapshots online members and queues separate, node-scoped agent runs in small waves. Runs use the agent's model, instructions, notebook, guardrails, and approval policy. The node replaces all external MCP connections for these runs, preventing accidental control of another machine. Delegation inside a node run is disabled; the durable coordinator handles fleet fanout. Each node run is limited to eight model turns and 16,000 tokens (or the agent's lower configured limit).

The coordinator persists its lease, membership, cursor, active run IDs, and outcome counts in MongoDB. Idempotency keys prevent duplicate submissions after a coordinator restart. Waiting-for-human runs consume concurrency. Offline nodes are counted, and nodes disappearing before dispatch are skipped. Completed node runs are linked from each cycle. Pausing prevents further dispatch; already accepted runs can be canceled from Runs. A cycle cannot overlap another cycle of the same cluster; if a scan takes longer than five minutes, the next scan waits for completion and then the configured interval. Disabling a cluster also denies pending tool calls.

For large fleets, size `WORKER_CONCURRENCY`, `MAX_ACTIVE_RUNS`, model-provider capacity and the monitor's concurrency together. A 2,000-node inventory uses queued waves rather than 2,000 simultaneous LLM contexts. `GATEWAY_HELLO_RATE_LIMIT` defaults to 600 attempts/minute/source IP, with eight concurrent credential verifications; increase the rate for a fleet behind one NAT. This implementation has bounded-queue and 2,000-identity storage tests, not a 2,000-GPU hardware throughput benchmark. Meeting a five-minute full-fleet deadline depends on capacity and diagnostic latency.

## Remediation

Diagnostics are the default. To allow disruptive operations, choose **Human approval** or explicitly **Automatic within limits**, select allowed actions, and configure the cluster cooldown. Approval mode requires the gateway's Studio approval provider. Automatic mode waives the gateway's human gate for permitted actions; an agent's own approval policy can still require review.

The node operator must also set an allow-list in the cluster env file and reinstall, for example:

```dotenv
HOST_REMEDIATION_ACTIONS=gpu_reset,restart_fabric_manager
```

The workload scheduler or operator must drain the node, prevent new jobs, and create `/var/lib/openharness-cluster/drained`, owned by root, not writable by group/others, and modified in the last five minutes. Only create this marker after a real drain; it is an authorization signal, not a drain implementation. The agent cannot write it through cluster tools. A site scheduler can automate this step. Keep the node drained until validation/rejoin completes. Automatic scheduler-specific draining/rejoining is outside this integration.

Before a reset, Fabric Manager restart, or reboot, the connector checks that no compute jobs are using the GPUs. If that query fails, remediation fails closed. The gateway atomically permits at most one disruptive request per cluster cooldown (default ten minutes). Each node persists a ten-minute reservation and requires a renewed drain marker before another action; failures consume the reservation too. Typed commands have bounded output and timeouts; decisions/results are audited. The persistent reservation also records attempts if a reboot disconnects the response. A lost response is not evidence that the action failed: inspect the run and node state before retrying.

GPU reset targets one explicit GPU index. There is no generic “reset NVLink” command: diagnostics inspect NVLink, and supported GPU/Fabric Manager operations are explicit. Hardware dependencies can make a single-GPU reset unavailable; the connector does not automatically widen the target. It does not stop training jobs, stop DCGM, or reset adjacent GPUs to force success. Review [NVIDIA GPU reset requirements](https://docs.nvidia.com/deploy/nvidia-smi/), [Fabric Manager guidance](https://docs.nvidia.com/datacenter/tesla/fabric-manager-user-guide/), and [DCGM NVLink diagnostics](https://docs.nvidia.com/datacenter/dcgm/latest/reference/command-line-reference/dcgmi/dcgmi-nvlink.html). Remediation tests simulate host commands; no real GPU or VM was reset during development.

## TLS

For development, `ws://` needs both gateway `GATEWAY_ALLOW_INSECURE_WS=true` and connector `GATEWAY_ALLOW_INSECURE=true`. For deployment, use `wss://` with a trusted certificate and disable both insecure flags. The repository includes a Caddy gateway deployment in `gateway/compose.yaml`. Only that trusted proxy should reach the internal gateway port when `TRUST_PROXY=1` is enabled; forwarded TLS headers are ignored without proxy trust. For a private CA, mount its certificate into the connector and set `NODE_EXTRA_CA_CERTS` to its container path. Certificate validation must remain enabled. Tests exercise verified WSS, rejected untrusted certificates, and real WS connector enrollment.

## Unified machine inventory

The **Machines & clusters** menu contains the machine inventory and cluster overview. Filter machines by cluster, status, platform, name, or hostname. **View nodes** on a cluster card opens its filtered inventory; the cluster filter survives a page refresh and supports browser back/forward. Standalone machine enrollment, connector setup, tool permissions, and operator workflow creation remain available in the same page. **Manage cluster** contains shared enrollment, monitoring, remediation controls, and cycle history. Existing `/clusters` links open the cluster view at `/machines?view=clusters`.
