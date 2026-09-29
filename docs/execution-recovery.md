# Budgeted execution and recovery

An agent's token budget covers prompt and output usage across every pattern pass,
including its reflection judge and delegated children. It is separate from the
provider's context window. Context pressure compacts the conversation and archives
displaced evidence; it does not reset the job budget or authorize more work.

The runtime tells the model to plan within the remaining budget, checkpoint progress,
and report completed work and limitations. Analysis and delegation leave a reserved
allowance for tool-free final synthesis. Turn, token, and active-time limits still
apply. Human waiting time does not consume the active-time allowance. Provider
failures or an impossible budget cannot guarantee a complete answer: an unavailable
final summary now produces a failed run with readable partial output and saved
Memory/Trace evidence, rather than a succeeded run. Chat, streaming APIs, and artifacts
retain that output.

The latest user request defines the task. Historical messages are reference context;
input guardrails do not re-evaluate them as new requests. Current input, retrieval,
tool calls/results and generated output still receive their configured checks.
Simple greetings return immediately without agent model calls, MCP connections, notebook
recall or delegation. A follow-up in the same conversation can read the task notebooks
from the last five completed turns, within their seven-day retention period. Writes
belong to the new turn, so expanding a task can reuse earlier findings without
rewriting them. Other conversations and tenants do not gain access.

## Durable boundaries

MongoDB stores the run state, queue outbox, leases, call journal, and child identities.
The shared file store holds atomically replaced continuations and tool results.
The continuation records the active dialog, pending call index, completed pattern
passes, prepared approvals, token usage and elapsed active time. It is saved before
model calls and before/after tool batches. An in-flight model call reserves its
maximum estimated cost before dispatch; if the worker dies before observing usage,
recovery conservatively keeps that charge. A known context rejection releases it.

A parent checkpoints a delegation call before starting children. Child IDs derive
from the parent, call and child position; their original agent snapshots and budget
allocations are retained. On replay, completed children return their stored reports,
and unfinished children load their own continuation. Child reports, task-memory
writes and saved MCP observations use stable IDs to avoid duplicate notes.

The durable dispatcher republishes work after a broker outage or expired worker
lease. Graceful runner shutdown follows the same recovery path. Resumable agent
nodes retain their attempt identity, completed pattern steps, and tool results.
Workflow resume policies and the maximum automatic recovery count still apply.

Completed external calls return their journaled result on replay. A missing result
for a potentially mutating call is **ambiguous**, even when an idempotency key was
sent to the MCP server. After a crash, the system stops automatic recovery for the
parent and its children until the outcome can be reviewed. It never assumes an
arbitrary MCP server supports exactly-once execution or invents a compensating action.
Read-only calls may be retried. Explicit workflow tool/email steps retain their
conservative existing resume policy.

While a run is live, a failed tool call is a result, not the end of the run. A tool
that answers with an error (a refused command, a non-zero exit, a command the
connector killed at its timeout, with the output it produced so far) is returned to the
model as an error result. A call whose effect cannot be confirmed (the runtime stopped
waiting, the device reconnected or timed out at the gateway, or the run resumed over an
unfinished call) is returned as an **outcome unknown** result: the model is told to
verify the effect with a read-only tool before continuing, and an identical call is
refused for the rest of the run. Only the crash-resume path above fails closed.

The runtime waits for a tool call as long as the tool's own `timeout_seconds` plus a
margin (150 s when none is given), so a connector's definitive timeout arrives first;
the gateway honors `timeout_seconds` up to any operator override. Model requests are
retried with backoff on connection errors and on 408, 409, 425, 429 and 5xx responses;
malformed or truncated streams and empty replies are retried without streaming; the
final answer is retried with more output room when a reply is empty or cut off before
the answer, which is what reasoning models do when their output limit is small.

## Configuration and human work

Agent settings are grouped into General, Reasoning, Knowledge, and Safety & human
input tabs. Reflection defaults to the working model; select a Judge model in
Reasoning to use another configured provider/model for critique. Both models consume
the same job budget.

During reflection, Playground shows a compact working status instead of repeatedly
replacing streamed drafts. **View activity** opens the saved draft, critique and
revision stages, with agent and model labels. Completed stage text is preserved in
full outside the bounded trace buffer, survives worker recovery, and remains available
after reloading a conversation. A stage interrupted before completion is marked
incomplete; private model reasoning is not recorded. The final answer appears in chat
when the run finishes. Other agent patterns retain their normal streaming behavior.

Questions and approval requests create durable Inbox tasks. Enable email notifications
in Safety & human input and configure SMTP in Settings → Email. Delivery failures stay
visible in Inbox and retry automatically; authorized approvers can retry immediately
after fixing the configuration. Pending, resolved and cancelled tasks are viewable.
Email links still require login and approver authorization. SMTP is at-least-once:
a crash after the relay accepts a message but before acknowledgement is saved can
produce a duplicate notification; it cannot duplicate the human decision.

Administrators can delete an unattached guardrail policy from its list card or editor.
Attached policies must be detached first. The workflow guardrail connector sits on
the agent card's top border.
