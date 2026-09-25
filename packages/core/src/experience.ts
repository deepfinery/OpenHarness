import { collection } from './db.js';
import { searchKnowledge } from './knowledge.js';
import { chat, ownedProvider } from './llm.js';
import { publish } from './queue.js';
import type { KnowledgeDocument, Run, Workflow } from './schema.js';
import { safeError } from './security.js';
import { agentNote, createNote, folderFor } from './workspace.js';

/**
 * Learning from experience, in context: the model weights stay fixed. After a run gets feedback (or fails), a
 * reflection step writes a short lesson into the workflow's knowledge workspace under experience/, with provenance.
 * When the workflow runs again, the lessons most relevant to the new input are recalled into its agents' prompts.
 * Everything is text with provenance, so it can later serve as training data too.
 */
const runs = () => collection<Run>('runs');
export const learns = (workflow?: Workflow) => Boolean(workflow?.experience?.enabled && workflow.workspace);

/** Marks a run for reflection and queues it; the dispatcher re-publishes reflections whose message was lost. */
export async function requestReflection(runId: string, reason: 'feedback' | 'failure') {
  await runs().updateOne(
    { _id: runId },
    { $set: { reflection: { status: 'pending', requestedAt: new Date(), reason } } },
  );
  await publish({ kind: 'reflect', id: runId }).catch(() => {});
}
export async function dispatchReflections() {
  const stale = new Date(Date.now() - 60000);
  for (const run of await runs()
    .find(
      { 'reflection.status': 'pending', 'reflection.requestedAt': { $lt: stale } },
      { projection: { _id: 1 } },
    )
    .limit(50)
    .toArray()) {
    await runs().updateOne(
      { _id: run._id, 'reflection.status': 'pending' },
      { $set: { 'reflection.requestedAt': new Date() } },
    );
    await publish({ kind: 'reflect', id: run._id }).catch(() => {});
  }
}
/** The provider a reflection uses: the workflow's first agent's, else the workspace default. */
async function reflectionProvider(run: Run) {
  const fromNodes = Object.values(run.snapshot.nodeAgents ?? {})[0]?.providerId;
  const fromAgent = run.agentId ? run.snapshot.agents[run.agentId]?.providerId : undefined;
  const tenant = await collection<{ _id: string; defaultProviderId?: string }>('tenants').findOne({
    _id: run.ownerId,
  });
  const fallback = (
    await collection<{ _id: string; ownerId: string; createdAt: Date }>('providers')
      .find({ ownerId: run.ownerId })
      .sort({ createdAt: 1 })
      .limit(1)
      .next()
  )?._id;
  const id = fromNodes ?? fromAgent ?? tenant?.defaultProviderId ?? fallback;
  if (!id) throw new Error('No model provider is available for reflection');
  return ownedProvider(run.ownerId, id);
}
export const REFLECTION_PROMPT =
  'You turn one run of an AI agent into a lesson for future runs of the same workflow. Reply with one or two sentences that start with "Lesson:". Be concrete about what to do, or avoid, next time for similar requests. Do not repeat the task.';
