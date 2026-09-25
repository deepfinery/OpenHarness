// Local policy enforced inside every tool: the connector protects its host even from a compromised gateway.
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

export type PolicyOptions = {
  /** Directory the connector may read and write. Resolved with realpath; must exist. */
  workDir: string;
  /** Program names (basename or absolute path) that run_command may execute. `*` allows any program. Empty denies all. */
  allowCommands: string[];
  /** Program names that are always refused, even when `*` is allowed. */
  denyCommands: string[];
  /** Allow `run_command` to go through a shell string. Off by default: argv only. */
  allowShell: boolean;
  maxOutputBytes: number;
  commandTimeoutMs: number;
  /** Disables write_file and other mutating file operations. */
  readOnly: boolean;
};
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}
export const defaultDenyCommands = [
  'rm',
  'dd',
  'mkfs',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'sudo',
  'su',
  'doas',
  'mount',
  'umount',
];

export class Policy {
  readonly workDir: string;
  private constructor(
    private readonly options: PolicyOptions,
    workDir: string,
  ) {
    this.workDir = workDir;
  }
  static async create(options: PolicyOptions) {
    const workDir = await realpath(options.workDir).catch(() => {
      throw new PolicyError(`work directory does not exist: ${options.workDir}`);
    });
    return new Policy(options, workDir);
  }
  get readOnly() {
    return this.options.readOnly;
  }
  get maxOutputBytes() {
    return this.options.maxOutputBytes;
  }
  /**
   * Resolves `input` (absolute or relative to the work directory) and proves it stays inside the jail after
   * following symlinks. For writes, the deepest existing ancestor is checked so a new file cannot be created
   * through a symlinked parent that points outside.
   */
  async resolvePath(input: string, { write = false }: { write?: boolean } = {}) {
    if (write && this.options.readOnly) throw new PolicyError('connector is in read-only mode');
    if (typeof input !== 'string' || input.includes('\0')) throw new PolicyError('invalid path');
    const candidate = isAbsolute(input) ? resolve(input) : resolve(this.workDir, input);
    let existing = candidate;
    const missing: string[] = [];
    for (;;) {
      try {
        await stat(existing);
        break;
      } catch {
        missing.unshift(basename(existing));
        const parent = dirname(existing);
        if (parent === existing) throw new PolicyError('path has no existing ancestor');
        existing = parent;
      }
    }
    const real = await realpath(existing);
    const finalPath = missing.length ? resolve(real, ...missing) : real;
    if (finalPath !== this.workDir && !finalPath.startsWith(this.workDir + sep))
      throw new PolicyError(`path is outside the work directory: ${input}`);
    if (missing.some((part) => part === '..'))
      throw new PolicyError(`path is outside the work directory: ${input}`);
    return finalPath;
  }
  /** Checks argv[0] against the allow-list and deny-list. Programs are compared by basename and by full path. */
  checkCommand(argv: readonly string[]) {
    if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string'))
      throw new PolicyError('argv must be a non-empty list of strings');
    const program = argv[0];
    const name = basename(program);
    const matches = (list: string[]) => list.some((entry) => entry === program || entry === name);
    if (matches(this.options.denyCommands)) throw new PolicyError(`command is denied by policy: ${name}`);
    if (!this.options.allowCommands.includes('*') && !matches(this.options.allowCommands))
      throw new PolicyError(`command is not on the allow-list: ${name}`);
    return { program, name };
  }
  checkShell() {
    if (!this.options.allowShell) throw new PolicyError('shell commands are disabled; pass argv instead');
  }
  timeoutMs(requestedSeconds?: number) {
    const requested = requestedSeconds ? requestedSeconds * 1000 : this.options.commandTimeoutMs;
    return Math.min(requested, this.options.commandTimeoutMs);
  }
  /** Truncates output to the byte cap, keeping the beginning and a marker. */
  capOutput(text: string, limit = this.options.maxOutputBytes) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= limit) return { text, truncated: false, bytes };
    const buf = Buffer.from(text, 'utf8').subarray(0, limit);
    return { text: buf.toString('utf8') + `\n…[truncated ${bytes - limit} bytes]`, truncated: true, bytes };
  }
}
