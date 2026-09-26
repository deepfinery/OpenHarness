import { config } from '../../../../packages/core/src/config.js';
import type { Run, RunEvent, RunStatus } from '../../../../packages/core/src/schema.js';

/** Spec execution states and how OpenHarness run states map onto them. */
export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
const toSpec: Record<RunStatus, ExecutionStatus> = {
  queued: 'pending',
  running: 'running',
  waiting_for_human: 'running',
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  // A runner that died past its resume budget: the spec has no separate state, so it is a failure.
  interrupted: 'failed',
};
export const executionStatus = (status: RunStatus) => toSpec[status];
export const runStatusesFor = (status: ExecutionStatus) =>
  (Object.keys(toSpec) as RunStatus[]).filter((s) => toSpec[s] === status);

export type SpecEvent = { type: string } & Record<string, unknown>;
export type Usage = { input_tokens: number; output_tokens: number; total_tokens: number };
export type DetailedToolCall = {
  id: string;
  name: string;
  input: object;
  output?: object;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
};
type Data = Record<string, unknown>;
const record = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
/** Tool arguments are stored as JSON text; the spec wants an object. */
function argumentsObject(value: unknown): object {
  if (typeof value !== 'string') return record(value);
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { value };
  }
}
const quiet = new Set(['model']);

/**
 * Translates a run's persisted event log into Open Harness execution events. Replaying the same log always yields
 * the same events, which is what lets a stream resume from `Last-Event-ID`. It also accumulates token usage, tool
 * calls and step progress for the execution, result and tool-call views.
 */
export class EventTranslator {
  readonly usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  readonly calls = new Map<string, DetailedToolCall>();
  completedSteps = 0;
  currentStep = '';
  private readonly waiting: string[] = [];
  private readonly nodeTypes: Map<string, string>;
  readonly totalSteps: number;

  constructor(run: Pick<Run, 'snapshot'>) {
    const nodes = run.snapshot?.workflow?.nodes ?? [];
    this.nodeTypes = new Map(nodes.map((n) => [n.id, n.type]));
    this.totalSteps = Math.max(1, nodes.filter((n) => n.type !== 'start').length);
  }
  progress(step: string, extra: Data = {}): SpecEvent {
    this.currentStep = step;
    return {
      type: 'progress',
      percentage: Math.min(99, Math.floor((this.completedSteps / this.totalSteps) * 100)),
      step,
      step_number: Math.min(this.totalSteps, this.completedSteps + 1),
      total_steps: this.totalSteps,
      ...(Object.keys(extra).length ? { 'x-openharness': extra } : {}),
    };
  }
  translate(event: RunEvent, index: number): SpecEvent[] {
    const data = record(event.data);
    const extra = { type: event.type, ...(event.nodeId ? { node_id: event.nodeId } : {}) };
    switch (event.type) {
      case 'model': {
        const usage = record(data.usage);
        const input = Number(usage.input) || 0;
        const output = Number(usage.output) || 0;
        this.usage.input_tokens += input;
        this.usage.output_tokens += output;
        this.usage.total_tokens += input + output;
        return [];
      }
      case 'tool_started': {
        const id = typeof data.callId === 'string' ? data.callId : `call_${index}`;
        if (typeof data.callId !== 'string') this.waiting.push(id);
        const name = typeof data.tool === 'string' ? data.tool : event.message;
        const input = argumentsObject(data.arguments);
        this.calls.set(id, { id, name, input, status: 'running', started_at: event.at });
        return [
          { type: 'tool_call_start', id, name, input },
          { type: 'tool_call_end', id },
        ];
      }
      case 'tool_completed':
      case 'tool_error': {
        const id = typeof data.callId === 'string' ? data.callId : (this.waiting.shift() ?? `call_${index}`);
        const success = event.type === 'tool_completed';
        const output = { content: typeof data.result === 'string' ? data.result : '' };
        const call = this.calls.get(id);
        if (call) {
          call.status = success ? 'completed' : 'failed';
          call.output = output;
          call.completed_at = event.at;
          call.duration_ms = Math.max(0, Date.parse(event.at) - Date.parse(call.started_at));
          if (!success) call.error = output.content.slice(0, 1000);
        }
        return [{ type: 'tool_result', id, success, output }];
      }
      case 'human_requested':
        return [
          this.progress(event.message, {
            ...extra,
            human_request: { id: data.requestId, kind: data.kind },
            waiting_for_human: true,
          }),
        ];
      case 'node_started':
        if (this.nodeTypes.get(event.nodeId ?? '') === 'start') return [];
        return [this.progress(event.message, extra)];
      case 'node_completed':
        if (this.nodeTypes.get(event.nodeId ?? '') === 'start') return [];
        this.completedSteps = Math.min(this.totalSteps, this.completedSteps + 1);
        return [this.progress(`${event.message} completed`, extra)];
      default:
        if (quiet.has(event.type)) return [];
        return [this.progress(event.message, extra)];
    }
  }
  static replay(run: Pick<Run, 'snapshot' | 'events'>) {
    const translator = new EventTranslator(run);
    run.events.forEach((event, index) => translator.translate(event, index));
    return translator;
  }
}
const terminal = new Set<RunStatus>(['succeeded', 'failed', 'cancelled', 'interrupted']);
export const isTerminal = (status: RunStatus) => terminal.has(status);

