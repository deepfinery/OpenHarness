// The OpenShell tool set: sandbox lifecycle, execution, logs, policy revisions and agent-authored rule proposals.
// Every tool applies the connector's local policy itself; the gateway's per-machine allow-list is a second layer.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { IdempotencyCache, PolicyError, type AuditLog } from '@openharness/connector-core';
import type { OpenShellSettings } from './config.js';
import {
  OpenShellError,
  cliValuePattern,
  durationPattern,
  sandboxNamePattern,
  workspacePattern,
  type OpenShellDriver,
} from './openshell.js';

export const openshellToolNames = [
  'openshell_status',
  'list_workspaces',
  'list_sandboxes',
  'get_sandbox',
  'create_sandbox',
  'delete_sandbox',
  'start_sandbox',
  'stop_sandbox',
  'exec_in_sandbox',
  'sandbox_logs',
  'list_policy_revisions',
  'get_policy',
  'set_policy',
  'update_policy_rules',
  'list_rule_proposals',
  'approve_rule',
  'reject_rule',
  'get_global_policy',
] as const;
/** Label the connector stamps on every sandbox it creates, so its own sandboxes can be told apart and capped. */
export const MANAGED_LABEL = 'openharness.device';

type ToolContext = {
  driver: OpenShellDriver;
  settings: OpenShellSettings;
  audit: AuditLog;
  deviceId: string;
  maxOutputBytes: number;
};
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  structuredContent:
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value },
});
const failure = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});
const idempotencyKey = (extra: Extra) => {
  const key = (extra._meta as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  return typeof key === 'string' ? key : undefined;
};
const sandboxName = z.string().regex(sandboxNamePattern, 'lowercase letters, digits and dashes');
const workspace = z.string().regex(workspacePattern).optional();
const cliValue = (max = 1024) => z.string().regex(cliValuePattern, 'must not start with a dash').max(max);
const labelKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/);
const labelValue = z.string().regex(/^[A-Za-z0-9._-]{0,127}$/);

/** The local policy: what this connector lets any caller do on this OpenShell gateway. */
export class OpenShellPolicy {
  constructor(
    private readonly settings: OpenShellSettings,
    private readonly deviceId: string,
  ) {}
  workspace(requested?: string) {
    if (!requested || requested === this.settings.workspace) return this.settings.workspace;
    if (!this.settings.workspaces.includes(requested))
      throw new PolicyError(`workspace is not allowed by the connector policy: ${requested}`);
    return requested;
  }
  lifecycle() {
    if (!this.settings.allow_sandbox_lifecycle)
      throw new PolicyError('sandbox lifecycle changes are disabled by the connector policy');
  }
  exec() {
    if (!this.settings.allow_exec)
      throw new PolicyError('exec_in_sandbox is disabled by the connector policy');
  }
  policyChanges() {
    if (!this.settings.allow_policy_changes)
      throw new PolicyError('policy changes are disabled by the connector policy');
  }
  image(image?: string) {
    if (!this.settings.allowed_images.length) return;
    if (!image) throw new PolicyError('choose an image from the connector allow-list');
    if (!this.settings.allowed_images.some((allowed) => image === allowed || image.startsWith(allowed)))
      throw new PolicyError(`image is not on the connector allow-list: ${image}`);
  }
  /** Whether a sandbox record (from list/get) belongs to this connector. */
  managed(sandbox: Record<string, unknown>) {
    const labels = sandbox.labels;
    return Boolean(
      labels &&
      typeof labels === 'object' &&
      (labels as Record<string, unknown>)[MANAGED_LABEL] === this.deviceId,
    );
  }
  manageable(sandbox: Record<string, unknown>) {
    if (this.settings.manage_all_sandboxes || this.managed(sandbox)) return;
    throw new PolicyError(
      `sandbox ${String(sandbox.name)} was not created by this connector; manage_all_sandboxes is off`,
    );
  }
  capacity(managedCount: number) {
    if (managedCount >= this.settings.max_sandboxes)
      throw new PolicyError(`the connector's sandbox limit (${this.settings.max_sandboxes}) is reached`);
  }
}

