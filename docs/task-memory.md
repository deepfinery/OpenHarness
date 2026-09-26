# Task and long-term memory

Every query has a temporary Markdown notebook, shared by all workflow steps and
sub-agents working on that query. A note is visible immediately after it is
written. Agents use note ids and excerpts instead of passing large transcripts
around. The Playground **Memory** tab lets you search, read and promote notes.

## Storage decision

Short-term memory lives in MongoDB, keyed by workspace owner and the root run id.
It survives process restarts, supports concurrent append-only writes, and needs
no embedding provider or vector indexing. RabbitMQ remains the job-delivery
mechanism: a queue is not the source of truth for notes that several agents need
to find and re-read.

Each note expires seven days after creation. Reads exclude expired notes
immediately; MongoDB's TTL index subsequently deletes them. New queries,
including new messages in the same conversation, get a fresh notebook. An agent
cannot read another query's temporary notes by guessing their ids.

Long-term memory uses attached knowledge bases as persistent Markdown notebooks.
An agent can write environment observations, source-backed findings, decisions,
conversation summaries, user preferences, reusable lessons, and notes required by
its loaded skills. The default destination is the agent's dedicated notebook,
then the workflow's notebook, then its first attached knowledge base. With several
attachments, `kb_write` accepts `knowledge_base_id` to choose another attached
notebook; it cannot write to an unattached base, even within the same account.
The Playground's promotion control also lets you choose an attached destination.

Notes have folders, Markdown links/note references, sources and run provenance.
Writes are append-only: corrections can link to an earlier note without erasing
its history. Recent notes are searchable immediately, including while vector
indexing is unavailable. Later runs recall relevant notes and can read more in
pages. Attach the same notebook to another agent to share durable knowledge.

Completed runs automatically save their task, recent conversation context,
result and outcome as unreviewed experiment records. Plain knowledge attachments
also enable feedback/failure lessons by default; an explicit learning setting
wins, and existing dedicated workspaces retain their opt-in learning behavior.
The agent's **Learn from feedback and failures** checkbox controls lesson generation.
Lessons provide feedback-driven guidance in future prompts; model weights do not
change. Raw tool results and compressed transcripts stay in temporary task memory
unless explicitly promoted.

## Agent tools

| Tool                               | Purpose                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_write`                     | Append a finding, plan, decision or note to the current task, with optional folder and sources.                                                |
| `memory_search`                    | Immediately find task notes by literal text, or list recent notes with an empty query. Supports folder filtering and pagination.               |
| `memory_read`                      | Read a task note in pages of up to 8,000 characters.                                                                                           |
| `memory_promote`                   | Copy a reusable task note into the configured long-term knowledge base with provenance. Offered only when a knowledge workspace is configured. |
| `kb_search`, `kb_read`, `kb_write` | Search/read attached notebooks and write durable Markdown notes to a selected attached destination.                                            |

Every note has a UUID, Markdown content, a folder, creator, task/run provenance,
sources and expiry. Writes create independent notes even when agents choose the
same title. Notes can refer to other notes by id. This is a shared research
notebook, not an Obsidian installation or a separate file-sync service.

MCP results are recorded in task memory after post-tool hooks have run, so their
redactions apply to saved evidence too. Results above 6,000 characters leave an
excerpt and a `memory_read` reference in the model context. At most 200,000
characters per result are saved, and the reference states how much was retained.
The workflow's existing result-offloading switch can disable automatic result
storage. Agent-written notes are limited to 20,000 characters per write.

With **Limits → Automatic context compaction** enabled (the default), displaced
conversation messages and tool arguments are saved as `context` notes before
compression. Large checkpoints span numbered notes of at most 180,000 characters;
all part ids are recorded in the trace. A bounded excerpt and note references
remain in the model context. These are incomplete reference excerpts, not verified
findings. The setting is independent of MCP result offloading. Context checks and
a reserved final-answer allowance still apply when proactive compaction is off.

Sub-agents inherit the root task id and their parent's operating instructions.
Their final reports are saved automatically before the short summaries are sent
back. The parent can read the complete saved report or search intermediate
findings immediately. Child runs retain their own traces and token accounting.
Enable **Can hand focused tasks to sub-agents** on the coordinating agent.

Use promotion for verified findings worth reusing. Raw telemetry and tentative
hypotheses should normally stay in the task notebook. Promoting a note copies
it; it does not extend the temporary note's lifetime. The original task id,
note id, author and sources remain in the persistent note's provenance.

## Limits and final answers

The Max preset provides 120 analysis turns, a 5M-token budget and one hour.
Custom settings allow up to 200 turns and two hours. Existing saved agent limits
remain explicit; reselect Max or edit Limits to adopt the new preset.

At the analysis-turn limit, the runtime reserves one additional model call with
no tools for synthesis. It supplies recent notebook excerpts and asks the agent
to distinguish verified findings, missing evidence and unfinished checks. The
answer explicitly states that the turn limit was reached. If the model requests
another tool instead of answering, those requests do not execute; the user gets
an incomplete-assessment notice and saved-note excerpts. Time limits and
cancellation still stop execution, and the notebook retains work already saved.

## API

All routes enforce the same ownership and API-key restrictions as the run:

- `GET /api/runs/:id/memory?query=&folder=&offset=0&limit=10`
- `GET /api/runs/:id/memory/:noteId?offset=0&limit=4000`
- `POST /api/runs/:id/memory/:noteId/promote`

Promotion uses the run's snapshotted knowledge workspace. Open promoted notes in
the Knowledge page to manage their persistent content and indexing status.