/** The events that close a stream: an error for unsuccessful runs, then exactly one `done`. */
export function closingEvents(run: Pick<Run, 'status' | 'error' | '_id'>, usage: Usage): SpecEvent[] {
  const events: SpecEvent[] = [];
  if (run.status !== 'succeeded') {
    const code =
      run.status === 'cancelled'
        ? 'EXECUTION_CANCELLED'
        : run.status === 'interrupted'
          ? 'EXECUTION_INTERRUPTED'
          : 'EXECUTION_FAILED';
    events.push({
      type: 'error',
      code,
      message:
        run.error ?? (run.status === 'cancelled' ? 'The execution was cancelled' : 'The execution failed'),
      recoverable: false,
    });
  }
  events.push({
    type: 'done',
    usage,
    'x-openharness': { execution_id: run._id, status: executionStatus(run.status), run_status: run.status },
  });
  return events;
}
/**
 * What of the final answer a stream still owes the client. `segment` is the text of the current segment as this
 * connection streamed it; it is unknown (undefined) after a resume, where only its length (`sent`) is known.
 */
export function unsentOutput(output: string, segment: string | undefined, sent: number) {
  if (segment === undefined) return output.slice(sent);
  if (!segment) return output;
  // A workflow's final template can differ from the last agent's streamed text; then the answer is sent whole.
  return output.startsWith(segment) ? output.slice(segment.length) : output;
}
export function executionView(run: Run, translator = EventTranslator.replay(run)) {
  const status = executionStatus(run.status);
  return {
    id: run._id,
    harness_id: config.OPENHARNESS_HARNESS_ID,
    status,
    ...(status === 'running' || status === 'pending'
      ? {
          progress: {
            percentage: Math.min(99, Math.floor((translator.completedSteps / translator.totalSteps) * 100)),
            current_step: translator.currentStep || (status === 'pending' ? 'Queued' : 'Starting'),
            steps_completed: translator.completedSteps,
            steps_total: translator.totalSteps,
          },
        }
      : {}),
    started_at: (run.startedAt ?? run.createdAt).toISOString(),
    ...(run.finishedAt ? { completed_at: run.finishedAt.toISOString() } : {}),
    artifacts_count: run.artifactIds?.length ?? 0,
    'x-openharness': {
      agent_id: run.workflowId ?? run.agentId,
      label: run.label,
      run_status: run.status,
      trigger: run.trigger,
      ...(run.device ? { machine_id: run.device.id } : {}),
      ...(run.error ? { error: run.error } : {}),
    },
  };
}
export function executionResult(run: Run) {
  const translator = EventTranslator.replay(run);
  return {
    execution_id: run._id,
    status: executionStatus(run.status),
    output: run.output ?? '',
    artifacts: [],
    tool_calls: [...translator.calls.values()].map((c) => ({
      id: c.id,
      name: c.name,
      success: c.status === 'completed',
      duration_ms: c.duration_ms ?? 0,
    })),
    usage: translator.usage,
  };
}
