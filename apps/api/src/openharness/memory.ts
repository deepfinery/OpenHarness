import type { Request } from 'express';
import JSZip from 'jszip';
import { z } from 'zod';
import { collection } from '../../../../packages/core/src/db.js';
import {
  blocks,
  archive,
  archiveMemory,
  searchArchive,
  blockView,
  writeBlock,
  memoryBlockSchema,
} from '../../../../packages/core/src/agentMemory.js';
import { requireAccess } from './access.js';
import { notFound, OhError } from './errors.js';
import { multipart } from './resources.js';
import { pageOf, pageQuery, type Operation, type OperationRegistry } from './operations.js';
export async function agentMemoryKey(req: Request) {
  const p = requireAccess(req, 'read');
  const id = String(req.params.agentId);
  if (req.harness) {
    if (!req.harness.nodes.some((n) => n.type === 'agent' && n.id === id)) throw notFound('Agent');
    requireAccess(req, 'read', { workflowId: req.harness._id });
    return `${req.harness._id}:${id}`;
  }
  const w = await collection('workflows').findOne({ _id: id, ownerId: p.tenantId });
  if (!w) throw notFound('Agent');
  requireAccess(req, 'read', { workflowId: id });
  return id;
}
export function memoryOperations(registry: OperationRegistry): Operation[] {
  registry.declare('memory', {
    limitations: [
      'Core memory prompt injection is capped at 12000 characters and treated as untrusted reference data',
      'At most 50 blocks per agent; archive search uses the configured vector store when an embedding provider is available, with keyword fallback',
    ],
  });
  const scope = async (req: Request) => ({
    ownerId: req.principal!.tenantId,
    agentKey: await agentMemoryKey(req),
  });
  const findBlock = async (req: Request) => {
    const s = await scope(req);
    const b = await blocks().findOne({ ...s, label: String(req.params.label) });
    if (!b) throw notFound('Memory block');
    return b;
  };
  const entry = (b: any) => ({
    id: b._id,
    content: b.content,
    metadata: b.metadata,
    created_at: b.createdAt.toISOString(),
  });
  return [
    {
      id: 'memory.get',
      provides: { domain: 'memory', operations: ['read'] },
      handler: async (req) => {
        const s = await scope(req);
        return {
          memory: {
            agent_id: String(req.params.agentId),
            blocks: (await blocks().find(s).toArray()).map(blockView),
            archive_size: await archive().countDocuments(s),
          },
        };
      },
    },
    {
      id: 'memory.listBlocks',
      handler: async (req) => ({
        blocks: (
          await blocks()
            .find(await scope(req))
            .toArray()
        ).map(blockView),
      }),
    },
    { id: 'memory.getBlock', handler: async (req) => ({ block: blockView(await findBlock(req)) }) },
    {
      id: 'memory.createBlock',
      provides: { domain: 'memory', operations: ['write'] },
      handler: async (req, res) => {
        requireAccess(req, 'manage');
        const s = await scope(req);
        res.status(201).json({ block: blockView(await writeBlock(s.ownerId, s.agentKey, req.body, true)) });
      },
    },
    {
      id: 'memory.updateBlock',
      handler: async (req) => {
        requireAccess(req, 'manage');
        const b = await findBlock(req);
        return {
          block: blockView(
            await writeBlock(b.ownerId, b.agentKey, {
              label: b.label,
              value: z.object({ value: z.string() }).parse(req.body).value,
            }),
          ),
        };
      },
    },
    {
      id: 'memory.deleteBlock',
      handler: async (req, res) => {
        requireAccess(req, 'manage');
        const b = await findBlock(req);
        if (b.read_only) throw new OhError(409, 'CONFLICT', 'Memory block is read-only');
        await blocks().deleteOne({ _id: b._id, ownerId: b.ownerId, agentKey: b.agentKey, read_only: false });
        res.status(204).end();
      },
    },
    {
      id: 'memory.getArchive',
      provides: { domain: 'memory', operations: ['archive'] },
      handler: async (req) =>
        pageOf(
          (
            await archive()
              .find(await scope(req))
              .sort({ createdAt: -1 })
              .limit(10000)
              .toArray()
          ).map(entry),
          pageQuery.parse(req.query),
        ),
    },
    {
      id: 'memory.addToArchive',
      handler: async (req, res) => {
        requireAccess(req, 'manage');
        const s = await scope(req),
          b = z
            .object({ content: z.string().min(1).max(100000), metadata: z.record(z.unknown()).default({}) })
            .parse(req.body);
        res
          .status(201)
          .json({ entry: entry(await archiveMemory(s.ownerId, s.agentKey, b.content, b.metadata)) });
      },
    },
    {
      id: 'memory.search',
      provides: { domain: 'memory', operations: ['search'] },
      handler: async (req) => {
        const s = await scope(req),
          b = z
            .object({
              query: z.string().min(1).max(1000),
              include_archive: z.boolean().default(true),
              limit: z.number().int().min(1).max(100).default(10),
            })
            .parse(req.body);
        const words = b.query.toLowerCase().split(/\s+/);
        const rows = [
          ...(await blocks().find(s).toArray()).map((x) => ({
            source: 'block',
            label: x.label,
            content: x.value,
          })),
          ...(b.include_archive
            ? (await archive().find(s).limit(10000).toArray()).map((x) => ({
                source: 'archive',
                content: x.content,
              }))
            : []),
        ];
        const keyword = rows
          .map((r) => ({
            ...r,
            relevance_score: words.filter((w) => r.content.toLowerCase().includes(w)).length / words.length,
          }))
          .filter((r) => r.relevance_score > 0);
        const semantic = b.include_archive
          ? await searchArchive(s.ownerId, s.agentKey, b.query, b.limit)
          : [];
        const combined = [...keyword, ...semantic].sort((a, b) => b.relevance_score - a.relevance_score);
        return {
          results: combined
            .filter(
              (r, i) => combined.findIndex((x) => x.source === r.source && x.content === r.content) === i,
            )
            .slice(0, b.limit),
        };
      },
    },
    {
      id: 'memory.export',
      provides: { domain: 'memory', operations: ['export'] },
      handler: async (req, res) => {
        const s = await scope(req),
          b = z.object({ include_archive: z.boolean().default(true) }).parse(req.body ?? {}),
          zip = new JSZip();
        zip.file('blocks.json', JSON.stringify((await blocks().find(s).toArray()).map(blockView)));
        if (b.include_archive)
          zip.file(
            'archive.json',
            JSON.stringify((await archive().find(s).limit(10000).toArray()).map(entry)),
          );
        zip.file(
          'metadata.json',
          JSON.stringify({ agent_id: req.params.agentId, exported_at: new Date().toISOString() }),
        );
        res
          .type('application/zip')
          .attachment(`${String(req.params.agentId).replace(/[^a-z0-9-]/gi, '-')}-memory-${Date.now()}.zip`)
          .send(await zip.generateAsync({ type: 'nodebuffer' }));
      },
    },
    {
      id: 'memory.import',
      provides: { domain: 'memory', operations: ['import'] },
      handler: async (req, res) => {
        requireAccess(req, 'manage');
        const s = await scope(req),
          uploaded = await multipart(req, res),
          f = uploaded.find((x) => x.fieldname === 'snapshot');
        if (!f) throw new OhError(400, 'VALIDATION_ERROR', 'Attach the snapshot zip');
        const zip = await JSZip.loadAsync(f.buffer);
        let total = 0;
        for (const f of Object.values(zip.files)) {
          total += (f as any)._data?.uncompressedSize ?? 0;
        }
        if (total > 10 * 1024 * 1024)
          throw new OhError(413, 'VALIDATION_ERROR', 'Expanded memory exceeds 10 MiB');
        const source = zip.file('blocks.json');
        if (!source) throw new OhError(400, 'VALIDATION_ERROR', 'blocks.json is required');
        const incoming = z
            .array(memoryBlockSchema)
            .max(50)
            .parse(JSON.parse(await source.async('string'))),
          strategy = z
            .enum(['overwrite', 'skip', 'merge'])
            .default('overwrite')
            .parse(req.body.merge_strategy);
        const arc = zip.file('archive.json');
        const entries = arc
          ? z
              .array(
                z.object({
                  content: z.string().min(1).max(100000),
                  metadata: z.record(z.unknown()).default({}),
                }),
              )
              .max(1000)
              .parse(JSON.parse(await arc.async('string')))
          : [];
        let blocks_imported = 0,
          conflicts = 0;
        const warnings: string[] = [];
        for (const b of incoming) {
          const old = await blocks().findOne({ ...s, label: b.label });
          if (old) {
            conflicts++;
            if (old.read_only || strategy === 'skip') {
              warnings.push(`Skipped ${b.label}`);
              continue;
            }
          }
          await writeBlock(
            s.ownerId,
            s.agentKey,
            { ...b, value: old && strategy === 'merge' ? `${old.value}\n${b.value}` : b.value },
            !old,
          );
          blocks_imported++;
        }
        const before = await archive().countDocuments(s);
        for (const e of entries) await archiveMemory(s.ownerId, s.agentKey, e.content, e.metadata);
        return {
          blocks_imported,
          archive_entries_imported: (await archive().countDocuments(s)) - before,
          conflicts,
          warnings,
        };
      },
    },
  ];
}
