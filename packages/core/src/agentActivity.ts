import { collection } from './db.js';
import { loadContinuation, saveContinuation, stableId } from './human.js';

export type AgentActivity = {
  _id: string;
  ownerId: string;
  runId: string;
  agent: string;
  nodeId?: string;
  label: string;
  model: string;
  status: 'running' | 'completed';
  startedAt: Date;
  completedAt?: Date;
};
export const activities = () => collection<AgentActivity>('agent_activity');

export async function startAgentActivity(
  ownerId: string,
  runId: string,
  key: string,
  details: Pick<AgentActivity, 'agent' | 'nodeId' | 'label' | 'model'>,
) {
  const _id = stableId(`${runId}:activity:${key}`);
  await activities().updateOne(
    { _id, ownerId, runId },
    { $setOnInsert: { _id, ownerId, runId, ...details, status: 'running', startedAt: new Date() } },
    { upsert: true },
  );
  return _id;
}

/** Keep full authored outputs out of the bounded event buffer and Mongo run document. */
export async function completeAgentActivity(ownerId: string, runId: string, id: string, content: string) {
  const existing = await activities().findOne({ _id: id, ownerId, runId });
  if (existing?.status === 'completed') return;
  await saveContinuation(ownerId, runId, `activity:${id}`, { content });
  await activities().updateOne(
    { _id: id, ownerId, runId },
    { $set: { status: 'completed', completedAt: new Date() } },
  );
}

export async function readAgentActivity(ownerId: string, runId: string, id: string) {
  const entry = await activities().findOne({ _id: id, ownerId, runId });
  if (!entry) return;
  const saved =
    entry.status === 'completed'
      ? await loadContinuation<{ content: string }>(ownerId, runId, `activity:${id}`)
      : undefined;
  return { ...activityView(entry), content: saved?.content };
}

export function activityView({ _id, ownerId, runId, ...entry }: AgentActivity) {
  return { id: _id, ...entry };
}
