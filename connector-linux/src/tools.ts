// The Linux/container tool set. Every tool applies the local policy itself; the gateway's allow-list is a second layer.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, appendFile, writeFile, open } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { IdempotencyCache, PolicyError, type AuditLog, type Policy } from '@openharness/connector-core';

export const linuxToolNames = [
  'run_command',
  'read_file',
  'write_file',
  'list_dir',
  'search_files',
  'system_info',
  'process_list',
] as const;
type ToolContext = { policy: Policy; audit: AuditLog; hostname: string };
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  structuredContent:
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : { value },
});
const failure = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});
const idempotencyKey = (extra: Extra) => {
  const key = (extra._meta as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  return typeof key === 'string' ? key : undefined;
};

/** Wraps a tool body with policy error handling, audit logging and idempotent replay. */
function guarded<A>(
  ctx: ToolContext,
  tool: string,
  body: (args: A) => Promise<CallToolResult>,
  cache?: IdempotencyCache<CallToolResult>,
) {
  return async (args: A, extra: Extra): Promise<CallToolResult> => {
    const key = idempotencyKey(extra);
    const replay = cache?.get(key);
    if (replay) {
      await ctx.audit.write({ tool, outcome: 'ok', duration_ms: 0, idempotency_key: key, replayed: true });
      return replay;
    }
    const started = Date.now();
    try {
      const result = await body(args);
      cache?.set(key, result);
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
        outcome: error instanceof PolicyError ? 'denied' : /timed out/.test(message) ? 'timeout' : 'error',
        duration_ms: Date.now() - started,
        arguments: args,
        error: message,
        idempotency_key: key,
      });
      return failure(message);
    }
  };
}
function runProcess(
  argv: string[],
  {
    cwd,
    timeoutMs,
    maxBytes,
    stdin,
    env,
  }: { cwd: string; timeoutMs: number; maxBytes: number; stdin?: string; env: NodeJS.ProcessEnv },
) {
  return new Promise<{
    exit_code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timed_out: boolean;
  }>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
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
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
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
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
const globToRegExp = (glob: string) =>
  new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );

