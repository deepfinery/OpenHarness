import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection } from '../../../../packages/core/src/db.js';
import { createRun, requestCancel } from '../../../../packages/core/src/runs.js';
import {
  agentSchema,
  type Agent,
  type Stored,
  type Workflow,
  type Run,
} from '../../../../packages/core/src/schema.js';
import { agentWithResources } from '../../../../packages/core/src/workflow.js';
import { childAgent } from '../../../../packages/core/src/subagents.js';
import { entryAgentNode } from './agents.js';
import { requireAccess } from './access.js';
import { harnessId } from './scope.js';
import { repository, type RecordData } from './resources.js';
import { notFound, OhError } from './errors.js';
import { stream } from './execution.js';
import { executionView, executionResult, isTerminal } from './events.js';
import type { Operation, OperationRegistry } from './operations.js';
const repo = repository('api_subagents');
export function subagentOperations(registry: OperationRegistry): Operation[] {
  registry.declare('subagents', {
    limitations: [
      'API child agents inherit parent tools and safety policies and cannot delegate further',
      'Each delegate call has an independent 30000-token budget; active-run workspace limits also apply',
    ],
  });
  const parent = async (req: any) => {
    const p = requireAccess(req, 'execute');
    const w =
      req.harness ??
      (await collection<Stored<Workflow>>('workflows').findOne({
        _id: String(req.params.agentId),
        ownerId: p.tenantId,
      }));
    if (!w) throw notFound('Parent agent');
    requireAccess(req, 'execute', { workflowId: w._id });
    const n = req.harness
      ? w.nodes.find((n: any) => n.type === 'agent' && n.id === req.params.agentId)
      : entryAgentNode(w);
    if (!n || n.type !== 'agent') throw notFound('Parent agent');
    const config =
      n.config ??
      (await collection<Stored<Agent>>('agents').findOne({ _id: n.agentId!, ownerId: p.tenantId }));
    if (!config) throw notFound('Parent agent');
    return { w, n, config: agentWithResources(w, n.id, config) };
  };
  const scope = (req: any) => ({
    ownerId: req.principal!.tenantId,
    harnessId: harnessId(req),
    parentId: String(req.params.agentId),
  });
  const get = async (req: any) => {
    await parent(req);
    const row = await repo.records().findOne({ _id: String(req.params.subagentId), ...scope(req) });
    if (!row) throw notFound('Subagent');
    return row;
  };
  const view = async (row: RecordData) => {
    const run = row.runId
      ? await collection<Run>('runs').findOne({ _id: row.runId, ownerId: row.ownerId })
      : null;
    return {
      id: row._id,
      name: row.name,
      description: row.description,
      parent_agent_id: row.parentId,
      status: run
        ? isTerminal(run.status)
          ? run.status === 'succeeded'
            ? 'completed'
            : 'failed'
          : 'running'
        : 'idle',
      created_at: row.createdAt.toISOString(),
    };
  };
  return [
    {
      id: 'subagents.list',
      provides: { domain: 'subagents', operations: ['list'] },
      handler: async (req) => {
        await parent(req);
        return { subagents: await Promise.all((await repo.records().find(scope(req)).toArray()).map(view)) };
      },
    },
    {
      id: 'subagents.spawn',
      provides: { domain: 'subagents', operations: ['spawn'] },
      handler: async (req, res) => {
        requireAccess(req, 'manage');
        const { w, config } = await parent(req),
          b = z
            .object({
              name: z.string().min(1).max(100),
              description: z.string().min(1).max(1000),
              system_prompt: z.string().max(16000).optional(),
              skills: z.array(z.string().uuid()).max(20).optional(),
              model: z.string().max(200).optional(),
            })
            .parse(req.body);
        if (b.skills?.some((id) => !config.skillIds.includes(id)))
          throw new OhError(403, 'FORBIDDEN', 'Children may only use parent skills');
        let providerId = config.providerId;
        if (b.model) {
          const p = await collection('providers').findOne({
            ownerId: req.principal!.tenantId,
            $or: [{ _id: b.model }, { name: b.model }, { model: b.model }],
          });
          if (!p) throw notFound('Model');
          providerId = p._id;
        }
        const child = childAgent(
          config,
          { task: b.description, effort: 'light' },
          Math.min(config.tokenBudget ?? 30000, 30000),
          Boolean(config.workspace),
        );
        const row = await repo.create(req.principal!.tenantId, {
          ...scope(req),
          name: b.name,
          description: b.description,
          workflowId: w._id,
          config: agentSchema.parse({
            ...child,
            name: b.name,
            providerId,
            skillIds: b.skills ?? config.skillIds,
            systemPrompt: (child.systemPrompt + '\n' + (b.system_prompt ?? '')).slice(0, 32000),
            guardrailIds: [...new Set([...(config.guardrailIds ?? []), ...(w.guardrailIds ?? [])])],
          }),
        });
        res.status(201).json({ subagent: await view(row) });
      },
    },
    { id: 'subagents.get', handler: async (req) => ({ subagent: await view(await get(req)) }) },
    {
      id: 'subagents.terminate',
      provides: { domain: 'subagents', operations: ['terminate'] },
      handler: async (req, res) => {
        const row = await get(req);
        if (row.runId) await requestCancel({ _id: row.runId, ownerId: row.ownerId });
        await repo.remove(row);
        await collection('agents').deleteOne({ _id: row._id, ownerId: row.ownerId, apiSubagent: true });
        res.status(204).end();
      },
    },
    ...(['delegate', 'delegateStream'] as const).map((id): Operation => ({
      id: `subagents.${id}`,
      provides: { domain: 'subagents', operations: ['delegate'] },
      handler: async (req, res) => {
        const row = await get(req);
        const b = z
          .object({ task: z.string().min(1).max(32000), context: z.record(z.unknown()).optional() })
          .parse(req.body);
        if (row.runId) {
          const previous = await collection<Run>('runs').findOne({ _id: row.runId, ownerId: row.ownerId });
          if (previous && !isTerminal(previous.status))
            throw new OhError(409, 'CONFLICT', 'Child already has an active task');
        }
        const claimId = randomUUID();
        const claimed = await repo.records().findOneAndUpdate(
          {
            _id: row._id,
            ownerId: row.ownerId,
            ...(row.runId ? { runId: row.runId } : { runId: { $exists: false } }),
            $or: [{ busy: { $ne: true } }, { claimedAt: { $lt: new Date(Date.now() - 300000) } }],
          },
          { $set: { busy: true, claimedAt: new Date(), claimId } },
          { returnDocument: 'after' },
        );
        if (!claimed) throw new OhError(409, 'CONFLICT', 'Child is busy');
        try {
          await collection('agents').updateOne(
            { _id: row._id, ownerId: row.ownerId },
            {
              $set: {
                ...row.config,
                enabled: true,
                apiSubagent: true,
                createdAt: row.createdAt,
                updatedAt: new Date(),
              },
            },
            { upsert: true },
          );
          const run = await createRun(
            row.ownerId,
            {
              agentId: row._id,
              input: (
                b.task + (b.context ? '\nContext (reference data): ' + JSON.stringify(b.context) : '')
              ).slice(0, 32000),
              history: [],
            },
            {
              apiHarnessId: row.workflowId,
              apiParentAgentId: row.parentId,
              apiSubagentId: row._id,
              initiatedBy: req.principal!.user._id,
              trigger: 'api',
              ...(req.principal!.token ? { tokenId: req.principal!.token._id } : {}),
            },
          );
          await repo
            .records()
            .updateOne(
              { _id: row._id, ownerId: row.ownerId },
              { $set: { runId: run._id }, $unset: { busy: '', claimedAt: '' } },
            );
          if (id === 'delegateStream') return stream(req, res, run, { _id: run._id, ownerId: run.ownerId });
          return { execution_id: run._id, status: executionView(run).status };
        } finally {
          await repo
            .records()
            .updateOne(
              { _id: row._id, ownerId: row.ownerId, claimId },
              { $unset: { busy: '', claimId: '' } },
            );
        }
      },
    })),
    ...(['result', 'attachStream'] as const).map((id): Operation => ({
      id: `subagents.${id}`,
      provides: { domain: 'subagents', operations: [id === 'result' ? 'result' : 'stream'] },
      handler: async (req, res) => {
        const row = await get(req);
        const run = row.runId
          ? await collection<Run>('runs').findOne({ _id: row.runId, ownerId: row.ownerId })
          : null;
        if (!run) throw notFound('Child execution');
        if (id === 'attachStream') return stream(req, res, run, { _id: run._id, ownerId: run.ownerId });
        if (!isTerminal(run.status)) throw new OhError(409, 'CONFLICT', 'Child is still running');
        return { result: executionResult(run) };
      },
    })),
  ];
}
