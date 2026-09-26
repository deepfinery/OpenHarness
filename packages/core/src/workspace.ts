import { createHash, randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { collection } from './db.js';
import { searchKnowledge } from './knowledge.js';
import type { ToolDefinition } from './llm.js';
import type { KnowledgeDocument } from './schema.js';
import { readStoredFile, removeFile, saveFile } from './storage.js';

/**
 * The knowledge workspace: a knowledge base that a workflow's agents use as shared working memory. Agents keep
 * their own context small and search, read and write notes here instead. Writes are append-only (every kb_write is
 * a new note), so parallel agents never overwrite each other, and each note carries its provenance.
 */
export const noteKinds = ['finding', 'decision', 'feedback', 'note'] as const;
export type NoteKind = (typeof noteKinds)[number];
/** The folder each kind of note is filed under. */
export const folderFor: Record<NoteKind | 'tool-result' | 'experience', string> = {
  finding: 'research',
  decision: 'decisions',
  feedback: 'feedback',
  note: 'notes',
  'tool-result': 'scratch',
  experience: 'experience',
};
export const cleanFolder = (folder: string) =>
  folder
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[/-]+|[/-]+$/g, '')
    .slice(0, 80);
export const noteFilename = (title: string) =>
  `${
    title
      .replace(/\.md$/i, '')
      .replace(/[\\/:*?"<>|\r\n\0]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140) || 'Note'
  }.md`;
export const notePath = (doc: Pick<KnowledgeDocument, 'folder' | 'filename'>) =>
  doc.folder ? `${doc.folder}/${doc.filename}` : doc.filename;

/** Stores a Markdown note and queues it for indexing (the dispatcher publishes queued documents). */
export async function createNote(
  ownerId: string,
  knowledgeBaseId: string,
  note: { title: string; content: string; folder?: string; meta?: Record<string, unknown>; id?: string },
) {
  const digest = note.id
    ? createHash('sha256').update(`${ownerId}:${knowledgeBaseId}:${note.id}`).digest('hex')
    : undefined;
  const _id = digest
    ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
    : randomUUID();
  if (note.id) {
    const existing = await collection<KnowledgeDocument>('documents').findOne({
      _id,
      ownerId,
      knowledgeBaseId,
    });
    if (existing) return existing;
  }
  // Concurrent retries own separate files; the deterministic document id elects the surviving record.
  const storageKey = `${ownerId}/${note.id ? randomUUID() : _id}`;
  const buffer = Buffer.from(note.content, 'utf8');
  const now = new Date();
  await saveFile(storageKey, buffer);
  const folder = note.folder ? cleanFolder(note.folder) : '';
  const doc: KnowledgeDocument = {
    _id,
    ownerId,
    knowledgeBaseId,
    filename: noteFilename(note.title),
    storageKey,
    size: buffer.length,
    kind: 'note',
    ...(folder ? { folder } : {}),
    ...(note.meta ? { meta: note.meta } : {}),
    // An empty note has nothing to index yet; it becomes searchable on its first real save.
    status: note.content.trim() ? 'queued' : 'ready',
    ...(note.content.trim() ? {} : { chunks: 0 }),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await collection<KnowledgeDocument>('documents').insertOne(doc);
  } catch (error) {
    if (note.id && (error as { code?: number }).code === 11000) {
      const existing = await collection<KnowledgeDocument>('documents').findOne({
        _id,
        ownerId,
        knowledgeBaseId,
      });
      if (existing) {
        await removeFile(storageKey);
        return existing;
      }
    }
    await removeFile(storageKey);
    throw error;
  }
  return doc;
}
/** A note written by an agent: YAML provenance, a title and the content. */
export function agentNote(input: {
  title: string;
  kind: NoteKind | 'tool-result' | 'experience';
  content: string;
  runId: string;
  agent: string;
  sources?: string[];
  confidence?: number;
  reasons?: string;
  extra?: Record<string, unknown>;
}) {
  const meta = {
    kind: input.kind,
    run_id: input.runId,
    agent: input.agent,
    ...(input.sources?.length ? { sources: input.sources } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    created: new Date().toISOString(),
    ...input.extra,
  };
  const body = [
    `# ${input.title}`,
    '',
    input.content.trim(),
    ...(input.reasons ? ['', `**Reasons:** ${input.reasons.trim()}`] : []),
  ];
  return { meta, text: `---\n${stringify(meta).trimEnd()}\n---\n\n${body.join('\n')}\n` };
}

type Scope = { ownerId: string; workspaceId?: string; readable: string[] };
const documents = () => collection<KnowledgeDocument>('documents');
/** Searches the workspace and the agent's other knowledge bases; results are short references, not whole notes. */
export async function searchNotes(
  scope: Scope,
  query: string,
  options: { folder?: string; limit?: number; excludeExperiments?: boolean } = {},
  signal?: AbortSignal,
) {
  const bases = [...new Set([...(scope.workspaceId ? [scope.workspaceId] : []), ...scope.readable])];
  const hits: {
    kb: string;
    hit: { documentId: string; title: string; content: string; chunkIndex: number };
  }[] = [];
  for (const kb of bases) {
    try {
      for (const hit of await searchKnowledge(
        scope.ownerId,
        kb,
        query,
        AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]),
        {
          folder: options.folder ? cleanFolder(options.folder) : undefined,
        },
      ))
        hits.push({ kb, hit });
    } catch {
      signal?.throwIfAborted();
    }
  }
  // Notes are durable immediately; vector indexing can lag or be unavailable.
  const recent = await documents()
    .find({
      ownerId: scope.ownerId,
      knowledgeBaseId: { $in: bases },
      kind: 'note',
      status: { $ne: 'deleting' },
      ...(options.folder ? { folder: cleanFolder(options.folder) } : {}),
    })
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  const fallback = await Promise.all(
    recent
      .filter((d) => !hits.some(({ hit }) => hit.documentId === d._id))
      .map(async (doc) => {
        const note = await readNote(scope, doc._id, 0, 8000).catch(() => undefined);
        const text = note?.content ?? '';
        return { doc, text, score: words.filter((word) => text.toLowerCase().includes(word)).length };
      }),
  );
  for (const { doc, text } of fallback.filter((item) => item.score > 0).sort((a, b) => b.score - a.score))
    hits.push({
      kb: doc.knowledgeBaseId,
      hit: { documentId: doc._id, title: doc.filename, content: text, chunkIndex: 0 },
    });
  const ids = [...new Set(hits.map((h) => h.hit.documentId))];
  const docs = new Map(
    (
      await documents()
        .find({ ownerId: scope.ownerId, _id: { $in: ids } })
        .toArray()
    ).map((d) => [d._id, d]),
  );
  return hits
    .filter(
      ({ hit }) =>
        !options.excludeExperiments ||
        !['experience', 'experiments'].includes(docs.get(hit.documentId)?.folder ?? ''),
    )
    .slice(0, options.limit ?? 6)
    .map(({ hit }) => {
      const doc = docs.get(hit.documentId);
      return {
        note_id: hit.documentId,
        path: doc ? notePath(doc) : hit.title,
        ...(doc?.meta?.kind ? { kind: doc.meta.kind } : {}),
        snippet: hit.content.slice(0, 600),
      };
    });
}
/** Reads part of a note (by characters) from the workspace or the agent's knowledge bases. */
export async function readNote(scope: Scope, noteId: string, offset = 0, limit = 4000) {
  const bases = [...new Set([...(scope.workspaceId ? [scope.workspaceId] : []), ...scope.readable])];
  const doc = await documents().findOne({
    _id: noteId,
    ownerId: scope.ownerId,
    knowledgeBaseId: { $in: bases },
    status: { $ne: 'deleting' },
  });
  if (!doc) return undefined;
  const text = (await readStoredFile(doc.storageKey)).toString('utf8');
  const start = Math.max(0, offset);
  const end = Math.min(text.length, start + Math.min(Math.max(limit, 200), 8000));
  return {
    note_id: doc._id,
    path: notePath(doc),
    content: text.slice(start, end),
    offset: start,
    total_chars: text.length,
    ...(end < text.length ? { next_offset: end } : {}),
  };
}

