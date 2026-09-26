# Learning from experience

A workflow with a knowledge workspace can **learn from experience**. Turn it on under Workflow settings →
Knowledge workspace → Learn from experience. The learning happens in context: model weights stay fixed. What the
workflow learns is written as lessons that later runs read. Standalone agents and agent cards can also choose a dedicated long-term notebook. A plain knowledge-base attachment supplies a notebook too; feedback learning defaults on for that fallback, while explicit settings and existing dedicated-workspace opt-in behavior are preserved.

Every succeeded, failed, or interrupted top-level run with a configured memory workspace automatically saves its task, recent conversation context, outcome, and result in `experiments/`, even if the model never calls a memory tool. Experiments start as unreviewed; a successful execution is not proof that its answer is correct. They are recalled even with lesson generation disabled. Raw tool telemetry remains in the temporary task notebook.

The playground’s **Memory** panel shows experiment storage and reflection status. Experiment writes are idempotent and retried by the dispatcher after an interrupted save. Note search includes a bounded scan of recent notes, and experiment recall reads saved metadata directly, so indexing delays or an unavailable vector store do not erase memory.

## The loop

1. **Signals.** A person rates an answer with thumbs up or down in the playground, optionally saying what should
   change. An application sends the same rating with `POST /api/runs/:id/feedback`, as `{ "rating": "up" | "down",
"comment"?: "..." }`. When `learnFromFailures` is on (the default), a failed or interrupted run is a signal too.
2. **Reflection.** The runner gives the workflow's model the task, the outcome, the answer, any tool errors and the
   feedback, and asks for a one- or two-sentence lesson that starts with `Lesson:`.
3. **Lessons.** The lesson is saved in the workspace under `experience/`, with provenance: `run_id`, `outcome`,
   `rating`, a `score` of +1, -1 or 0, the `comment` and the `workflow_id`. People can review, edit or delete
   lessons on the Knowledge page like any other note.
4. **Recall.** When the workflow runs again, the lessons most relevant to the new input are added to its agents'
   instructions. The default is three, set by `recallLimit`. Each lesson is marked with where it came from, for
   example "from negative feedback". The run's trace shows an `experience_recalled` event naming the notes used.

Feedback is always stored on the run, whether or not the workflow learns. Reflections are durable: if the queue
message is lost, the API's dispatcher publishes it again. A processing lease recovers a reflection interrupted by a runner restart. New feedback supersedes the previous lesson for the same run. Automatic experiment and lesson recall is scoped to the workflow or standalone agent; agents can explicitly search shared workspace notes. Sub-agents inherit the recalled lessons of their run.

## Access

Studio users can rate any run in their workspace. An API key can rate the runs it created, as long as it has the
`execute` scope.

## Export

`GET /api/workflows/:id/experience.jsonl` exports every run that has a saved experiment, feedback or a lesson, one JSON object per
line, with `run_id`, `created_at`, `input`, `output`, `status`, `error`, `feedback` and `lesson`. Use it to evaluate
the workflow, or to fine-tune or post-train a model on it later.

## Notebook attachments

Knowledge resource edges and legacy saved-agent references use the same notebook
resolution as standalone agents. Their experiment records and feedback lessons
are visible in the run's Memory panel even without a workflow-level workspace.
Sub-agents inherit the coordinating agent's resolved notebook and can leave
source-backed findings for future runs. Notes requested by skills use `kb_write`;
`memory_write` remains temporary and `memory_promote` explicitly retains a
reviewed temporary note. Use kinds `environment`, `conversation`, and `lesson`
for durable environment knowledge, conversation context, and reusable guidance.
