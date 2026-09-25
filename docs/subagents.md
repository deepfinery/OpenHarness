# Sub-agents

An agent can hand focused, independent tasks to sub-agents that it starts itself. Turn this on in the agent's
settings with **Can hand focused tasks to sub-agents**, and set how many sub-agents it may start per run (1–12,
default 4). The agent then gets a built-in `spawn_agents` tool. One call starts up to four sub-agents in parallel,
each with:

| Field    | Meaning                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------- |
| `task`   | Everything the sub-agent needs to know. It does not see the parent's conversation.              |
| `skill`  | Optionally, one of the parent's skills. Its instructions go into the sub-agent's prompt.        |
| `effort` | `light` (default), `medium` or `high`. This sets the sub-agent's turns, time and token cap.     |
| `tools`  | Optionally, which of the parent's tools it may use. Without it, the sub-agent gets all of them. |

## Budgets

A sub-agent's token budget is the smaller of two numbers: its effort preset, or an equal share of 80% of the
parent's remaining budget. The other 20% is kept back so the parent can still write its answer. If a share would
fall below 4,000 tokens, the call is refused and the parent is told to do the work itself or to spawn fewer
sub-agents. Everything the sub-agents spend counts against the parent, so the parent's budget bounds the whole tree.

## Context and results

A sub-agent starts with a fresh context. It gets its own instructions, the chosen skill, its task, the parent's
knowledge bases, and the workflow's knowledge workspace. It records its findings there with `kb_write` and ends with
a short summary. The parent receives, for each sub-agent:

```json
{
  "subagent_id": "…",
  "task": "…",
  "status": "succeeded",
  "summary": "…",
  "notes": [{ "note_id": "…", "path": "research/…" }],
  "tokens_used": 1234
}
```

The parent reads the notes it needs with `kb_read`, instead of carrying every sub-agent's transcript.

## Limits and traces

- Sub-agents cannot start sub-agents of their own.
- Hooks, machine policies and cancellation apply to sub-agents as to their parent.
- Each sub-agent is recorded as its own run, with `trigger: "subagent"`, `parentRunId`, `parentNodeId`,
  `tokensUsed` and its own trace. The parent's trace shows `subagent_started` and `subagent_completed`.
- If the parent ends while a sub-agent is still running, the sub-agent is marked interrupted.