export function registerOpenShellTools(server: McpServer, ctx: ToolContext) {
  const policy = new OpenShellPolicy(ctx.settings, ctx.deviceId);
  const cache = new IdempotencyCache<CallToolResult>();
  const cap = (value: string) => {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= ctx.maxOutputBytes) return { text: value, truncated: false };
    return {
      text:
        Buffer.from(value, 'utf8').subarray(0, ctx.maxOutputBytes).toString('utf8') +
        `\n…[truncated ${bytes - ctx.maxOutputBytes} bytes]`,
      truncated: true,
    };
  };
  /** Wraps a tool body with policy error handling, audit logging and idempotent replay of state changes. */
  function guarded<A>(tool: string, body: (args: A) => Promise<CallToolResult>, replayable = false) {
    return async (args: A, extra: Extra): Promise<CallToolResult> => {
      const key = replayable ? idempotencyKey(extra) : undefined;
      const replay = cache.get(key);
      if (replay) {
        await ctx.audit.write({ tool, outcome: 'ok', duration_ms: 0, idempotency_key: key, replayed: true });
        return replay;
      }
      const started = Date.now();
      try {
        const result = await body(args);
        if (replayable) cache.set(key, result);
        await ctx.audit.write({
          tool,
          outcome: result.isError ? 'error' : 'ok',
          duration_ms: Date.now() - started,
          arguments: args,
          idempotency_key: key,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.audit.write({
          tool,
          outcome:
            error instanceof PolicyError
              ? 'denied'
              : error instanceof OpenShellError && error.run?.timed_out
                ? 'timeout'
                : 'error',
          duration_ms: Date.now() - started,
          arguments: args,
          error: message,
          idempotency_key: key,
        });
        return failure(message);
      }
    };
  }
  const summarize = (sandbox: Record<string, unknown>) => ({
    name: sandbox.name,
    id: sandbox.id,
    workspace: sandbox.workspace,
    phase: sandbox.phase,
    created_at: sandbox.created_at,
    labels: sandbox.labels ?? {},
    current_policy_version: sandbox.current_policy_version,
    policy_source: sandbox.policy_source,
    exit_code: sandbox.exit_code ?? null,
    conditions: sandbox.conditions ?? [],
    managed: policy.managed(sandbox),
  });
  /** Loads a sandbox and checks the connector may manage it. */
  const manageable = async (name: string, ws: string) => {
    const sandbox = await ctx.driver.getSandbox(name, ws);
    policy.manageable(sandbox);
    return sandbox;
  };

  server.registerTool(
    'openshell_status',
    {
      title: 'OpenShell status',
      description:
        'Reachability, authentication and version of the OpenShell gateway this machine manages, plus the CLI version and the connector policy in force.',
      inputSchema: {},
    },
    guarded('openshell_status', async () => {
      const [version, status, info] = await Promise.all([
        ctx.driver.version(),
        ctx.driver.status(),
        ctx.driver
          .gatewayInfo()
          .catch((error) => ({ unavailable: error instanceof Error ? error.message : String(error) })),
      ]);
      return text({
        cli_version: version,
        status,
        gateway_info: info,
        connector_policy: {
          workspace: ctx.settings.workspace,
          workspaces: [ctx.settings.workspace, ...ctx.settings.workspaces],
          allow_policy_changes: ctx.settings.allow_policy_changes,
          allow_sandbox_lifecycle: ctx.settings.allow_sandbox_lifecycle,
          allow_exec: ctx.settings.allow_exec,
          allowed_images: ctx.settings.allowed_images,
          max_sandboxes: ctx.settings.max_sandboxes,
          manage_all_sandboxes: ctx.settings.manage_all_sandboxes,
        },
      });
    }),
  );
  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description: 'OpenShell workspaces visible to this connector.',
      inputSchema: {},
    },
    guarded('list_workspaces', async () => text({ workspaces: await ctx.driver.listWorkspaces() })),
  );
  server.registerTool(
    'list_sandboxes',
    {
      title: 'List sandboxes',
      description:
        'Sandboxes in a workspace with their phase, labels and policy version. `managed` marks the ones this connector created.',
      inputSchema: { selector: cliValue(500).optional(), workspace },
    },
    guarded('list_sandboxes', async ({ selector, workspace: ws }) => {
      const result = await ctx.driver.listSandboxes({ selector, workspace: policy.workspace(ws) });
      return text({ sandboxes: result.sandboxes.map(summarize), next_page_token: result.next_page_token });
    }),
  );
  server.registerTool(
    'get_sandbox',
    {
      title: 'Get sandbox',
      description:
        'Full detail of one sandbox: status conditions, endpoint results, policy source and active policy.',
      inputSchema: { name: sandboxName, workspace },
    },
    guarded('get_sandbox', async ({ name, workspace: ws }) =>
      text(await ctx.driver.getSandbox(name, policy.workspace(ws))),
    ),
  );
  server.registerTool(
    'create_sandbox',
    {
      title: 'Create sandbox',
      description:
        'Create a sandbox from an image or template with an optional policy (YAML or JSON text), labels, providers and a detached main command. The sandbox is labelled as created by this connector.',
      inputSchema: {
        name: sandboxName.optional(),
        image: cliValue(500).optional(),
        template: cliValue(200).optional(),
        command: z.array(z.string().max(4000)).max(200).optional(),
        policy: z.string().max(200_000).optional(),
        labels: z.record(labelKey, labelValue).optional(),
        providers: z.array(cliValue(200)).max(50).optional(),
        cpu: z
          .string()
          .regex(/^\d+(\.\d+)?m?$/)
          .optional(),
        memory: z
          .string()
          .regex(/^\d+(Mi|Gi|M|G)$/)
          .optional(),
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(4000)).optional(),
        no_keep: z.boolean().optional(),
        workspace,
      },
    },
    guarded(
      'create_sandbox',
      async (input) => {
        policy.lifecycle();
        policy.image(input.image);
        const ws = policy.workspace(input.workspace);
        const existing = await ctx.driver.listSandboxes({ workspace: ws });
        policy.capacity(existing.sandboxes.filter((s) => policy.managed(s)).length);
        const created = await ctx.driver.createSandbox({
          name: input.name,
          image: input.image,
          template: input.template,
          command: input.command,
          policy: input.policy,
          labels: { ...(input.labels ?? {}), [MANAGED_LABEL]: ctx.deviceId },
          providers: input.providers,
          cpu: input.cpu,
          memory: input.memory,
          env: input.env,
          noKeep: input.no_keep,
          workspace: ws,
        });
        return text(
          created && typeof created === 'object' && !Array.isArray(created)
            ? { ...(created as Record<string, unknown>), managed: true }
            : { result: created, managed: true },
        );
      },
      true,
    ),
  );
  for (const [tool, action] of [
    ['delete_sandbox', 'delete'],
    ['start_sandbox', 'start'],
    ['stop_sandbox', 'stop'],
  ] as const) {
    server.registerTool(
      tool,
      {
        title: `${action[0].toUpperCase()}${action.slice(1)} sandbox`,
        description:
          action === 'delete'
            ? 'Delete a sandbox. Its processes stop and its state is removed; copy out anything needed first.'
            : action === 'stop'
              ? 'Stop a sandbox while preserving its workspace.'
              : 'Start a stopped sandbox.',
        inputSchema: { name: sandboxName, workspace },
      },
      guarded(
        tool,
        async ({ name, workspace: ws }) => {
          policy.lifecycle();
          const scope = policy.workspace(ws);
          await manageable(name, scope);
          const output =
            action === 'delete'
              ? await ctx.driver.deleteSandbox(name, scope)
              : action === 'start'
                ? await ctx.driver.startSandbox(name, scope)
                : await ctx.driver.stopSandbox(name, scope);
          return text({ name, action, output });
        },
        true,
      ),
    );
  }
  server.registerTool(
    'exec_in_sandbox',
    {
      title: 'Run a command in a sandbox',
      description:
        'Run a program inside a sandbox (argv list, no shell) and return its exit code and output. Network and filesystem denials come from the sandbox policy and are reported as they happen.',
      inputSchema: {
        name: sandboxName,
        argv: z.array(z.string().max(4000)).min(1).max(200),
        workdir: z
          .string()
          .regex(/^\/[^\0]{0,1023}$/)
          .optional(),
        timeout_seconds: z.number().int().min(1).max(3600).optional(),
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(4000)).optional(),
        workspace,
      },
    },
    guarded(
      'exec_in_sandbox',
      async ({ name, argv, workdir, timeout_seconds, env, workspace: ws }) => {
        policy.exec();
        const scope = policy.workspace(ws);
        if (!ctx.settings.manage_all_sandboxes) await manageable(name, scope);
        const run = await ctx.driver.exec(name, {
          argv,
          workdir,
          timeoutSeconds: timeout_seconds,
          env,
          workspace: scope,
        });
        const stdout = cap(run.stdout),
          stderr = cap(run.stderr);
        const denied = /policy_denied|blocked by (sandbox )?policy|Landlock|Operation not permitted/i.test(
          run.stderr,
        );
        // The CLI reports its own failures (sandbox stopped, unreachable gateway) as `Error:` lines with no output
        // from the program; those are tool errors, while a program's own non-zero exit is an ordinary result.
        const cliFailure = run.exit_code !== 0 && !run.stdout && /^Error:/m.test(run.stderr) && !denied;
        return {
          ...text({
            name,
            argv,
            exit_code: run.exit_code,
            signal: run.signal,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: run.truncated || stdout.truncated || stderr.truncated,
            timed_out: run.timed_out,
            policy_denied: denied,
          }),
          isError: run.timed_out || cliFailure,
        };
      },
      true,
    ),
  );
  server.registerTool(
    'sandbox_logs',
    {
      title: 'Sandbox logs',
      description:
        'Recent sandbox and gateway log lines, including policy denials (destination, binary and reason). Do not filter by level when looking for denials.',
      inputSchema: {
        name: sandboxName,
        since: z.string().regex(durationPattern, 'for example 10m or 1h').optional(),
        source: z.enum(['sandbox', 'gateway', 'all']).optional(),
        lines: z.number().int().min(1).max(5000).optional(),
        level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).optional(),
        workspace,
      },
    },
    guarded('sandbox_logs', async ({ name, since, source, lines, level, workspace: ws }) => {
      const output = cap(
        await ctx.driver.logs(name, { since, source, lines, level, workspace: policy.workspace(ws) }),
      );
      return text({ name, text: output.text, truncated: output.truncated });
    }),
  );
  server.registerTool(
    'list_policy_revisions',
    {
      title: 'Policy revisions',
      description:
        'Revision history of a sandbox policy: version, hash, whether the sandbox loaded it, and any load error.',
      inputSchema: { name: sandboxName, workspace },
    },
    guarded('list_policy_revisions', async ({ name, workspace: ws }) =>
      text({
        name,
        revisions: await ctx.driver.listPolicyRevisions({ name, workspace: policy.workspace(ws) }),
      }),
    ),
  );
  server.registerTool(
    'get_policy',
    {
      title: 'Get policy',
      description:
        'A sandbox policy as JSON. `base` is what was set for the sandbox and is the right starting point for edits; `full` adds the rules attached providers contribute. Omit rev for the current revision.',
      inputSchema: {
        name: sandboxName,
        view: z.enum(['base', 'full']).default('base'),
        rev: z.number().int().min(1).optional(),
        workspace,
      },
    },
    guarded('get_policy', async ({ name, view, rev, workspace: ws }) =>
      text(await ctx.driver.getPolicy({ name, view, rev, workspace: policy.workspace(ws) })),
    ),
  );
  server.registerTool(
    'set_policy',
    {
      title: 'Replace policy',
      description:
        'Replace the whole policy of a running sandbox with YAML or JSON text and wait for the sandbox to load it. Only network sections take effect on a running sandbox; filesystem, Landlock and process settings need a new sandbox.',
      inputSchema: {
        name: sandboxName,
        policy: z.string().min(2).max(200_000),
        wait: z.boolean().default(true),
        timeout_seconds: z.number().int().min(5).max(600).optional(),
        workspace,
      },
    },
    guarded(
      'set_policy',
      async ({ name, policy: body, wait, timeout_seconds, workspace: ws }) => {
        policy.policyChanges();
        const scope = policy.workspace(ws);
        await manageable(name, scope);
        const output = await ctx.driver.setPolicy(name, body, {
          wait,
          timeoutSeconds: timeout_seconds,
          workspace: scope,
        });
        return text({ name, output, waited: wait });
      },
      true,
    ),
  );
  server.registerTool(
    'update_policy_rules',
    {
      title: 'Update network rules',
      description:
        'Incrementally add or remove network rules on a running sandbox. Endpoints use host:port[:access[:protocol[:enforcement]]], for example api.github.com:443:read-only:rest:enforce; L7 allow/deny rules need rule_name and the complete binaries list. dry_run previews the merged policy.',
      inputSchema: {
        name: sandboxName,
        add_endpoints: z.array(cliValue(500)).max(50).optional(),
        remove_endpoints: z.array(cliValue(500)).max(50).optional(),
        add_allow: z.array(cliValue(500)).max(50).optional(),
        add_deny: z.array(cliValue(500)).max(50).optional(),
        remove_rules: z.array(cliValue(200)).max(50).optional(),
        binaries: z
          .array(z.string().regex(/^\/[^\0\s]{1,1023}$/))
          .max(50)
          .optional(),
        rule_name: cliValue(200).optional(),
        any_binary: z.boolean().optional(),
        dry_run: z.boolean().optional(),
        wait: z.boolean().default(true),
        timeout_seconds: z.number().int().min(5).max(600).optional(),
        workspace,
      },
    },
    guarded(
      'update_policy_rules',
      async (input) => {
        if (!input.dry_run) policy.policyChanges();
        const scope = policy.workspace(input.workspace);
        await manageable(input.name, scope);
        const output = await ctx.driver.updatePolicy(
          input.name,
          {
            addEndpoints: input.add_endpoints,
            removeEndpoints: input.remove_endpoints,
            addAllow: input.add_allow,
            addDeny: input.add_deny,
            removeRules: input.remove_rules,
            binaries: input.binaries,
            ruleName: input.rule_name,
            anyBinary: input.any_binary,
            dryRun: input.dry_run,
          },
          { wait: input.wait, timeoutSeconds: input.timeout_seconds, workspace: scope },
        );
        return text({ name: input.name, output, dry_run: Boolean(input.dry_run) });
      },
      true,
    ),
  );
  server.registerTool(
    'list_rule_proposals',
    {
      title: 'Rule proposals',
      description:
        'Network rules the policy advisor drafted from denied requests, with confidence, rationale and prover result. Pending ones wait for approval.',
      inputSchema: {
        name: sandboxName,
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        workspace,
      },
    },
    guarded('list_rule_proposals', async ({ name, status, workspace: ws }) => {
      const result = await ctx.driver.listRules(name, { status, workspace: policy.workspace(ws) });
      return text({ name, proposals: result.proposals, text: cap(result.text).text });
    }),
  );
  server.registerTool(
    'approve_rule',
    {
      title: 'Approve a rule proposal',
      description: 'Approve a drafted network rule; it hot-reloads into the running sandbox.',
      inputSchema: { name: sandboxName, chunk_id: cliValue(200), workspace },
    },
    guarded(
      'approve_rule',
      async ({ name, chunk_id, workspace: ws }) => {
        policy.policyChanges();
        const scope = policy.workspace(ws);
        await manageable(name, scope);
        return text({ name, chunk_id, output: await ctx.driver.approveRule(name, chunk_id, scope) });
      },
      true,
    ),
  );
  server.registerTool(
    'reject_rule',
    {
      title: 'Reject a rule proposal',
      description: 'Reject a drafted network rule with a reason the agent can read.',
      inputSchema: {
        name: sandboxName,
        chunk_id: cliValue(200),
        reason: z.string().max(500).optional(),
        workspace,
      },
    },
    guarded(
      'reject_rule',
      async ({ name, chunk_id, reason, workspace: ws }) => {
        policy.policyChanges();
        const scope = policy.workspace(ws);
        await manageable(name, scope);
        return text({ name, chunk_id, output: await ctx.driver.rejectRule(name, chunk_id, reason, scope) });
      },
      true,
    ),
  );
  server.registerTool(
    'get_global_policy',
    {
      title: 'Global policy',
      description:
        'The gateway-global policy, when an administrator applied one. It overrides every sandbox policy; this connector never changes it.',
      inputSchema: { view: z.enum(['base', 'full']).default('full') },
    },
    guarded('get_global_policy', async ({ view }) =>
      text(await ctx.driver.getPolicy({ global: true, view })),
    ),
  );
}
