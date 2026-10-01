import type { Request, Response } from 'express';
import JSZip from 'jszip';
import { z } from 'zod';
import { getHarnessFile, readHarnessFile } from '../../../../packages/core/src/harnessFiles.js';
import { collection } from '../../../../packages/core/src/db.js';
import { skillSchema } from '../../../../packages/core/src/schema.js';
import { MAX_SKILL_INSTRUCTION_CHARS } from '../../../../packages/core/src/skillLimits.js';
import {
  snapshotSkill,
  skillVersion,
  type VersionedSkill,
} from '../../../../packages/core/src/skillVersions.js';
import { parseMarkdown, renderMarkdown } from './oaf.js';
import { OhError, notFound } from './errors.js';
import { repository, workspace, multipart, safePath, type RecordData } from './resources.js';
import { pageOf, pageQuery, type Operation, type OperationRegistry } from './operations.js';
const repo = repository('skills');
const category = z.enum(['user', 'plugin', 'builtin', 'organization']);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
function version(row: RecordData) {
  return skillVersion(row as VersionedSkill);
}
function view(row: RecordData) {
  return {
    id: row._id,
    name: row.name,
    description: row.description,
    version: version(row),
    vendor: row.vendor ?? 'OpenHarness',
    category: row.category ?? 'user',
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    'x-openharness': { display_title: row.displayTitle ?? row.name },
  };
}
function filesOf(row: RecordData) {
  return (
    row.files ?? {
      'SKILL.md': renderMarkdown(
        { name: row.name, description: row.description, version: version(row) },
        row.instructions,
      ),
    }
  );
}
async function bundle(req: Request, res: Response) {
  const files: Record<string, string> = Object.create(null);
  if (req.is('multipart/form-data')) {
    for (const f of await multipart(req, res)) {
      const path = safePath(f.originalname);
      if (!/\.(md|py|js|ts|json|ya?ml|jinja|txt)$/i.test(path))
        throw new OhError(400, 'VALIDATION_ERROR', 'Unsupported skill file type');
      if (files[path] !== undefined) throw new OhError(400, 'VALIDATION_ERROR', 'Duplicate skill path');
      files[path] = f.buffer.toString('utf8');
    }
  } else {
    const b = z
      .object({ files: z.array(z.object({ path: z.string(), content: z.string().max(1000000) })).max(100) })
      .parse(req.body);
    for (const f of b.files) {
      const path = safePath(f.path);
      if (files[path] !== undefined) throw new OhError(400, 'VALIDATION_ERROR', 'Duplicate skill path');
      files[path] = f.content;
    }
  }
  if (Buffer.byteLength(JSON.stringify(files)) > 10 * 1024 * 1024)
    throw new OhError(413, 'VALIDATION_ERROR', 'Skill bundle exceeds 10 MiB');
  if (!files['SKILL.md'])
    throw new OhError(400, 'VALIDATION_ERROR', 'SKILL.md is required at the bundle root');
  const parsed = parseMarkdown(files['SKILL.md']);
  const data = skillSchema.parse({
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    instructions: parsed.body,
    enabled: true,
  });
  const v = semver.parse(parsed.frontmatter.version ?? '1.0.0');
  return {
    ...data,
    version: v,
    files,
    vendor: String(parsed.frontmatter.vendor ?? 'OpenHarness').slice(0, 100),
  };
}
async function saveVersion(row: RecordData) {
  await snapshotSkill(row as VersionedSkill);
}
export function skillOperations(registry: OperationRegistry): Operation[] {
  registry.declare('skills', {
    limitations: [
      'Discover searches supplied workspace paths, never host filesystem paths',
      'Skill bundles are limited to 10 MiB and 100 text files; versions use major.minor.patch',
      `Skill instructions are limited to ${MAX_SKILL_INSTRUCTION_CHARS} characters and are never silently truncated`,
    ],
  });
  return [
    {
      id: 'skills.list',
      provides: { domain: 'skills', operations: ['list'] },
      handler: async (req) => {
        const rows = await repo
          .records()
          .find({
            ownerId: workspace(req),
            ...(req.query.category ? { category: category.parse(req.query.category) } : {}),
          })
          .toArray();
        return pageOf(rows.map(view), pageQuery.parse(req.query));
      },
    },
    {
      id: 'skills.get',
      handler: async (req) => ({ skill: view(await repo.get(workspace(req), String(req.params.skillId))) }),
    },
    {
      id: 'skills.register',
      provides: { domain: 'skills', operations: ['install'] },
      handler: async (req, res) => {
        const ownerId = workspace(req),
          b = await bundle(req, res);
        const raw = req.body.metadata;
        const meta = z
          .object({ display_title: z.string().min(1).max(100), category: category.default('user') })
          .parse(typeof raw === 'string' ? JSON.parse(raw) : (raw ?? { display_title: b.name }));
        if (await repo.records().findOne({ ownerId, name: b.name }))
          throw new OhError(409, 'CONFLICT', 'Skill name already registered');
        const row = await repo.create(ownerId, {
          ...b,
          category: meta.category,
          displayTitle: meta.display_title,
          revision: 1,
        });
        await saveVersion(row);
        res.status(201).json({ skill: view(row) });
      },
    },
    {
      id: 'skills.update',
      handler: async (req) => {
        const row = await repo.get(workspace(req), String(req.params.skillId));
        const b = z
          .object({ display_title: z.string().min(1).max(100).optional(), category: category.optional() })
          .parse(req.body);
        return {
          skill: view(
            await repo.update(row, {
              ...(b.display_title ? { displayTitle: b.display_title } : {}),
              ...(b.category ? { category: b.category } : {}),
            }),
          ),
        };
      },
    },
    {
      id: 'skills.uninstall',
      provides: { domain: 'skills', operations: ['uninstall'] },
      handler: async (req, res) => {
        const row = await repo.get(workspace(req), String(req.params.skillId));
        if (
          (await collection('workflows').findOne({
            ownerId: row.ownerId,
            enabled: true,
            'nodes.config.skillIds': row._id,
          })) ||
          (await collection('agents').findOne({ ownerId: row.ownerId, enabled: true, skillIds: row._id }))
        )
          throw new OhError(409, 'CONFLICT', 'Skill is referenced by an active agent');
        await repo.remove(row);
        await collection('skill_versions').deleteMany({ ownerId: row.ownerId, skillId: row._id });
        res.status(204).end();
      },
    },
    {
      id: 'skills.listVersions',
      provides: { domain: 'skills', operations: ['versions'] },
      handler: async (req) => {
        const row = await repo.get(workspace(req), String(req.params.skillId));
        await saveVersion(row);
        const versions = await collection('skill_versions')
          .find({ ownerId: row.ownerId, skillId: row._id })
          .sort({ createdAt: -1 })
          .toArray();
        return {
          skill_id: row._id,
          current_version: version(row),
          versions: versions.map((v) => ({
            version: v.version,
            created_at: v.updatedAt,
            changelog: v.changelog,
          })),
        };
      },
    },
    {
      id: 'skills.rollback',
      provides: { domain: 'skills', operations: ['rollback'] },
      handler: async (req) => {
        const row = await repo.get(workspace(req), String(req.params.skillId));
        const b = z.object({ version: semver }).parse(req.body);
        const v = await collection('skill_versions').findOne({
          ownerId: row.ownerId,
          skillId: row._id,
          version: b.version,
        });
        if (!v) throw notFound('Skill version');
        await saveVersion(row);
        const saved = await repo.update(row, {
          instructions: v.instructions,
          description: v.description,
          version: v.version,
          files: v.files,
          revision: (row.revision ?? 1) + 1,
        });
        return { skill: view(saved), previous_version: version(row) };
      },
    },
    {
      id: 'skills.upgrade',
      provides: { domain: 'skills', operations: ['upgrade'] },
      handler: async (req, res) => {
        const row = await repo.get(workspace(req), String(req.params.skillId)),
          b = await bundle(req, res);
        if (b.name !== row.name) throw new OhError(400, 'VALIDATION_ERROR', 'Skill name must match');
        const a = version(row).split('.').map(Number),
          n = b.version.split('.').map(Number);
        const diff = n.findIndex((v, i) => v !== a[i]);
        if (diff < 0 || n[diff] < a[diff])
          throw new OhError(409, 'CONFLICT', 'New version must be greater than current');
        if (
          await collection('skill_versions').findOne({
            ownerId: row.ownerId,
            skillId: row._id,
            version: b.version,
          })
        )
          throw new OhError(409, 'CONFLICT', 'This version already exists; use rollback or a new version');
        await saveVersion(row);
        const saved = await repo.update(row, {
          ...b,
          revision: (row.revision ?? 1) + 1,
          changelog: z.string().max(1000).optional().parse(req.body.changelog),
        });
        await saveVersion(saved);
        return { skill: view(saved), previous_version: version(row) };
      },
    },
    {
      id: 'skills.validate',
      provides: { domain: 'skills', operations: ['validate'] },
      handler: async (req, res) => {
        workspace(req);
        try {
          await bundle(req, res);
          return { valid: true, errors: [], warnings: [] };
        } catch (e) {
          return {
            valid: false,
            errors: [
              {
                file: 'SKILL.md',
                code: 'INVALID_SKILL',
                message: e instanceof Error ? e.message : 'Invalid skill',
              },
            ],
            warnings: [],
          };
        }
      },
    },
    {
      id: 'skills.download',
      provides: { domain: 'skills', operations: ['export'] },
      handler: async (req, res) => {
        let row = await repo.get(workspace(req), String(req.params.skillId));
        if (req.query.version && req.query.version !== version(row)) {
          const v = await collection<RecordData>('skill_versions').findOne({
            ownerId: row.ownerId,
            skillId: row._id,
            version: semver.parse(req.query.version),
          });
          if (!v) throw notFound('Skill version');
          row = v;
        }
        const zip = new JSZip();
        for (const [path, content] of Object.entries(filesOf(row))) zip.file(safePath(path), String(content));
        res
          .type('application/zip')
          .attachment(`${row.name.replace(/[^a-zA-Z0-9_-]/g, '-')}.zip`)
          .send(await zip.generateAsync({ type: 'nodebuffer' }));
      },
    },
    {
      id: 'skills.discover',
      provides: { domain: 'skills', operations: ['discover'] },
      handler: async (req) => {
        const ownerId = workspace(req);
        const b = z
          .object({ search_paths: z.array(z.string().max(500)).max(20).default(['']) })
          .parse(req.body ?? {});
        const paths = b.search_paths.map((p) => safePath(p, true));
        const files = await collection('harness_files')
          .find({ ownerId, type: 'file', harnessId: String(req.params.harnessId) })
          .limit(1000)
          .toArray();
        const registered = await repo.records().find({ ownerId }).toArray();
        const discovered = [];
        for (const f of files) {
          if (
            !String(f.path).endsWith('SKILL.md') ||
            !paths.some((p) => !p || String(f.path).startsWith(p + '/'))
          )
            continue;
          try {
            const md = parseMarkdown(
              (
                await readHarnessFile(
                  await getHarnessFile(ownerId, String(req.params.harnessId), String(f.path)),
                )
              ).toString('utf8'),
            );
            discovered.push({
              name: String(md.frontmatter.name),
              path: f.path,
              category: 'user',
              already_registered: registered.some((r) => r.name === md.frontmatter.name),
            });
          } catch {
            /* invalid manifests are not discovered */
          }
        }
        return { discovered };
      },
    },
  ];
}
