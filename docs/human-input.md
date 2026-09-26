# Human input and approvals

Runs can pause in `waiting_for_human`, releasing their worker. Answers return through the durable run queue.
The saved continuation contains completed passes, the pending model response, the next tool in its batch, and
budget usage. Answering after an API or runner restart does not repeat completed tool calls. Parallel members
and delegated children keep their completed results. Unexpected crashes during an external action still follow
the existing workflow replay policy; human continuation is not a promise of exactly-once execution across an
arbitrary external failure.

Agents expose `ask_human({question})` unless `humanInput` is false. Approvals default to `never` for compatibility.
Agent, workflow and explicit tool nodes accept `approvals`:

```json
{
  "mode": "when_risky",
  "tools": { "mcp.CONNECTION_ID.delete_file": "always", "memory_promote": "always" },
  "timeoutSeconds": 86400,
  "timeoutAction": "deny",
  "approvers": { "admins": true, "owner": true, "userIds": [] },
  "notifyEmail": false
}
```

The agent setting overrides the workflow default; a tool entry overrides its mode. These settings never grant
access to a tool. Modes apply to attached MCP tools; builtins use explicit entries, and `ask_human` never
recursively asks for approval. Risk includes `destructiveHint`, an absent/false `readOnlyHint`, or a `risk_score`
of at least 0.5 returned by a pre-tool hook. An explicit `never` rule overrides risk, but cannot bypass an
independent gateway requirement. Tool edits must satisfy the tool schema and configured pre-tool hooks.
A hook that changes edited arguments causes denial so the agent can propose a fresh call for review.

`owner` means the workflow or agent creator, snapshotted when the run starts. Legacy records without a creator
fall back to the initiating user; scheduled legacy records need an administrator or a listed user. Session and API responses enforce both tenant access and approver policy. Cancellation closes
pending requests, including delegated children, and frees the conversation for another message.

Timeouts deny tools and give the agent an explicit missing-input observation. `continue` also allows a workflow
review step to proceed with its original result, explicitly attributed to the configured timeout policy. A pending tool-approval request is never
automatically approved. `escalate` enables administrator approval and gives one additional timeout
period, then denies. Approval records identify the actor (or `timeout`), time, arguments, and feedback.

A `review` workflow node supports `prompt`, `value` (default `{{last}}`), `onApprove` and `onReject`. The reviewer
may edit the result. Feedback is returned with the reviewed value and decision. Both branches appear in the editor.

## Studio and API

The Inbox shows pending requests you can answer, with a navigation count, arguments, expiry, and recent trace
context. Questions and approvals also appear inline in the Playground. Agent settings expose questions, approval
mode, timeout behavior, and email notifications. More specific tool and approver lists can be configured via API.

- `GET /api/approvals` lists authorized pending requests; workflow API keys see requests for their own executions.
- `POST /api/approvals/:id` accepts `{decision: "answer", answer: "…"}`, `{decision: "approve", arguments: {...}}`,
  or `{decision: "deny", feedback: "…"}`. Arguments and feedback are optional. Duplicate/expired decisions return 409.
- `POST /openharness/v1/harnesses/openharness/executions/:id/input` accepts `{data: "…"}`. For approvals use `yes`,
  `no`, `approve`, or `deny`. Select among concurrent requests with `x-openharness.request_id`; that extension also
  supports `decision`, `arguments`, and `feedback`. A non-waiting execution returns 409; a terminal execution returns 410.
- Execution views expose the internal waiting status and pending human requests in `x-openharness`.

Opt-in email uses existing SMTP settings, addresses authorized approvers, and contains an expiring signed link.
A link still requires login and authorization. Failed emails retry; delivery is at least once. Registered harness
webhooks can subscribe to `human.requested`, `human.decided`, or `human.escalated` and use the existing signed
webhook delivery mechanism. Decisions are saved as notebook decision notes when the requesting agent or workflow
has a notebook. Consent and feedback are explicitly distinguished from evidence of successful execution.

## Machine gateway

Set `GATEWAY_APPROVAL_PROVIDER=studio` and `GATEWAY_APPROVAL_TOOLS=run_command,write_file` in the gateway environment
and recreate the gateway. Both gateway and orchestrator must share the configured gateway administrator secret.
Noop and webhook providers remain available. The default remains noop until a policy is configured.

The gateway advertises required approval in tool `_meta`. The orchestrator pauses before opening the command call,
then signs a 30-second proof bound to the device, tool, arguments, and call id. The gateway atomically consumes that
id in its own MongoDB before forwarding. Changed arguments, expired proofs, unsigned calls, and replayed proofs are
denied. A gateway-required approval takes precedence over an agent's `never` setting. Direct MCP clients must use
an orchestrated execution for Studio approval. Gateway storage without MongoDB is for tests and throwaway runs.

## Artifacts

Execution artifact list/download routes store final answers, embedded MCP resources, and successful machine
`read_file`/`write_file` content using the repository storage interface. Truncated reads and appended bytes have
explicit partial/append filenames. Arbitrary tool URLs and server filesystem paths are never fetched. Failed tool
results are not artifacts. Hook-redacted output is not bypassed by saving an original unredacted file.

Limits are 5 MiB per artifact and 50 artifacts per run. Downloads enforce execution/token scope and use attachment
headers. Final answers remain available from the result endpoint even if an artifact limit is reached.
