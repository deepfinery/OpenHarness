/** Typed host operations. No caller-controlled executable, shell fragment or service name. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, lstat, writeFile, unlink } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditLog } from '@openharness/connector-core';
const exec = promisify(execFile);
export const gpuActions = ['gpu_reset', 'restart_fabric_manager', 'reboot'] as const;
export const inspectCommands: Record<string, string[][]> = {
  summary: [
    ['nvidia-smi', '-q'],
    ['nvidia-smi', 'topo', '-m'],
  ],
  nvlink: [
    ['nvidia-smi', 'nvlink', '--status'],
    ['dcgmi', 'nvlink', '--link-status'],
  ],
  dcgm: [
    ['dcgmi', 'discovery', '--list'],
    ['dcgmi', 'health', '--check'],
  ],
  logs: [
    ['journalctl', '-k', '--since', '-10min', '-n', '150', '--no-pager'],
    ['journalctl', '-u', 'nvidia-fabricmanager', '--since', '-10min', '-n', '100', '--no-pager'],
  ],
};
export function remediationCommand(action: (typeof gpuActions)[number], gpu: number) {
  if (action === 'gpu_reset') return ['nvidia-smi', '--gpu-reset', '-i', String(gpu)];
  if (action === 'restart_fabric_manager') return ['systemctl', 'restart', 'nvidia-fabricmanager'];
  return ['systemctl', 'reboot'];
}
export type HostRunner = (argv: string[]) => Promise<string>;
export const hostRun: HostRunner = async (argv) => {
  const { stdout, stderr } = await exec(
    'nsenter',
    ['--target', '1', '--mount', '--pid', '--net', '--uts', '--ipc', '--root', '--wd=/', '--', ...argv],
    {
      timeout: 30000,
      maxBuffer: 96000,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
    },
  );
  return (stdout + stderr).slice(0, 96000);
};
let remediationBusy = false;
export async function remediateHost(
  args: { action: (typeof gpuActions)[number]; gpu: number },
  options: {
    run: HostRunner;
    stateDir: string;
    actions: string[];
    now?: number;
  },
) {
  if (remediationBusy) throw new Error('A remediation is already running');
  remediationBusy = true;
  try {
    if (!options.actions.includes(args.action)) throw new Error('Action is not enabled by the node operator');
    const now = options.now ?? Date.now();
    // The scheduler/drain controller must create a root-owned, non-writable marker after excluding the node from jobs.
    // The model cannot create this marker: the cluster exposes only typed GPU tools, with no file or shell access.
    const marker = `${options.stateDir}/drained`;
    const info = await lstat(marker);
    if (
      !info.isFile() ||
      info.mtimeMs > now + 30000 ||
      info.uid !== 0 ||
      info.mode & 0o022 ||
      now - info.mtimeMs > 300000
    )
      throw new Error('A fresh root-owned drained marker is required (valid for five minutes)');
    const jobs = await options.run([
      'nvidia-smi',
      '--query-compute-apps=pid',
      '--format=csv,noheader,nounits',
    ]);
    if (jobs.trim()) throw new Error('GPU workloads are still running; refusing disruption');
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    // Exclusive persistent reservation survives reconnect/restart; failures consume the cooldown too.
    const lock = `${options.stateDir}/remediation.lock`;
    const previous = await readFile(lock, 'utf8').catch(() => '');
    if (previous) {
      const prior = JSON.parse(previous);
      if (now - prior.startedAt < 600000 || info.mtimeMs <= prior.startedAt)
        throw new Error('Node cooldown active or drain authorization has not been renewed');
      await unlink(lock);
    }
    const handle = await open(lock, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ ...args, startedAt: now }));
    await handle.sync();
    await handle.close();
    const result = await options.run(remediationCommand(args.action, args.gpu));
    await writeFile(
      `${options.stateDir}/last-result.json`,
      JSON.stringify({ ...args, result, finishedAt: Date.now() }),
      { mode: 0o600 },
    );
    return result;
  } finally {
    remediationBusy = false;
  }
}
export function registerGpuTools(
  server: McpServer,
  audit: AuditLog,
  options: { enabled: boolean; actions: string[]; stateDir: string; run?: HostRunner },
) {
  if (!options.enabled) return;
  const run = options.run ?? hostRun;
  const wrap = (tool: string, fn: (args: any) => Promise<string>) => async (args: any) => {
    const start = Date.now();
    try {
      const output = await fn(args);
      await audit.write({ tool, arguments: args, outcome: 'ok', duration_ms: Date.now() - start });
      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await audit.write({
        tool,
        arguments: args,
        outcome: 'error',
        error: message,
        duration_ms: Date.now() - start,
      });
      return { content: [{ type: 'text' as const, text: message }], isError: true };
    }
  };
  server.registerTool(
    'gpu_inspect',
    {
      description:
        'Read host NVIDIA GPU, NVLink, DCGM and kernel/Fabric Manager logs. Missing utilities return explicit errors.',
      inputSchema: { section: z.enum(['summary', 'nvlink', 'dcgm', 'logs']).default('summary') },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    wrap('gpu_inspect', async ({ section }) => {
      const results = [];
      for (const command of inspectCommands[section]) {
        try {
          results.push({ command, output: await run(command) });
        } catch (error) {
          results.push({ command, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return JSON.stringify(results);
    }),
  );
  server.registerTool(
    'gpu_remediate',
    {
      description:
        'Disruptive host remediation. Requires operator enablement, drained node, zero GPU jobs, gateway authorization and cooldown. GPU reset support depends on hardware; never escalate to additional nodes or GPUs on failure.',
      inputSchema: {
        action: z.enum(gpuActions),
        gpu: z.number().int().min(0).max(255).default(0),
        reason: z.string().min(10).max(2000),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrap('gpu_remediate', (args) =>
      remediateHost(args, { run, stateDir: options.stateDir, actions: options.actions }),
    ),
  );
}
