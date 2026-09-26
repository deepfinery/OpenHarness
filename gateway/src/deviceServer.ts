// One MCP Server per orchestrator session and device. It answers `initialize` itself and forwards tool calls
// to the device through the hub, applying the allow-list, the approval hook and the audit log.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '@openharness/connector-core';
import type { DeviceHub } from './hub.js';
import { HubError } from './hub.js';
import { clusterTools, type ClusterStore } from './clusters.js';
import type { Registry } from './registry.js';
import type { GatewayAudit } from './audit.js';
import type { ApprovalProvider } from './approval.js';

export const GatewayErrorCode = {
  DeviceOffline: -32010,
  ToolNotAllowed: -32011,
  ApprovalDenied: -32012,
  DeviceTimeout: -32013,
  DeviceReconnected: -32014,
} as const;
export type DeviceServerDeps = {
  hub: DeviceHub;
  registry: Registry;
  clusters?: ClusterStore;
  audit: GatewayAudit;
  approval: ApprovalProvider;
  approvalTools: Set<string>;
  timeoutFor: (tool: string) => number;
  log: Logger;
};
export function createDeviceServer(deviceId: string, identity: string, deps: DeviceServerDeps) {
  const server = new Server(
    { name: 'openharness-gateway', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const allowed = async () => {
    const record = await deps.registry.get(deviceId);
    if (!record || record.disabled) throw new McpError(GatewayErrorCode.DeviceOffline, 'device offline');
    if (record.cluster_id) {
      const cluster = await deps.clusters?.get(record.cluster_id);
      if (!cluster || cluster.disabled)
        throw new McpError(GatewayErrorCode.DeviceOffline, 'cluster disabled');
      return new Set(
        record.allowed_tools.filter(
          (t) => clusterTools.includes(t) && (t !== 'gpu_remediate' || cluster.remediation !== 'disabled'),
        ),
      );
    }
    return new Set(record.allowed_tools);
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allow = await allowed();
    try {
      const { tools, stale } = await deps.hub.listTools(deviceId);
      const record = await deps.registry.get(deviceId);
      const automatic =
        record?.cluster_id && (await deps.clusters?.get(record.cluster_id))?.remediation === 'automatic';
      const visible = tools
        .filter((t) => allow.has(t.name))
        .map((t) =>
          deps.approval.studio &&
          (deps.approvalTools.has(t.name) || (t.name === 'gpu_remediate' && !automatic))
            ? { ...t, _meta: { ...t._meta, 'openharness/approvalRequired': true } }
            : t,
        );
      return { tools: visible, ...(stale ? { _meta: { stale: true } } : {}) };
    } catch (error) {
      if (error instanceof HubError) return { tools: [], _meta: { offline: true } };
      throw error;
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const started = Date.now();
    const { name, arguments: args } = request.params;
    const finish = (outcome: Parameters<GatewayAudit['record']>[0]['outcome'], error?: string) =>
      deps.audit.record({
        identity,
        device_id: deviceId,
        tool: name,
        arguments: args,
        duration_ms: Date.now() - started,
        outcome,
        error,
      });
    const allow = await allowed();
    if (!allow.has(name)) {
      await finish('denied', 'tool not allowed for this device');
      throw new McpError(GatewayErrorCode.ToolNotAllowed, `tool not allowed: ${name}`);
    }
    const record = await deps.registry.get(deviceId);
    const cluster = record?.cluster_id ? await deps.clusters?.get(record.cluster_id) : undefined;
    if (
      name === 'gpu_remediate' &&
      (!cluster ||
        cluster.remediation === 'disabled' ||
        !cluster.actions.includes(String(args?.action) as any))
    ) {
      await finish('denied', 'remediation action not enabled');
      throw new McpError(GatewayErrorCode.ToolNotAllowed, 'remediation action not enabled');
    }
    if (
      (deps.approvalTools.has(name) || name === 'gpu_remediate') &&
      !(name === 'gpu_remediate' && cluster?.remediation === 'automatic')
    ) {
      if (name === 'gpu_remediate' && !deps.approval.studio) {
        await finish('denied', 'Studio approval is required for cluster remediation');
        throw new McpError(
          GatewayErrorCode.ApprovalDenied,
          'Studio approval is required for cluster remediation',
        );
      }
      const decision = await deps.approval.decide(
        {
          device_id: deviceId,
          tool: name,
          arguments: args,
          identity,
          callId:
            typeof request.params._meta?.idempotencyKey === 'string'
              ? request.params._meta.idempotencyKey
              : undefined,
          proof: request.params._meta?.humanApproval,
        },
        extra.signal,
      );
      if (decision !== 'approved') {
        await finish('approval_denied', 'approval denied');
        throw new McpError(GatewayErrorCode.ApprovalDenied, `approval denied for ${name}`);
      }
    }
    if (
      name === 'gpu_remediate' &&
      !(await deps.clusters!.reserveAction(
        cluster!._id,
        Date.now(),
        String(args?.action),
        cluster!.remediation,
      ))
    ) {
      await finish('denied', 'cluster disruption cooldown is active');
      throw new McpError(GatewayErrorCode.ToolNotAllowed, 'cluster disruption cooldown is active');
    }
    try {
      const result = await deps.hub.callTool(deviceId, request.params, {
        timeoutMs: deps.timeoutFor(name),
        signal: extra.signal,
      });
      await finish(result.isError ? 'error' : 'ok', result.isError ? 'tool reported an error' : undefined);
      return result;
    } catch (error) {
      if (error instanceof HubError) {
        await finish('offline', error.message);
        throw new McpError(error.code, error.message);
      }
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        await finish('timeout', 'device timeout');
        throw new McpError(GatewayErrorCode.DeviceTimeout, `device did not answer ${name} in time`);
      }
      if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
        await finish('error', 'device reconnected');
        throw new McpError(
          GatewayErrorCode.DeviceReconnected,
          'device reconnected while the call was in flight',
        );
      }
      await finish('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
  return server;
}
