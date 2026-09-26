import { z } from 'zod';
import { plans, planTask, type ExecutionPlan } from '../../../../packages/core/src/executionPlans.js';
import { findRun } from './execution.js';
import { notFound, OhError } from './errors.js';
import type { Operation, OperationRegistry } from './operations.js';
const view = (p: ExecutionPlan) => ({
  execution_id: p.executionId,
  tasks: p.tasks.map(({ output, ...task }) => task),
  updated_at: p.updatedAt.toISOString(),
  'x-openharness': { node_key: p.nodeKey, revision: p.revision },
});
export function planningOperations(registry: OperationRegistry): Operation[] {
  registry.declare('planning', {
    limitations: [
      'Plans come from plan-and-execute agents; in multi-agent harnesses the most recently updated plan is exposed',
      'Only pending steps can be edited; running and completed steps are immutable',
    ],
  });
  const owned = async (req: any, edit = false) => {
    const { run } = await findRun(req, edit ? 'execute' : 'read');
    const p = await plans()
      .find({ executionId: run._id, ownerId: run.ownerId })
      .sort({ updatedAt: -1 })
      .limit(1)
      .next();
    if (!p) throw notFound('Plan');
    return { run, p };
  };
  return [
    {
      id: 'planning.get',
      provides: { domain: 'planning', operations: ['read'] },
      handler: async (req) => ({ plan: view((await owned(req)).p) }),
    },
    {
      id: 'planning.listTasks',
      handler: async (req) => ({
        tasks: (await owned(req)).p.tasks.filter((t) => !req.query.status || t.status === req.query.status),
      }),
    },
    ...(['update', 'updateTask'] as const).map((id): Operation => ({
      id: `planning.${id}`,
      provides: { domain: 'planning', operations: ['update'] },
      handler: async (req) => {
        const { run, p } = await owned(req, true);
        if (!['queued', 'running', 'waiting_for_human'].includes(run.status))
          throw new OhError(409, 'CONFLICT', 'Execution has finished');
        let tasks = p.tasks;
        if (id === 'update') {
          const b = z.object({ tasks: z.array(planTask).min(1).max(12) }).parse(req.body);
          tasks = b.tasks;
        } else {
          const b = z
            .object({
              content: z.string().min(1).max(8000).optional(),
              status: z.enum(['pending', 'in_progress', 'completed']).optional(),
            })
            .parse(req.body);
          if (!tasks.some((t) => t.id === req.params.taskId)) throw notFound('Task');
          tasks = tasks.map((t) => (t.id === req.params.taskId ? { ...t, ...b } : t));
        }
        if (
          new Set(tasks.map((t) => t.id)).size !== tasks.length ||
          new Set(tasks.map((t) => t.order)).size !== tasks.length
        )
          throw new OhError(400, 'VALIDATION_ERROR', 'Task ids and ordering must be unique');
        for (const old of p.tasks.filter((t) => t.status !== 'pending')) {
          const now = tasks.find((t) => t.id === old.id);
          if (!now || now.content !== old.content || now.status !== old.status || now.order !== old.order)
            throw new OhError(409, 'CONFLICT', 'Only pending tasks may change');
        }
        for (const t of tasks)
          if (!p.tasks.some((old) => old.id === t.id && old.status !== 'pending') && t.status !== 'pending')
            throw new OhError(409, 'CONFLICT', 'The runner controls task status');
        const next = await plans().findOneAndUpdate(
          { _id: p._id, ownerId: p.ownerId, revision: p.revision },
          {
            $set: {
              tasks: tasks.map((t) => ({
                ...t,
                ...(p.tasks.find((old) => old.id === t.id)?.output
                  ? { output: p.tasks.find((old) => old.id === t.id)!.output }
                  : {}),
              })),
              updatedAt: new Date(),
            },
            $inc: { revision: 1 },
          },
          { returnDocument: 'after' },
        );
        if (!next) throw new OhError(409, 'CONFLICT', 'Plan advanced; reload');
        return id === 'update'
          ? { plan: view(next) }
          : { task: next.tasks.find((t) => t.id === req.params.taskId) };
      },
    })),
    {
      id: 'planning.stream',
      provides: { domain: 'planning', operations: ['stream'] },
      handler: async (req, res) => {
        const { run, p } = await owned(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        let last: ExecutionPlan | undefined;
        let busy = false,
          closed = false;
        const tick = async () => {
          if (busy || closed) return;
          busy = true;
          try {
            const current = await plans().findOne({ _id: p._id, ownerId: run.ownerId });
            if (current && current.revision !== last?.revision) {
              for (const t of current.tasks) {
                const old = last?.tasks.find((x) => x.id === t.id);
                if (JSON.stringify(old) !== JSON.stringify(t))
                  res.write(
                    `event: ${old ? 'task.updated' : 'task.added'}\ndata: ${JSON.stringify({ type: old ? 'task.updated' : 'task.added', task: t })}\n\n`,
                  );
              }
              for (const t of last?.tasks ?? [])
                if (!current.tasks.some((x) => x.id === t.id))
                  res.write(
                    `event: task.removed\ndata: ${JSON.stringify({ type: 'task.removed', task_id: t.id })}\n\n`,
                  );
              res.write(
                `event: plan.reordered\ndata: ${JSON.stringify({
                  type: 'plan.reordered',
                  task_ids: current.tasks
                    .slice()
                    .sort((a, b) => a.order - b.order)
                    .map((t) => t.id),
                })}\n\n`,
              );
              last = current;
            }
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(() => void tick().catch(() => {}), 500),
          end = setTimeout(() => res.end(), 30 * 60000);
        res.on('close', () => {
          closed = true;
          clearInterval(timer);
          clearTimeout(end);
        });
        await tick();
      },
    },
  ];
}
