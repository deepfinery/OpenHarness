import { collection } from './db.js';
import type { Run } from './schema.js';
export type Conversation = {
  _id: string;
  ownerId: string;
  actor: string;
  agentId?: string;
  workflowId?: string;
  deviceId?: string;
  messages: Run['history'];
  createdAt: Date;
  updatedAt: Date;
  pending?: { runId: string; since: Date };
};
/** Compare-and-update makes completion safe after duplicate delivery or a runner restart. */
export async function settleConversation(run: Run) {
  if (!run.conversationId || ['queued', 'running'].includes(run.status)) return;
  await collection<Conversation>('conversations').updateOne(
    { _id: run.conversationId, ownerId: run.ownerId, 'pending.runId': run._id },
    {
      $unset: { pending: '' },
      $set: { updatedAt: new Date() },
      ...(run.status === 'succeeded'
        ? {
            $push: {
              messages: {
                $each: [
                  { role: 'user' as const, content: run.input },
                  { role: 'assistant' as const, content: (run.output ?? '').slice(0, 32000) },
                ],
                $slice: -20,
              },
            },
          }
        : {}),
    },
  );
}