export const WORKSPACE_TOOLS = ['kb_search', 'kb_read', 'kb_write'] as const;
export const workspaceToolDefinitions: ToolDefinition[] = [
  {
    name: 'kb_search',
    description:
      'Search the knowledge workspace (and your knowledge bases) for notes relevant to a question. Returns short snippets with note ids; read a note with kb_read when you need more. Notes written in the last few seconds may not be searchable yet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for' },
        folder: {
          type: 'string',
          description: 'Optional folder, such as research, decisions, feedback or experience',
        },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'kb_read',
    description: 'Read part of a note by id. Use offset and limit (characters) to read long notes in pieces.',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 200, maximum: 8000 },
      },
      required: ['note_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'kb_write',
    description:
      'Record something in the knowledge workspace so later steps, other agents and future runs can use it: a finding (with sources), a decision (with its reasons), feedback, or a note. Every call creates a new note and returns its id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 150 },
        kind: { type: 'string', enum: [...noteKinds] },
        content: { type: 'string', maxLength: 20000 },
        sources: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 20 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reasons: { type: 'string', maxLength: 4000, description: 'Why, for decisions' },
        folder: { type: 'string', description: 'Optional folder; defaults to one per kind' },
      },
      required: ['title', 'kind', 'content'],
      additionalProperties: false,
    },
  },
];
export const workspaceNote =
  '\n\nYou have a knowledge workspace that this workflow shares across steps, agents and runs. Keep your own context small: search it with kb_search and read only what you need with kb_read. Record what you learn with kb_write: findings with their sources, decisions with their reasons, and feedback. Refer to notes by id instead of repeating their content.';
