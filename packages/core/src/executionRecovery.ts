import { collection } from './db.js';
import { loadContinuation, saveContinuation, stableId } from './human.js';

/** An uncertain write cannot be replayed merely because the transport supports retries. */
export class AmbiguousToolCall extends Error {}

type JournalEntry = {
  _id: string;
  ownerId: string;
  runId: string;
  key: string;
  readOnly: boolean;
  status: 'started' | 'completed';
};

/** Durable call result inbox. The parent checkpoint and this journal form a replayable saga. */
export async function durableToolCall<T>(
  ownerId: string,
  runId: string,
  key: string,
  readOnly: boolean,
  execute: () => Promise<T>,
): Promise<T> {
  const journal = collection<JournalEntry>('tool_journal');
  const _id = stableId(`${runId}:${key}`);
  const cached = await loadContinuation<{ result: T }>(ownerId, runId, `tool:${key}`);
  if (cached) return cached.result;
  const previous = await journal.findOne({ _id, ownerId });
  if (previous && !previous.readOnly)
    throw new AmbiguousToolCall('An external action has an unknown outcome. Review it before retrying.');
  const claimed = await journal.updateOne(
    { _id },
    { $setOnInsert: { _id, ownerId, runId, key, readOnly, status: 'started' } },
    { upsert: true },
  );
  if (!claimed.upsertedCount && !readOnly) {
    const completed = await loadContinuation<{ result: T }>(ownerId, runId, `tool:${key}`);
    if (completed) return completed.result;
    throw new AmbiguousToolCall(
      'Another attempt already started this external action. Review its outcome before retrying.',
    );
  }
  try {
    const result = await execute();
    await saveContinuation(ownerId, runId, `tool:${key}`, { result });
    await journal.updateOne({ _id }, { $set: { status: 'completed' } });
    return result;
  } catch (error) {
    // The cause travels along: a server that answered "not executed" is not an unknown outcome to the caller.
    if (!readOnly)
      throw new AmbiguousToolCall(
        'The external action or saving its result was interrupted. Its outcome is unknown; review the action before retrying.',
        { cause: error },
      );
    throw error;
  }
}

/** Repair the result/metadata boundary before deciding whether a crashed run can resume. */
export async function hasAmbiguousCalls(ownerId: string, runIds: string[]) {
  const journal = collection<JournalEntry>('tool_journal');
  for (const entry of await journal
    .find({ ownerId, runId: { $in: runIds }, readOnly: false, status: 'started' })
    .toArray()) {
    if (!(await loadContinuation(ownerId, entry.runId, `tool:${entry.key}`))) return true;
    await journal.updateOne({ _id: entry._id }, { $set: { status: 'completed' } });
  }
  return false;
}