export function registerLinuxTools(server: McpServer, ctx: ToolContext) {
  const { policy } = ctx;
  const commandCache = new IdempotencyCache<CallToolResult>();
  const writeCache = new IdempotencyCache<CallToolResult>();
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
  };

  server.registerTool(
    'run_command',
    {
      title: 'Run a command',
      description:
        'Runs a program on this machine without a shell. Provide argv as a list (program first). Only allow-listed programs run; output is capped and the command is killed at the timeout.',
      inputSchema: {
        argv: z
          .array(z.string().min(1))
          .min(1)
          .max(64)
          .describe('Program and arguments, e.g. ["ls", "-la", "src"]'),
        cwd: z.string().optional().describe('Working directory inside the work directory'),
        timeout_seconds: z.number().int().min(1).max(3600).optional(),
        stdin: z.string().max(200_000).optional(),
      },
    },
    guarded(
      ctx,
      'run_command',
      async ({ argv, cwd, timeout_seconds, stdin }) => {
        policy.checkCommand(argv);
        const dir = await policy.resolvePath(cwd ?? '.');
        const timeoutMs = policy.timeoutMs(timeout_seconds);
        const started = Date.now();
        const result = await runProcess(argv, {
          cwd: dir,
          timeoutMs,
          maxBytes: policy.maxOutputBytes,
          stdin,
          env: safeEnv,
        });
        const duration_ms = Date.now() - started;
        if (result.timed_out) throw new Error(`command timed out after ${Math.round(timeoutMs / 1000)} s`);
        const summary = { ...result, duration_ms, argv };
        return {
          content: [
            {
              type: 'text',
              text: [
                result.stdout,
                result.stderr && `[stderr]\n${result.stderr}`,
                `[exit ${result.exit_code ?? result.signal}]`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
          structuredContent: summary,
          isError: result.exit_code !== 0,
        };
      },
      commandCache,
    ),
  );
  server.registerTool(
    'read_file',
    {
      title: 'Read a file',
      description:
        'Reads a UTF-8 text file inside the work directory. Large files are truncated to the output cap.',
      inputSchema: { path: z.string().min(1), max_bytes: z.number().int().min(1).optional() },
    },
    guarded(ctx, 'read_file', async ({ path, max_bytes }) => {
      const target = await policy.resolvePath(path);
      const info = await stat(target);
      if (!info.isFile()) throw new PolicyError('not a regular file');
      const limit = Math.min(max_bytes ?? policy.maxOutputBytes, policy.maxOutputBytes);
      const handle = await open(target, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(limit, info.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return text({
          path: target,
          size: info.size,
          truncated: info.size > bytesRead,
          content: buffer.subarray(0, bytesRead).toString('utf8'),
        });
      } finally {
        await handle.close();
      }
    }),
  );
  server.registerTool(
    'write_file',
    {
      title: 'Write a file',
      description: 'Writes UTF-8 text to a file inside the work directory. Disabled in read-only mode.',
      inputSchema: {
        path: z.string().min(1),
        content: z.string().max(5_000_000),
        mode: z
          .enum(['overwrite', 'append', 'create'])
          .default('overwrite')
          .describe('create fails if the file exists'),
      },
    },
    guarded(
      ctx,
      'write_file',
      async ({ path, content, mode }) => {
        const target = await policy.resolvePath(path, { write: true });
        await mkdir(join(target, '..'), { recursive: true });
        if (mode === 'append') await appendFile(target, content);
        else await writeFile(target, content, { flag: mode === 'create' ? 'wx' : 'w' });
        return text({ path: target, bytes: Buffer.byteLength(content, 'utf8'), mode });
      },
      writeCache,
    ),
  );
  server.registerTool(
    'list_dir',
    {
      title: 'List a directory',
      description:
        'Lists entries (name, type, size, modified) up to a small depth inside the work directory.',
      inputSchema: { path: z.string().default('.'), depth: z.number().int().min(1).max(4).default(1) },
    },
    guarded(ctx, 'list_dir', async ({ path, depth }) => {
      const root = await policy.resolvePath(path);
      const entries: { path: string; type: string; size: number; modified: string }[] = [];
      const walk = async (dir: string, level: number) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entries.length >= 2000) return;
          const full = join(dir, entry.name);
          const info = await stat(full).catch(() => null);
          entries.push({
            path: relative(root, full) || '.',
            type: entry.isDirectory()
              ? 'dir'
              : entry.isSymbolicLink()
                ? 'symlink'
                : entry.isFile()
                  ? 'file'
                  : 'other',
            size: info?.size ?? 0,
            modified: info?.mtime.toISOString() ?? '',
          });
          if (entry.isDirectory() && !entry.isSymbolicLink() && level < depth) await walk(full, level + 1);
        }
      };
      await walk(root, 1);
      return text({ path: root, entries, truncated: entries.length >= 2000 });
    }),
  );
  server.registerTool(
    'search_files',
    {
      title: 'Search files',
      description:
        'Finds files by name glob and/or text content (regular expression) under a directory inside the work directory.',
      inputSchema: {
        path: z.string().default('.'),
        name_pattern: z.string().max(200).optional().describe('Glob on the file name, e.g. *.log'),
        content: z.string().max(500).optional().describe('Regular expression matched against file text'),
        max_results: z.number().int().min(1).max(500).default(100),
      },
    },
    guarded(ctx, 'search_files', async ({ path, name_pattern, content, max_results }) => {
      const root = await policy.resolvePath(path);
      const nameRe = name_pattern ? globToRegExp(name_pattern) : undefined;
      const contentRe = content ? new RegExp(content, 'i') : undefined;
      const matches: { path: string; line?: number; text?: string }[] = [];
      let visited = 0;
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (matches.length >= max_results || visited > 20_000) return;
          const full = join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            await walk(full);
            continue;
          }
          if (!entry.isFile()) continue;
          visited++;
          if (nameRe && !nameRe.test(entry.name)) continue;
          if (!contentRe) {
            matches.push({ path: relative(root, full) });
            continue;
          }
          const info = await stat(full).catch(() => null);
          if (!info || info.size > 1_000_000) continue;
          const lines = (await readFile(full, 'utf8').catch(() => '')).split('\n');
          for (const [i, line] of lines.entries()) {
            if (contentRe.test(line)) {
              matches.push({ path: relative(root, full), line: i + 1, text: line.slice(0, 300) });
              if (matches.length >= max_results) break;
            }
          }
        }
      };
      await walk(root);
      return text({ path: root, matches, files_visited: visited, truncated: matches.length >= max_results });
    }),
  );
  server.registerTool(
    'system_info',
    {
      title: 'System information',
      description: 'Hostname, OS, CPU, memory, load and uptime of this machine.',
      inputSchema: {},
    },
    guarded(ctx, 'system_info', async () =>
      text({
        hostname: ctx.hostname,
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpus: os.cpus().length,
        cpu_model: os.cpus()[0]?.model,
        memory_total_bytes: os.totalmem(),
        memory_free_bytes: os.freemem(),
        load_average: os.loadavg(),
        uptime_seconds: os.uptime(),
        user: os.userInfo().username,
        work_dir: policy.workDir,
        read_only: policy.readOnly,
        node: process.version,
      }),
    ),
  );
  server.registerTool(
    'process_list',
    {
      title: 'List processes',
      description: 'Running processes with pid, parent, user, state and memory (from /proc).',
      inputSchema: {},
    },
    guarded(ctx, 'process_list', async () => {
      const processes: {
        pid: number;
        ppid?: number;
        name: string;
        state?: string;
        rss_kb?: number;
        uid?: number;
      }[] = [];
      const entries = await readdir('/proc').catch(() => [] as string[]);
      for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        const status = await readFile(`/proc/${name}/status`, 'utf8').catch(() => '');
        if (!status) continue;
        const field = (key: string) => status.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
        processes.push({
          pid: Number(name),
          ppid: Number(field('PPid') ?? 0) || undefined,
          name: field('Name') ?? '',
          state: field('State'),
          rss_kb: Number(field('VmRSS')?.split(/\s+/)[0]) || undefined,
          uid: Number(field('Uid')?.split(/\s+/)[0]) || undefined,
        });
        if (processes.length >= 2000) break;
      }
      if (!processes.length)
        throw new Error('process information is unavailable on this platform (/proc missing)');
      return text({ count: processes.length, processes });
    }),
  );
}
export const pathSeparator = sep;
