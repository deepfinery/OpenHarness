import { RE2 } from 're2-wasm';
import JSZip from 'jszip';
import { z } from 'zod';
import {
  fileInfo,
  getHarnessFile,
  harnessFiles,
  readHarnessFile,
  writeHarnessFile,
  mkdirHarness,
  deleteHarnessFile,
  normalizeHarnessPath,
} from '../../../../packages/core/src/harnessFiles.js';
import { workspace, multipart } from './resources.js';
import { OhError } from './errors.js';
import type { Operation, OperationRegistry } from './operations.js';
const pathParam = (req: any) =>
  Array.isArray(req.params.path) ? req.params.path.join('/') : String(req.params.path);
const bool = (v: unknown) => v === true || v === 'true';
export function fileOperations(registry: OperationRegistry): Operation[] {
  registry.declare('files', {
    limitations: [
      'Workspace files are scoped to the harness and stored separately from the host filesystem',
      'Maximum 10 MiB per file, 100 files and 10 MiB per upload batch, 50 MiB per download batch',
      'Content search uses bounded RE2 regular expressions (no backreferences or lookaround)',
    ],
  });
  return [
    {
      id: 'files.list',
      provides: { domain: 'files', operations: ['list'] },
      handler: async (req) => {
        const ownerId = workspace(req),
          harnessId = String(req.params.harnessId),
          path = normalizeHarnessPath(String(req.query.path ?? ''), true);
        const rows = await harnessFiles().find({ ownerId, harnessId }).limit(10000).toArray();
        return {
          path,
          files: rows
            .filter(
              (r) =>
                (!path || r.path.startsWith(path + '/')) &&
                (bool(req.query.recursive) || !r.path.slice(path ? path.length + 1 : 0).includes('/')),
            )
            .map(fileInfo),
        };
      },
    },
    ...(['read', 'download'] as const).map((id): Operation => ({
      id: `files.${id}`,
      provides: { domain: 'files', operations: [id] },
      handler: async (req, res) => {
        const f = await getHarnessFile(workspace(req), String(req.params.harnessId), pathParam(req));
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        res.type(f.mimeType);
        if (id === 'download') res.attachment(f.path.split('/').at(-1)!);
        res.send(await readHarnessFile(f));
      },
    })),
    {
      id: 'files.write',
      provides: { domain: 'files', operations: ['write'] },
      handler: async (req) => {
        const content = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        return writeHarnessFile(
          workspace(req),
          String(req.params.harnessId),
          pathParam(req),
          content,
          true,
          req.get('content-type') ?? 'application/octet-stream',
        );
      },
    },
    {
      id: 'files.delete',
      provides: { domain: 'files', operations: ['delete'] },
      handler: async (req, res) => {
        await deleteHarnessFile(
          workspace(req),
          String(req.params.harnessId),
          pathParam(req),
          bool(req.query.recursive),
        );
        res.status(204).end();
      },
    },
    {
      id: 'files.mkdir',
      provides: { domain: 'files', operations: ['mkdir'] },
      handler: async (req) =>
        mkdirHarness(
          workspace(req),
          String(req.params.harnessId),
          z.object({ path: z.string() }).parse(req.body).path,
        ),
    },
    ...(['upload', 'uploadBatch'] as const).map((id): Operation => ({
      id: `files.${id}`,
      provides: { domain: 'files', operations: [id] },
      handler: async (req, res) => {
        const ownerId = workspace(req),
          harnessId = String(req.params.harnessId),
          files = await multipart(req, res);
        if (!files.length || (id === 'upload' && files.length !== 1))
          throw new OhError(400, 'VALIDATION_ERROR', 'Attach the requested files');
        const base = normalizeHarnessPath(String(req.body.base_path ?? ''), true),
          uploaded = [],
          skipped = [],
          errors = [];
        // Validate every path before creating anything.
        const paths = files.map((f) =>
          normalizeHarnessPath(
            id === 'upload'
              ? String(req.body.path ?? f.originalname)
              : [base, f.originalname].filter(Boolean).join('/'),
          ),
        );
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          try {
            const result = await writeHarnessFile(
              ownerId,
              harnessId,
              paths[i],
              f.buffer,
              bool(req.body.overwrite),
              f.mimetype,
            );
            if (id === 'upload') return result;
            uploaded.push(result.file);
          } catch (e) {
            if (id === 'upload') throw e;
            if ((e as { status?: number }).status === 409) skipped.push(paths[i]);
            else errors.push({ path: paths[i], error: e instanceof Error ? e.message : 'Upload failed' });
          }
        }
        return { uploaded, skipped, errors };
      },
    })),
    {
      id: 'files.downloadBatch',
      provides: { domain: 'files', operations: ['download-batch'] },
      handler: async (req, res) => {
        const ownerId = workspace(req),
          harnessId = String(req.params.harnessId),
          b = z.object({ paths: z.array(z.string()).min(1).max(1000) }).parse(req.body);
        const zip = new JSZip();
        let size = 0;
        for (const path of b.paths) {
          const f = await getHarnessFile(ownerId, harnessId, path);
          size += f.size;
          if (size > 50 * 1024 * 1024) throw new OhError(413, 'VALIDATION_ERROR', 'Download exceeds 50 MiB');
          zip.file(f.path, await readHarnessFile(f));
        }
        res
          .type('application/zip')
          .attachment('workspace.zip')
          .send(await zip.generateAsync({ type: 'nodebuffer' }));
      },
    },
    {
      id: 'files.search',
      provides: { domain: 'files', operations: ['search'] },
      handler: async (req) => {
        const ownerId = workspace(req),
          harnessId = String(req.params.harnessId),
          b = z
            .object({
              path: z.string().default(''),
              glob: z.string().max(500).optional(),
              grep: z.string().max(1000).optional(),
              max_results: z.number().int().min(1).max(1000).default(100),
            })
            .parse(req.body);
        const path = normalizeHarnessPath(b.path, true);
        const pattern = b.glob
          ? new RegExp(
              '^' +
                b.glob
                  .replaceAll('**/', '\u0000')
                  .split('**')
                  .map((part) =>
                    part
                      .split('*')
                      .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                      .join('[^/]*'),
                  )
                  .join('.*')
                  .replaceAll('\u0000', '(?:.*/)?') +
                '$',
            )
          : undefined;
        let grep: RE2 | undefined;
        try {
          if (b.grep) grep = new RE2(b.grep, 'u');
        } catch {
          throw new OhError(400, 'VALIDATION_ERROR', 'Invalid or unsupported RE2 expression');
        }
        const rows = await harnessFiles().find({ ownerId, harnessId, type: 'file' }).limit(10000).toArray();
        const matches = [];
        let scanned = 0;
        for (const f of rows) {
          if (path && !f.path.startsWith(path + '/')) continue;
          if (pattern && !pattern.test(f.path)) continue;
          let line_matches;
          if (b.grep) {
            scanned += f.size;
            if (scanned > 50 * 1024 * 1024) break;
            line_matches = (await readHarnessFile(f))
              .toString('utf8')
              .split('\n')
              .flatMap((content, i) =>
                grep!.test(content) ? [{ line_number: i + 1, content: content.slice(0, 2000) }] : [],
              )
              .slice(0, 100);
            if (!line_matches.length) continue;
          }
          matches.push({ file: fileInfo(f), ...(line_matches ? { line_matches } : {}) });
          if (matches.length >= b.max_results) break;
        }
        return { matches };
      },
    },
  ];
}
