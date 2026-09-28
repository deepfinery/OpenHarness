// Driver over the pinned OpenShell CLI. Every call is an argv array (never a shell string), reads JSON where the
// CLI offers it, and is bounded by a timeout and an output cap. The interface lets an SDK-based driver replace the
// CLI later without touching the tools.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The OpenShell release this connector was written and verified against. */
export const OPENSHELL_PINNED_VERSION = '0.1.2';
export const sandboxNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const workspacePattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Values handed to the CLI as flag arguments must never look like a flag themselves. */
export const cliValuePattern = /^[A-Za-z0-9_][^\s\0]{0,1023}$/;
export const durationPattern = /^\d{1,6}(s|m|h)$/;

export type CliRun = {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timed_out: boolean;
};
export class OpenShellError extends Error {
  constructor(
    message: string,
    readonly run?: CliRun,
  ) {
    super(message);
    this.name = 'OpenShellError';
  }
}
export type OpenShellCliOptions = {
  bin: string;
  gateway?: string;
  gatewayEndpoint?: string;
  workspace: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
};
export type SandboxCreateInput = {
  name?: string;
  image?: string;
  template?: string;
  command?: string[];
  policy?: string;
  labels?: Record<string, string>;
  providers?: string[];
  cpu?: string;
  memory?: string;
  env?: Record<string, string>;
  noKeep?: boolean;
  workspace?: string;
};
export type ExecInput = {
  argv: string[];
  workdir?: string;
  timeoutSeconds?: number;
  env?: Record<string, string>;
  workspace?: string;
};
export type PolicyTarget = { name?: string; global?: boolean; workspace?: string };
export type PolicyPatch = {
  addEndpoints?: string[];
  removeEndpoints?: string[];
  addAllow?: string[];
  addDeny?: string[];
  removeRules?: string[];
  binaries?: string[];
  ruleName?: string;
  anyBinary?: boolean;
  dryRun?: boolean;
};
export type RuleProposal = {
  id: string;
  status: string;
  rule_name?: string;
  binary?: string;
  confidence?: number;
  rationale?: string;
  security_notes?: string;
  prover?: string;
  application_error?: string;
  candidate_policy_hash?: string;
  endpoints?: string;
  binaries?: string;
  hits?: string;
};
export interface OpenShellDriver {
  version(): Promise<string>;
  status(): Promise<unknown>;
  gatewayInfo(): Promise<unknown>;
  listWorkspaces(): Promise<unknown[]>;
  listSandboxes(options?: {
    selector?: string;
    workspace?: string;
  }): Promise<{ sandboxes: Record<string, unknown>[]; next_page_token: string }>;
  getSandbox(name: string, workspace?: string): Promise<Record<string, unknown>>;
  createSandbox(input: SandboxCreateInput): Promise<unknown>;
  deleteSandbox(name: string, workspace?: string): Promise<string>;
  startSandbox(name: string, workspace?: string): Promise<string>;
  stopSandbox(name: string, workspace?: string): Promise<string>;
  exec(name: string, input: ExecInput): Promise<CliRun>;
  logs(
    name: string,
    options: { since?: string; source?: string; lines?: number; level?: string; workspace?: string },
  ): Promise<string>;
  listPolicyRevisions(target: PolicyTarget): Promise<unknown[]>;
  getPolicy(target: PolicyTarget & { view: 'base' | 'full'; rev?: number }): Promise<unknown>;
  setPolicy(
    name: string,
    policy: string,
    options: { wait?: boolean; timeoutSeconds?: number; workspace?: string },
  ): Promise<string>;
  updatePolicy(
    name: string,
    patch: PolicyPatch,
    options: { wait?: boolean; timeoutSeconds?: number; workspace?: string },
  ): Promise<string>;
  listRules(
    name: string,
    options: { status?: string; workspace?: string },
  ): Promise<{ text: string; proposals: RuleProposal[] }>;
  approveRule(name: string, chunkId: string, workspace?: string): Promise<string>;
  rejectRule(name: string, chunkId: string, reason?: string, workspace?: string): Promise<string>;
}

