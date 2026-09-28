// OpenShell-specific settings: the `openshell` object in the connector config file plus environment overrides.
// The shared connector settings (gateway, device, token, caps) come from connector-core unchanged.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { workspacePattern } from './openshell.js';

export const openshellSettingsSchema = z.object({
  /** Path or name of the OpenShell CLI binary. */
  bin: z.string().min(1).max(1024).default('openshell'),
  /** Registered gateway name (`openshell gateway list`); the CLI's active gateway when omitted. */
  gateway: z.string().max(200).optional(),
  /** Direct gateway endpoint URL; bypasses stored gateway metadata. */
  gateway_endpoint: z.string().url().optional(),
  /** Workspace used unless a tool call names another allowed one. */
  workspace: z.string().regex(workspacePattern).default('default'),
  /** Additional workspaces tool calls may target. The default workspace is always allowed. */
  workspaces: z.array(z.string().regex(workspacePattern)).max(100).default([]),
  /** Permit set_policy, update_policy_rules, approve_rule and reject_rule. */
  allow_policy_changes: z.boolean().default(true),
  /** Permit create_sandbox, delete_sandbox, start_sandbox and stop_sandbox. */
  allow_sandbox_lifecycle: z.boolean().default(true),
  /** Permit exec_in_sandbox. */
  allow_exec: z.boolean().default(true),
  /** Image references (or prefixes) create_sandbox may use. Empty allows any image the gateway accepts. */
  allowed_images: z.array(z.string().min(1).max(500)).max(200).default([]),
  /** Upper bound on sandboxes this connector created and still exist. */
  max_sandboxes: z.number().int().min(0).max(10000).default(20),
  /** When false, only sandboxes labelled by this connector can be changed, executed in, or re-policied. */
  manage_all_sandboxes: z.boolean().default(true),
  /** Deadline for one CLI invocation; long-running operations (create, exec) extend it themselves. */
  cli_timeout_seconds: z.number().int().min(5).max(3600).default(120),
});
export type OpenShellSettings = z.infer<typeof openshellSettingsSchema>;

const list = (value?: string) =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
const bool = (value?: string) => (value === undefined ? undefined : /^(1|true|yes|on)$/i.test(value));
const num = (value?: string) => (value === undefined || value === '' ? undefined : Number(value));
const strip = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function openshellSettingsFromEnv(env: NodeJS.ProcessEnv) {
  return strip({
    bin: env.OPENSHELL_BIN,
    gateway: env.OPENSHELL_GATEWAY,
    gateway_endpoint: env.OPENSHELL_GATEWAY_ENDPOINT,
    workspace: env.OPENSHELL_WORKSPACE,
    workspaces: list(env.OPENSHELL_WORKSPACES),
    allow_policy_changes: bool(env.OPENSHELL_ALLOW_POLICY_CHANGES),
    allow_sandbox_lifecycle: bool(env.OPENSHELL_ALLOW_SANDBOX_LIFECYCLE),
    allow_exec: bool(env.OPENSHELL_ALLOW_EXEC),
    allowed_images: list(env.OPENSHELL_ALLOWED_IMAGES),
    max_sandboxes: num(env.OPENSHELL_MAX_SANDBOXES),
    manage_all_sandboxes: bool(env.OPENSHELL_MANAGE_ALL_SANDBOXES),
    cli_timeout_seconds: num(env.OPENSHELL_CLI_TIMEOUT_SECONDS),
  });
}
export async function loadOpenShellSettings({
  path,
  env = process.env,
}: {
  path?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenShellSettings> {
  let fromFile: Record<string, unknown> = {};
  if (path) {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { openshell?: unknown };
    if (parsed && typeof parsed === 'object' && parsed.openshell && typeof parsed.openshell === 'object')
      fromFile = parsed.openshell as Record<string, unknown>;
  }
  return openshellSettingsSchema.parse({ ...fromFile, ...openshellSettingsFromEnv(env) });
}