function reflectionInput(run: Run) {
  const toolErrors = run.events
    .filter((e) => e.type === 'tool_error')
    .map(
      (e) =>
        `- ${e.message}: ${String((e.data as { result?: string } | undefined)?.result ?? '').slice(0, 300)}`,
    )
    .slice(0, 5);
  return [
    `Task: ${run.input.slice(0, 3000)}`,
    `Outcome: ${run.status}`,
    run.output ? `Answer: ${run.output.slice(0, 3000)}` : '',
    run.error ? `Error: ${run.error.slice(0, 1000)}` : '',
    toolErrors.length ? `Tool errors:\n${toolErrors.join('\n')}` : '',
    run.feedback
      ? `Feedback: ${run.feedback.rating === 'up' ? 'the user approved this result' : 'the user rejected this result'}${run.feedback.comment ? `. Comment: ${run.feedback.comment}` : ''}`
      : 'Feedback: none; the run failed.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
/** Runner job: writes the lesson note for a run that asked for reflection. Idempotent per request. */
export async function reflectOnRun(runId: string, signal: AbortSignal) {
  const run = await runs().findOne({ _id: runId, 'reflection.status': 'pending' });
  if (!run) return;
  const workflow = run.snapshot.workflow;
  if (!learns(workflow)) {
    await runs().updateOne({ _id: runId }, { $set: { 'reflection.status': 'skipped' } });
    return;
  }
  try {
    const provider = await reflectionProvider(run);
    const response = await chat(
      provider,
      [
        { role: 'system', content: REFLECTION_PROMPT },
        { role: 'user', content: reflectionInput(run) },
      ],
      [],
      signal,
    );
    const text = response.text.trim().replace(/\s+/g, ' ').slice(0, 800);
    const lesson = /^lesson:/i.test(text) ? text : `Lesson: ${text}`;
    const rating = run.feedback?.rating;
    const note = agentNote({
      title: `Lesson from ${run.status === 'succeeded' ? (rating === 'down' ? 'rejected' : 'approved') : run.status} run ${run._id.slice(0, 8)}`,
      kind: 'experience',
      content: [
        lesson,
        '',
        `Task: ${run.input.slice(0, 1000)}`,
        `Outcome: ${run.status}`,
        ...(run.feedback
          ? [`Feedback: ${rating}${run.feedback.comment ? ` — ${run.feedback.comment}` : ''}`]
          : []),
      ].join('\n'),
      runId: run._id,
      agent: 'Reflection',
      extra: {
        lesson,
        outcome: run.status,
        ...(rating ? { rating, score: rating === 'up' ? 1 : -1 } : { score: 0 }),
        ...(run.feedback?.comment ? { comment: run.feedback.comment } : {}),
        workflow_id: run.workflowId,
      },
    });
    const doc = await createNote(run.ownerId, workflow!.workspace!.knowledgeBaseId, {
      title: `Lesson ${new Date().toISOString().slice(0, 10)} ${run._id.slice(0, 8)}`,
      content: note.text,
      folder: folderFor.experience,
      meta: note.meta,
    });
    await runs().updateOne(
      { _id: runId },
      { $set: { 'reflection.status': 'done', 'reflection.noteId': doc._id, 'reflection.lesson': lesson } },
    );
  } catch (error) {
    await runs().updateOne(
      { _id: runId },
      { $set: { 'reflection.status': 'failed', 'reflection.error': safeError(error) } },
    );
  }
}
/** The lessons most relevant to a new input, for the agents' prompts. */
export async function recallLessons(run: Run, signal: AbortSignal) {
  const workflow = run.snapshot.workflow;
  if (!learns(workflow)) return undefined;
  const limit = workflow!.experience!.recallLimit ?? 3;
  let hits;
  try {
    hits = await searchKnowledge(run.ownerId, workflow!.workspace!.knowledgeBaseId, run.input, signal, {
      folder: folderFor.experience,
    });
  } catch {
    // Recall is best effort: a search failure never blocks the run.
    return undefined;
  }
  const ids = [...new Set(hits.map((h) => h.documentId))];
  if (!ids.length) return undefined;
  const docs = new Map(
    (
      await collection<KnowledgeDocument>('documents')
        .find({ ownerId: run.ownerId, _id: { $in: ids } })
        .toArray()
    ).map((d) => [d._id, d]),
  );
  const lessons = ids
    .map((id) => docs.get(id))
    .filter((d): d is KnowledgeDocument => Boolean(d?.meta?.lesson))
    .slice(0, limit)
    .map((d) => ({
      noteId: d._id,
      lesson: String(d.meta!.lesson),
      source:
        d.meta!.rating === 'down'
          ? 'negative feedback'
          : d.meta!.rating === 'up'
            ? 'positive feedback'
            : `a ${String(d.meta!.outcome)} run`,
    }));
  if (!lessons.length) return undefined;
  return {
    notes: lessons.map((l) => l.noteId),
    text: lessons.map((l) => `- ${l.lesson} (from ${l.source})`).join('\n'),
  };
}
export const lessonsNote = (text: string) =>
  `\n\nLessons from earlier runs of this workflow. Apply them when they fit this request:\n<lessons>\n${text}\n</lessons>`;