/** Picks the array out of a CLI collection response: a bare array, or an envelope `{ <items>: [], next_page_token }`. */
export function collectionItems(value: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object[key])) return object[key] as Record<string, unknown>[];
    const first = Object.values(object).find((v) => Array.isArray(v));
    if (first) return first as Record<string, unknown>[];
  }
  return [];
}
/** Parses the human-readable `openshell rule get` listing into structured proposals. */
export function parseRuleListing(text: string): RuleProposal[] {
  const keys: Record<string, keyof RuleProposal> = {
    Chunk: 'id',
    Status: 'status',
    Rule: 'rule_name',
    Binary: 'binary',
    Rationale: 'rationale',
    Security: 'security_notes',
    Prover: 'prover',
    Application: 'application_error',
    Candidate: 'candidate_policy_hash',
    Endpoints: 'endpoints',
    Binaries: 'binaries',
    Hits: 'hits',
  };
  const proposals: RuleProposal[] = [];
  let current: Partial<RuleProposal> | undefined;
  const flush = () => {
    if (current?.id) proposals.push({ status: 'unknown', ...current } as RuleProposal);
    current = undefined;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
    if (!line) {
      flush();
      continue;
    }
    const match = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, label, value] = match;
    if (label === 'Chunk') {
      flush();
      current = { id: value.trim() };
      continue;
    }
    if (!current) continue;
    if (label === 'Confidence') {
      const number = Number.parseFloat(value);
      if (!Number.isNaN(number)) current.confidence = number;
      continue;
    }
    const key = keys[label];
    if (key) (current as Record<string, unknown>)[key] = value.trim();
  }
  flush();
  return proposals;
}

