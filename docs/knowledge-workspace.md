# Knowledge workspace

A workflow can name one knowledge base as its **workspace**, under Workflow settings → Knowledge workspace. The
workspace is shared working memory, and the knowledge base is the source of truth. Agents keep their own context
small: they search the workspace, read only the parts they need, and write what they learn back. Later steps, other
agents in the workflow, sub-agents and future runs all build on the same notes.

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

| Kind                  | Folder       |
| --------------------- | ------------ |
| Finding               | `research/`  |
| Decision              | `decisions/` |
| Feedback              | `feedback/`  |
| Note                  | `notes/`     |
| Offloaded tool result | `scratch/`   |

Every note starts with YAML provenance: `kind`, `run_id`, `agent`, `sources`, `confidence` and `created`. The studio
shows the folder beside each file. Notes are indexed within seconds of being written, so a note written in the same
step may not be searchable yet; read it by id instead.

## Result offloading

A tool result longer than 6,000 characters is saved in full as a note in `scratch/`. The agent's context keeps only
the first 1,500 characters, the note id, and a pointer to `kb_read`. Output that a `post_tool` hook rewrote is stored
as rewritten, so a redaction also covers the saved note. Turn offloading off in the workflow settings to keep large
results inline, where they are capped at 12,000 characters as before.

## Training data

Notes carry their provenance, so a workspace is a record of the agents' research, decisions with reasons, and
feedback. It can later serve as data for fine-tuning or post-training. For now it serves the agent loop only.
