import { z } from 'zod';
import { collection } from './db.js';
import { HttpError } from './security.js';
export const planTask = z.object({
  id: z.string().min(1).max(200),
  content: z.string().min(1).max(8000),
  status: z.enum(['pending', 'in_progress', 'completed']),
  order: z.number().int().min(0).max(100),
});
export type PlanTask = z.infer<typeof planTask> & { output?: string };
export type ExecutionPlan = {
  _id: string;
  ownerId: string;
  executionId: string;
  nodeKey: string;
  tasks: PlanTask[];
  updatedAt: Date;
  revision: number;
};
export const plans = () => collection<ExecutionPlan>('execution_plans');
export async function initializePlan(ownerId: string, runId: string, nodeKey: string, steps: string[]) {
  const _id = `${runId}:${nodeKey}`;
  await plans().updateOne(
    { _id, ownerId },
    {
      $setOnInsert: {
        _id,
        ownerId,
        executionId: runId,
        nodeKey,
        tasks: steps.map((content, i) => ({
          id: `task-${i + 1}`,
          content,
          status: 'pending' as const,
          order: i,
        })),
        updatedAt: new Date(),
        revision: 1,
      },
    },
    { upsert: true },
  );
  return _id;
}
export async function nextPlanTask(ownerId: string, id: string) {
  for (let i = 0; i < 10; i++) {
    const p = await plans().findOne({ _id: id, ownerId });
    if (!p) return null;
    const task = [...p.tasks].sort((a, b) => a.order - b.order).find((t) => t.status !== 'completed');
    if (!task) return null;
    if (task.status === 'in_progress') return task;
    const updated = await plans().updateOne(
      { _id: id, ownerId, revision: p.revision },
      {
        $set: {
          tasks: p.tasks.map((t) => (t.id === task.id ? { ...t, status: 'in_progress' as const } : t)),
          updatedAt: new Date(),
        },
        $inc: { revision: 1 },
      },
    );
    if (updated.modifiedCount) return { ...task, status: 'in_progress' as const };
  }
  throw new HttpError(409, 'Plan is being edited; retry');
}
export async function completePlanTask(ownerId: string, id: string, taskId: string, output: string) {
  await plans().updateOne(
    { _id: id, ownerId, 'tasks.id': taskId },
    {
      $set: {
        'tasks.$.status': 'completed',
        'tasks.$.output': output.slice(0, 12000),
        updatedAt: new Date(),
      },
      $inc: { revision: 1 },
    },
  );
}