export class OpenShellCli implements OpenShellDriver {
  constructor(private readonly options: OpenShellCliOptions) {}
  private globalFlags(workspace?: string) {
    const flags = ['--color', 'never', '--workspace', workspace ?? this.options.workspace];
    if (this.options.gateway) flags.push('-g', this.options.gateway);
    if (this.options.gatewayEndpoint) flags.push('--gateway-endpoint', this.options.gatewayEndpoint);
    return flags;
  }
  /** Runs the CLI with argv only. Never inherits an interactive terminal; stdin is closed unless supplied. */
  run(
    args: string[],
    { stdin, timeoutMs, workspace }: { stdin?: string; timeoutMs?: number; workspace?: string } = {},
  ): Promise<CliRun> {
    const limit = timeoutMs ?? this.options.timeoutMs;
    const maxBytes = this.options.maxOutputBytes;
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.bin, [...this.globalFlags(workspace), ...args], {
        env: {
          ...(this.options.env ?? process.env),
          NO_COLOR: '1',
          OPENSHELL_COLOR: 'never',
          OPENSHELL_NO_BROWSER: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      let out = Buffer.alloc(0),
        err = Buffer.alloc(0),
        truncated = false,
        timedOut = false;
      const collect = (chunk: Buffer, which: 'out' | 'err') => {
        const current = which === 'out' ? out : err;
        if (current.length >= maxBytes) {
          truncated = true;
          return;
        }
        const next = Buffer.concat([current, chunk]).subarray(0, maxBytes);
        if (next.length < current.length + chunk.length) truncated = true;
        if (which === 'out') out = next;
        else err = next;
      };
      child.stdout.on('data', (c: Buffer) => collect(c, 'out'));
      child.stderr.on('data', (c: Buffer) => collect(c, 'err'));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, limit);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new OpenShellError(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? `The OpenShell CLI was not found at "${this.options.bin}"; install OpenShell ${OPENSHELL_PINNED_VERSION} on this machine`
              : `Could not start the OpenShell CLI: ${error.message}`,
          ),
        );
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({
          exit_code: code,
          signal,
          stdout: out.toString('utf8'),
          stderr: err.toString('utf8'),
          truncated,
          timed_out: timedOut,
        });
      });
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    });
  }
  private failure(run: CliRun, what: string) {
    const detail = (run.stderr.trim() || run.stdout.trim()).split('\n').slice(-6).join('\n');
    return new OpenShellError(
      run.timed_out
        ? `${what} timed out`
        : `${what} failed (exit ${run.exit_code ?? run.signal})${detail ? `: ${detail}` : ''}`,
      run,
    );
  }
  private async text(args: string[], what: string, options: Parameters<OpenShellCli['run']>[1] = {}) {
    const run = await this.run(args, options);
    if (run.exit_code !== 0) throw this.failure(run, what);
    return run.stdout.trim() || run.stderr.trim();
  }
  private async json<T = unknown>(
    args: string[],
    what: string,
    options: Parameters<OpenShellCli['run']>[1] = {},
  ) {
    const run = await this.run(args, options);
    if (run.exit_code !== 0) throw this.failure(run, what);
    const body = run.stdout.trim();
    const start = body.search(/[[{]/);
    try {
      return JSON.parse(start > 0 ? body.slice(start) : body) as T;
    } catch {
      throw new OpenShellError(
        `${what}: the CLI did not return JSON${run.truncated ? ' (output truncated)' : ''}`,
        run,
      );
    }
  }
  private async withPolicyFile<T>(policy: string, fn: (path: string) => Promise<T>) {
    const dir = await mkdtemp(join(tmpdir(), 'openharness-openshell-'));
    const file = join(dir, /^\s*[{[]/.test(policy) ? 'policy.json' : 'policy.yaml');
    try {
      await writeFile(file, policy, { mode: 0o600 });
      return await fn(file);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  private waitFlags(options: { wait?: boolean; timeoutSeconds?: number }) {
    return options.wait === false ? [] : ['--wait', '--timeout', String(options.timeoutSeconds ?? 60)];
  }
  async version() {
    const output = await this.text(['--version'], 'openshell --version');
    return /(\d+\.\d+\.\d+\S*)/.exec(output)?.[1] ?? output;
  }
  status() {
    return this.json(['status', '--output', 'json'], 'openshell status');
  }
  gatewayInfo() {
    return this.json(['gateway', 'info', '--output', 'json'], 'openshell gateway info');
  }
  async listWorkspaces() {
    return collectionItems(
      await this.json(['workspace', 'list', '--output', 'json'], 'openshell workspace list'),
      'workspaces',
    );
  }
  async listSandboxes({ selector, workspace }: { selector?: string; workspace?: string } = {}) {
    const value = await this.json<Record<string, unknown>>(
      ['sandbox', 'list', '--output', 'json', ...(selector ? ['--selector', selector] : [])],
      'openshell sandbox list',
      { workspace },
    );
    return {
      sandboxes: collectionItems(value, 'sandboxes'),
      next_page_token:
        value && !Array.isArray(value) && typeof value.next_page_token === 'string'
          ? value.next_page_token
          : '',
    };
  }
  getSandbox(name: string, workspace?: string) {
    return this.json<Record<string, unknown>>(
      ['sandbox', 'get', name, '--output', 'json'],
      `openshell sandbox get ${name}`,
      {
        workspace,
      },
    );
  }
  async createSandbox(input: SandboxCreateInput) {
    const args = ['sandbox', 'create', '--detach', '--no-auto-providers', '--output', 'json'];
    if (input.name) args.push('--name', input.name);
    if (input.image) args.push('--from', input.image);
    if (input.template) args.push('--template', input.template);
    if (input.cpu) args.push('--cpu', input.cpu);
    if (input.memory) args.push('--memory', input.memory);
    if (input.noKeep) args.push('--no-keep');
    for (const [key, value] of Object.entries(input.labels ?? {})) args.push('--label', `${key}=${value}`);
    for (const provider of input.providers ?? []) args.push('--provider', provider);
    for (const [key, value] of Object.entries(input.env ?? {})) args.push('--env', `${key}=${value}`);
    const create = (policyFile?: string) =>
      this.json(
        [
          ...args,
          ...(policyFile ? ['--policy', policyFile] : []),
          ...(input.command?.length ? ['--', ...input.command] : []),
        ],
        'openshell sandbox create',
        { workspace: input.workspace, timeoutMs: Math.max(this.options.timeoutMs, 300_000) },
      );
    return input.policy ? this.withPolicyFile(input.policy, create) : create();
  }
  deleteSandbox(name: string, workspace?: string) {
    return this.text(['sandbox', 'delete', name], `openshell sandbox delete ${name}`, { workspace });
  }
  startSandbox(name: string, workspace?: string) {
    return this.text(['sandbox', 'start', name], `openshell sandbox start ${name}`, {
      workspace,
      timeoutMs: Math.max(this.options.timeoutMs, 300_000),
    });
  }
  stopSandbox(name: string, workspace?: string) {
    return this.text(['sandbox', 'stop', name], `openshell sandbox stop ${name}`, { workspace });
  }
  exec(name: string, input: ExecInput) {
    const timeout = input.timeoutSeconds ?? Math.floor(this.options.timeoutMs / 1000);
    const args = [
      'sandbox',
      'exec',
      '-n',
      name,
      '--no-tty',
      '--no-login-shell',
      '--timeout',
      String(timeout),
    ];
    if (input.workdir) args.push('--workdir', input.workdir);
    for (const [key, value] of Object.entries(input.env ?? {})) args.push('--env', `${key}=${value}`);
    return this.run([...args, '--', ...input.argv], {
      workspace: input.workspace,
      timeoutMs: (timeout + 15) * 1000,
    });
  }
  logs(
    name: string,
    {
      since,
      source,
      lines,
      level,
      workspace,
    }: { since?: string; source?: string; lines?: number; level?: string; workspace?: string },
  ) {
    const args = ['logs', name, '-n', String(lines ?? 200)];
    if (since) args.push('--since', since);
    if (source) args.push('--source', source);
    if (level) args.push('--level', level);
    return this.text(args, `openshell logs ${name}`, { workspace });
  }
  private policyScope(target: PolicyTarget) {
    if (target.global) return ['--global'];
    if (!target.name)
      throw new OpenShellError('A sandbox name is required unless the global policy is requested');
    return [target.name];
  }
  async listPolicyRevisions(target: PolicyTarget) {
    return collectionItems(
      await this.json(
        ['policy', 'list', ...this.policyScope(target), '--output', 'json'],
        'openshell policy list',
        {
          workspace: target.workspace,
        },
      ),
      'revisions',
    );
  }
  getPolicy(target: PolicyTarget & { view: 'base' | 'full'; rev?: number }) {
    return this.json(
      [
        'policy',
        'get',
        ...this.policyScope(target),
        target.view === 'full' ? '--full' : '--base',
        ...(target.rev ? ['--rev', String(target.rev)] : []),
        '--output',
        'json',
      ],
      'openshell policy get',
      { workspace: target.workspace },
    );
  }
  setPolicy(
    name: string,
    policy: string,
    options: { wait?: boolean; timeoutSeconds?: number; workspace?: string },
  ) {
    return this.withPolicyFile(policy, (file) =>
      this.text(
        ['policy', 'set', name, '--policy', file, ...this.waitFlags(options)],
        `openshell policy set ${name}`,
        {
          workspace: options.workspace,
          timeoutMs: ((options.timeoutSeconds ?? 60) + 30) * 1000,
        },
      ),
    );
  }
  updatePolicy(
    name: string,
    patch: PolicyPatch,
    options: { wait?: boolean; timeoutSeconds?: number; workspace?: string },
  ) {
    const args = ['policy', 'update', name];
    for (const e of patch.addEndpoints ?? []) args.push('--add-endpoint', e);
    for (const e of patch.removeEndpoints ?? []) args.push('--remove-endpoint', e);
    for (const e of patch.addAllow ?? []) args.push('--add-allow', e);
    for (const e of patch.addDeny ?? []) args.push('--add-deny', e);
    for (const e of patch.removeRules ?? []) args.push('--remove-rule', e);
    for (const e of patch.binaries ?? []) args.push('--binary', e);
    if (patch.ruleName) args.push('--rule-name', patch.ruleName);
    if (patch.anyBinary) args.push('--any-binary');
    if (patch.dryRun) args.push('--dry-run');
    else args.push(...this.waitFlags(options));
    return this.text(args, `openshell policy update ${name}`, {
      workspace: options.workspace,
      timeoutMs: ((options.timeoutSeconds ?? 60) + 30) * 1000,
    });
  }
  async listRules(name: string, { status, workspace }: { status?: string; workspace?: string }) {
    const text = await this.text(
      ['rule', 'get', name, ...(status ? ['--status', status] : [])],
      `openshell rule get ${name}`,
      {
        workspace,
      },
    );
    return { text, proposals: parseRuleListing(text) };
  }
  approveRule(name: string, chunkId: string, workspace?: string) {
    return this.text(['rule', 'approve', name, '--chunk-id', chunkId], `openshell rule approve`, {
      workspace,
    });
  }
  rejectRule(name: string, chunkId: string, reason?: string, workspace?: string) {
    return this.text(
      ['rule', 'reject', name, '--chunk-id', chunkId, ...(reason ? ['--reason', reason] : [])],
      'openshell rule reject',
      { workspace },
    );
  }
}
