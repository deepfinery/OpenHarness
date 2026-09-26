# Knowledge workspace

A workflow can name one knowledge base as its **workspace**, under Workflow settings → Knowledge workspace. The
workspace is persistent long-term memory, and the knowledge base is the source of truth. Agents keep their own context
small: they search the workspace, read only the parts they need, and write what they learn back. Later steps, other
agents in the workflow, sub-agents and future runs all build on the same notes.

Every query also has a separate [temporary task notebook](task-memory.md), even without a knowledge workspace.
Use it for intermediate analysis and agent handoffs, then promote selected findings to this persistent workspace.

## Tools

When a workflow has a workspace, its agents get three built-in tools:

| Tool        | What it does                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kb_search` | Searches the workspace and the agent's other knowledge bases. It returns short snippets with note ids and paths, not whole documents. An optional `folder` narrows the search. |
| `kb_read`   | Reads part of a note by id, with `offset` and `limit` in characters (up to 8,000), and says where to continue.                                                                 |
| `kb_write`  | Records a `finding` (with `sources` and `confidence`), a `decision` (with `reasons`), `feedback` or a `note`.                                                                  |

Every `kb_write` creates a new note, and nothing is overwritten. Parallel agents therefore never clobber each other's
work, and the history of what was decided and why stays intact.

Each kind of note is filed in its own folder:

| Kind                  | Folder                                    |
| --------------------- | ----------------------------------------- |
| Finding               | `research/`                               |
| Decision              | `decisions/`                              |
| Feedback              | `feedback/`                               |
| Note                  | `notes/`                                  |
| Offloaded tool result | `scratch/` in the temporary task notebook |

Every note starts with YAML provenance: `kind`, `run_id`, `agent`, `sources`, `confidence` and `created`. The studio
shows the folder beside each file. Search combines vector results with a bounded scan of recent notes, so recent writes can be found while indexing catches up. Read by id to retrieve a specific note immediately.

A configured workspace also saves run records automatically under `experiments/`; feedback and failure lessons go under `experience/` when learning is enabled. In the designer, **Set up memory** opens the workflow settings, and a knowledge card offers **Use as workflow long-term memory**. Attaching reference knowledge alone does not grant write access.

## Result offloading

Tool results are saved in the task notebook's `scratch/` folder, up to 200,000 characters each. Above 6,000 characters,
the agent's context keeps only the first 1,500 characters, the note id, and a pointer to `memory_read`. Output that a
`post_tool` hook rewrote is stored as rewritten, so a redaction also covers the saved note. Turn offloading off in the
workflow settings to disable automatic result storage and keep large results inline, capped at 12,000 characters.
Raw tool results no longer accumulate in the long-term knowledge base unless explicitly promoted.

## Training data

Notes carry their provenance, so a workspace is a record of the agents' research, decisions with reasons, and
feedback. It can later serve as data for fine-tuning or post-training. For now it serves the agent loop only.
