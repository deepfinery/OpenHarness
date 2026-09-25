import JSZip from 'jszip';
import { parse, stringify } from 'yaml';
import { OhError } from './errors.js';

/**
 * Open Agent Format (https://openagentformat.com, v0.8) packages: an AGENTS.md manifest (YAML frontmatter plus
 * Markdown instructions), local skills as Agent Skills SKILL.md files, MCP server configs and a PACKAGE.yaml.
 */
export type Frontmatter = Record<string, unknown>;
export type Bundle = { agentsMd: string; files: Map<string, string> };

export const kebab = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'agent';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
export function parseMarkdown(text: string): { frontmatter: Frontmatter; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: {}, body: text.trim() };
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]);
  } catch (error) {
    throw new OhError(400, 'INVALID_MANIFEST', 'The manifest frontmatter is not valid YAML', {
      details: { reason: error instanceof Error ? error.message.slice(0, 300) : 'parse error' },
    });
  }
  if (frontmatter !== null && (typeof frontmatter !== 'object' || Array.isArray(frontmatter)))
    throw new OhError(400, 'INVALID_MANIFEST', 'The manifest frontmatter must be a YAML mapping');
  return { frontmatter: (frontmatter ?? {}) as Frontmatter, body: text.slice(match[0].length).trim() };
}
export const renderMarkdown = (frontmatter: Frontmatter, body: string) =>
  `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;

const MAX_ENTRIES = 500;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const TEXT_FILES = /\.(md|markdown|ya?ml|json|txt)$/i;

/** Normalizes a bundle path and refuses anything that could escape the package root. */
export function safePath(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..'))
    throw new OhError(400, 'INVALID_BUNDLE', `Unsafe path in bundle: ${path.slice(0, 200)}`);
  return normalized;
}
/**
 * Reads an OAF zip. Only text files are extracted, with limits on entry count and sizes (declared sizes are checked
 * before decompression, actual sizes after). AGENTS.md may sit at the root or in the single agent folder that
 * PACKAGE.yaml points to.
 */
export async function readZip(buffer: Buffer): Promise<Bundle> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new OhError(400, 'INVALID_BUNDLE', 'The bundle is not a valid ZIP archive');
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > MAX_ENTRIES)
    throw new OhError(413, 'PAYLOAD_TOO_LARGE', `A bundle may hold at most ${MAX_ENTRIES} files`);
  const files = new Map<string, string>();
  let total = 0;
  for (const entry of entries) {
    // JSZip strips "../" from names; the original name is checked so such bundles are refused, not renamed.
    safePath((entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name);
    const path = safePath(entry.name);
    if (!TEXT_FILES.test(path)) continue;
    const declared =
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (declared > MAX_TEXT_BYTES) throw new OhError(413, 'PAYLOAD_TOO_LARGE', `${path} is too large`);
    const text = await entry.async('string');
    total += Buffer.byteLength(text);
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES || total > MAX_TOTAL_BYTES)
      throw new OhError(413, 'PAYLOAD_TOO_LARGE', 'The bundle is too large once extracted');
    files.set(path, text);
  }
  return fromFiles(files);
}
/** Builds a bundle from uploaded files (multipart create), whose names carry their package paths. */
export function fromFiles(input: Map<string, string>): Bundle {
  const files = new Map<string, string>();
  for (const [path, text] of input) files.set(safePath(path), text);
  // AGENTS.md at the root (Open Harness export layout) or in exactly one agent folder (OAF package layout).
  let root = '';
  if (!files.has('AGENTS.md')) {
    const nested = [...files.keys()].filter((p) => /^[^/]+\/AGENTS\.md$/.test(p));
    if (nested.length !== 1)
      throw new OhError(
        400,
        'INVALID_BUNDLE',
        'The bundle needs one AGENTS.md, at its root or in one agent folder',
      );
    root = nested[0].slice(0, -'AGENTS.md'.length);
  }
  const agentsMd = files.get(`${root}AGENTS.md`)!;
  const scoped = new Map<string, string>();
  for (const [path, text] of files) if (path.startsWith(root)) scoped.set(path.slice(root.length), text);
  return { agentsMd, files: scoped };
}
export async function writeZip(files: Map<string, string>) {
  const zip = new JSZip();
  for (const [path, text] of files) zip.file(safePath(path), text);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
export const skillMarkdown = (skill: { name: string; description: string; instructions: string }) =>
  renderMarkdown({ name: skill.name, description: skill.description }, skill.instructions);
