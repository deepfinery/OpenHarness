import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  BookOpen,
  Bot,
  Clock3,
  Code2,
  Download,
  Flag,
  GitBranch,
  GitFork,
  Laptop,
  LayoutGrid,
  Mail,
  Play,
  Plug,
  Plus,
  Redo2,
  Save,
  Settings2,
  Trash2,
  Undo2,
  Unplug,
  X,
} from 'lucide-react';
import { parse, stringify } from 'yaml';
import {
  workflowSchema,
  type Agent,
  type Workflow,
  type WorkflowNode,
  type WorkflowResource,
} from '../../../../packages/core/src/schema.js';
import { effortLabel } from '../../../../packages/core/src/patterns.js';
import { describeSchedule } from '../../../../packages/core/src/schedule.js';
import { layoutWorkflow } from '../workflowLayout';
import { api, errorMessage, type Data, type Entity } from '../api';
import {
  connectGraph,
  defaultAgent,
  disconnectGraph,
  editableWorkflow,
  graphEdges,
  insertStep,
  isFinish,
  removeGraphNode,
} from '../workflowGraph';
import { Button, CopyButton, ErrorNotice, Field, IconButton, Modal } from './ui';
import { KnowledgeControl, McpControl } from './ResourceControls';
import { ConnectionEditor, KnowledgeEditor } from './editors';
import { AgentFields, ScheduleFields } from './agentFields';

type GraphItem = WorkflowNode | WorkflowResource;
type StepType = 'agent' | 'tool' | 'parallel' | 'condition' | 'email' | 'finish';
type Payload =
  | { type: StepType }
  | { type: 'mcp'; connectionId?: string }
  | { type: 'knowledge'; knowledgeBaseId?: string };
type FlowData = {
  item: GraphItem;
  detail: string;
  attached: number;
  warning?: string;
  /** The agent a toolbox item being dragged would attach to. */
  dropTarget?: boolean;
  onOpen: (id: string) => void;
} & Record<string, unknown>;
const icons = {
  start: Play,
  finish: Flag,
  output: Flag,
  agent: Bot,
  tool: Plug,
  condition: GitBranch,
  parallel: GitFork,
  email: Mail,
  mcp: Plug,
  knowledge: BookOpen,
};
const labels = {
  start: 'Start',
  finish: 'Finish',
  output: 'Finish',
  agent: 'AI agent',
  tool: 'MCP action',
  condition: 'Condition',
  parallel: 'Parallel agents',
  email: 'Send email',
  mcp: 'MCP tools',
  knowledge: 'Knowledge',
};
const stepTypes: StepType[] = ['agent', 'condition', 'parallel', 'tool', 'email', 'finish'];
const stepHints: Record<StepType, string> = {
  agent: 'Reasons and acts',
  condition: 'Yes / no branch',
  parallel: 'Agents together',
  tool: 'One tool call',
  email: 'Send the result',
  finish: 'Return a result',
};

function GraphCard({ data, selected }: NodeProps<Node<FlowData>>) {
  const n = data.item,
    Icon = icons[n.type],
    resource = n.type === 'mcp' || n.type === 'knowledge',
    finish = n.type === 'finish' || n.type === 'output';
  return (
    <div
      className={`flow-card harness-card kind-${n.type} ${selected ? 'selected' : ''} ${data.warning ? 'needs-config' : ''} ${data.dropTarget ? 'drop-target' : ''}`}
      onDoubleClick={() => data.onOpen(n.id)}
    >
      {!resource && n.type !== 'start' && (
        <>
          <Handle
            type="target"
            id="in"
            position={Position.Left}
            data-testid={`port-${n.id}-in`}
            aria-label={`${n.name} input`}
          />
          <span className="port-label port-in">In</span>
        </>
      )}
      <button
        type="button"
        className="card-gear nodrag"
        aria-label={`Configure ${n.name}`}
        onClick={(e) => {
          e.stopPropagation();
          data.onOpen(n.id);
        }}
      >
        <Settings2 size={14} />
      </button>
      <div className="flow-card-top">
        <span className="node-icon">
          <Icon size={20} />
        </span>
        <div>
          {n.name !== labels[n.type] && <small>{labels[n.type]}</small>}
          <strong>{n.name}</strong>
        </div>
      </div>
      <p>{data.detail}</p>
      {data.warning && <div className="card-warning">{data.warning}</div>}
      {n.type === 'agent' && (
        <div className="agent-ports">
          <span>
            Tools <small>{data.attached || ''}</small>
          </span>
          <span>Knowledge</span>
          <Handle
            type="target"
            id="tools"
            position={Position.Bottom}
            style={{ left: '32%' }}
            className="tools-port"
            data-testid={`port-${n.id}-tools`}
            aria-label={`${n.name} tools`}
          />
          <Handle
            type="target"
            id="knowledge"
            position={Position.Bottom}
            style={{ left: '76%' }}
            className="knowledge-port"
            data-testid={`port-${n.id}-knowledge`}
            aria-label={`${n.name} knowledge`}
          />
        </div>
      )}
      {n.type === 'parallel' && (
        <div className="agent-ports members">
          <span>
            Runs <small>{data.attached || ''}</small>
          </span>
          <Handle
            type="source"
            id="members"
            position={Position.Bottom}
            style={{ left: '50%' }}
            className="members-port"
            data-testid={`port-${n.id}-members`}
            aria-label={`${n.name} members`}
          />
        </div>
      )}
      {resource && (
        <>
          <Handle
            type="source"
            id="resource"
            position={Position.Top}
            data-testid={`port-${n.id}-resource`}
            aria-label={`${n.name} attachment`}
          />
          <div className="resource-card-foot">
            {data.attached
              ? `${data.attached} agent${data.attached === 1 ? '' : 's'}`
              : 'Connect to an agent'}
          </div>
        </>
      )}
      {n.type === 'condition' ? (
        <>
          <Handle
            type="source"
            id="true"
            position={Position.Right}
            style={{ top: '36%' }}
            data-testid={`port-${n.id}-true`}
          />
          <span className="port-label branch-yes">Yes</span>
          <Handle
            type="source"
            id="false"
            position={Position.Right}
            style={{ top: '77%' }}
            data-testid={`port-${n.id}-false`}
          />
          <span className="port-label branch-no">No</span>
        </>
      ) : (
        !finish &&
        !resource && (
          <>
            <Handle
              type="source"
              id="out"
              position={Position.Right}
              data-testid={`port-${n.id}-out`}
              aria-label={`${n.name} next`}
            />
            <span className="port-label port-out">Next</span>
          </>
        )
      )}
    </div>
  );
}
const nodeTypes = { studio: GraphCard };
const newId = (type: string) => `${type}_${crypto.randomUUID().slice(0, 8)}`;
/** When the last toolbox drag ended, so the click that can follow a release is not taken as "add". */
let lastDragEnd = 0;

function ToolItem({
  payload,
  label,
  hint,
  icon: Icon,
  className = '',
  onAdd,
  onDragStart,
}: {
  payload: Payload;
  label: string;
  hint: string;
  icon: typeof Bot;
  className?: string;
  onAdd: () => void;
  onDragStart: (payload: Payload, label: string, e: React.PointerEvent) => void;
}) {
  return (
    <button
      type="button"
      className={`tool-item ${className}`}
      aria-label={`Add ${label}`}
      title="Click to add, or drag onto the canvas or an agent"
      onPointerDown={(e) => onDragStart(payload, label, e)}
      onClick={() => {
        if (Date.now() - lastDragEnd > 300) onAdd();
      }}
    >
      <span className="node-icon">
        <Icon size={16} />
      </span>
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
    </button>
  );
}

export function WorkflowEditor({
  value,
  draft,
  data,
  onClose,
  onSaved,
  onRun,
  onNavigate,
}: {
  value?: Entity;
  draft?: Workflow;
  data: Data;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onRun?: (id: string) => void;
  onNavigate?: (page: string) => void;
}) {
  const [form, setForm] = useState<Workflow>(() => editableWorkflow(value ?? draft, data));
  const [selected, select] = useState(form.nodes.find((n) => n.type === 'agent')?.id ?? form.startAt),
    [selectedEdge, selectEdge] = useState('');
  const [open, setOpen] = useState<
    { kind: 'node'; id: string } | { kind: 'workflow' } | { kind: 'api' } | null
  >(null);
  const [adding, setAdding] = useState<'connection' | 'knowledge' | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<'canvas' | 'yaml'>('canvas'),
    [yaml, setYaml] = useState('');
  const [argumentDrafts, setArgumentDrafts] = useState<Record<string, string>>({});
  const [invalidArguments, setInvalidArguments] = useState<Record<string, boolean>>({}),
    [dirty, setDirty] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance<Node<FlowData>> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  /**
   * Toolbox items are dragged with pointer events rather than native HTML5 drag and drop, which Safari cancels on
   * this canvas and touch screens do not support. A press that barely moves is left to the click handler.
   */
  const [drag, setDrag] = useState<{
    label: string;
    x: number;
    y: number;
    overCanvas: boolean;
    agentId?: string;
  } | null>(null);
  const [measurements, setMeasurements] = useState<Record<string, { width: number; height: number }>>({});
  const [publicUrl, setPublicUrl] = useState(location.origin);
  const undo = useRef<Workflow[]>([]),
    redo = useRef<Workflow[]>([]);
  const formRef = useRef(form);
  formRef.current = form;
  const [historyVersion, setHistoryVersion] = useState(0);
  useEffect(() => {
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = old;
    };
  }, []);
  useEffect(() => {
    if (open?.kind === 'api')
      void api('/config')
        .then((c) => setPublicUrl(c.publicUrl))
        .catch(() => {});
  }, [open?.kind]);
  function remember(current: Workflow) {
    undo.current.push(structuredClone(current));
    undo.current = undo.current.slice(-40);
    redo.current = [];
    setHistoryVersion((v) => v + 1);
  }
  function change(next: Workflow | ((f: Workflow) => Workflow), record = true) {
    const current = formRef.current;
    const updated = typeof next === 'function' ? next(current) : next;
    if (updated === current) return;
    if (record) remember(current);
    formRef.current = updated;
    setForm(updated);
    setDirty(true);
    setError('');
  }
  function travel(direction: 'undo' | 'redo') {
    const from = direction === 'undo' ? undo : redo,
      to = direction === 'undo' ? redo : undo;
    const previous = from.current.pop();
    if (!previous) return;
    to.current.push(structuredClone(form));
    setArgumentDrafts({});
    setInvalidArguments({});
    formRef.current = previous;
    setForm(previous);
    setHistoryVersion((v) => v + 1);
    setDirty(true);
    setError('');
  }
  const all: GraphItem[] = [...form.nodes, ...form.resources];
  const item = all.find((n) => n.id === selected);
  const openItem = open?.kind === 'node' ? all.find((n) => n.id === open.id) : undefined,
    openStep = open?.kind === 'node' ? form.nodes.find((n) => n.id === open.id) : undefined,
    openResource = open?.kind === 'node' ? form.resources.find((r) => r.id === open.id) : undefined;
  const agentNodes = form.nodes.filter((n) => n.type === 'agent');
  const edges = useMemo(
    () =>
      graphEdges(form).map((edge) => ({
        ...edge,
        selected: edge.id === selectedEdge,
        interactionWidth: 28,
        reconnectable: true,
        style: {
          stroke: edge.id.startsWith('resource:')
            ? edge.targetHandle === 'knowledge'
              ? '#2a9d8a'
              : '#9673b7'
            : edge.id.startsWith('member:')
              ? '#8a9bb0'
              : '#49a2dc',
          strokeWidth: 2,
          strokeDasharray: edge.id.startsWith('flow:') ? undefined : '6 5',
        },
        markerEnd: edge.id.startsWith('flow:')
          ? { type: MarkerType.ArrowClosed, color: '#49a2dc', width: 18, height: 18 }
          : undefined,
        labelStyle: { fill: '#526271', fontSize: 11 },
        labelBgStyle: { fill: '#eff3f7' },
      })),
    [form, selectedEdge],
  );
  const openSettings = (id: string) => {
    select(id);
    selectEdge('');
    setOpen({ kind: 'node', id });
  };
  const nodes: Node<FlowData>[] = useMemo(
    () =>
      [...form.nodes, ...form.resources].map((n, i) => {
        const agent = n.type === 'agent' ? n.config : undefined;
        const connection =
          'connectionId' in n ? data.connections.find((c) => c.id === n.connectionId) : undefined;
        const knowledge =
          n.type === 'knowledge' ? data.knowledge.find((k) => k.id === n.knowledgeBaseId) : undefined;
        const count =
          n.type === 'agent'
            ? form.bindings
                .filter((b) => b.agentNodeId === n.id)
                .reduce((total, b) => {
                  const resource = form.resources.find((r) => r.id === b.resourceId);
                  return total + (resource?.type === 'mcp' ? resource.tools.length : 0);
                }, 0)
            : n.type === 'parallel'
              ? n.agentNodeIds.length + n.agentIds.length
              : form.bindings.filter((b) => b.resourceId === n.id).length;
        const detail =
          n.type === 'agent'
            ? `${data.providers.find((p) => p.id === agent?.providerId)?.model ?? 'Choose a model'} · ${effortLabel(agent?.effort)} effort${agent?.skillIds?.length ? ` · ${agent.skillIds.length} skill${agent.skillIds.length === 1 ? '' : 's'}` : ''}`
            : n.type === 'start'
              ? form.schedule?.enabled
                ? describeSchedule(form.schedule)
                : 'Playground · API · Webhook'
              : n.type === 'finish' || n.type === 'output'
                ? 'Returns the result'
                : n.type === 'mcp'
                  ? `${connection?.name ?? 'Choose a server'} · ${n.tools.length} tools`
                  : n.type === 'knowledge'
                    ? (knowledge?.name ?? 'Choose a knowledge base')
                    : n.type === 'tool'
                      ? `${connection?.name ?? 'MCP server'} / ${n.tool || 'Choose an action'}`
                      : n.type === 'parallel'
                        ? `${count} agent${count === 1 ? '' : 's'} run together`
                        : n.type === 'email'
                          ? `To ${n.to || '…'}`
                          : `${n.value} ${n.operator} ${n.compare}`;
        const warning =
          n.type === 'agent' && !agent?.providerId
            ? 'Choose a model'
            : n.type === 'mcp' && (!n.connectionId || !n.tools.length)
              ? 'Select tools'
              : n.type === 'knowledge' && !n.knowledgeBaseId
                ? 'Select a knowledge base'
                : n.type === 'tool' && !n.tool
                  ? 'Choose an action'
                  : n.type === 'parallel' && !count
                    ? 'Choose agents'
                    : n.type === 'email' && /example\.com|^\s*$/.test(n.to)
                      ? 'Set the recipient'
                      : undefined;
        return {
          id: n.id,
          type: 'studio',
          position: n.position ?? { x: 60 + i * 300, y: 150 },
          selected: n.id === selected,
          measured: measurements[n.id],
          data: {
            item: n,
            detail,
            attached: count,
            warning,
            dropTarget: n.id === drag?.agentId,
            onOpen: openSettings,
          },
        };
      }),
    [form, data, selected, measurements, drag?.agentId],
  );
  function patch(id: string, values: Record<string, unknown>) {
    change((f) => ({
      ...f,
      nodes: f.nodes.map((n) => (n.id === id ? ({ ...n, ...values } as WorkflowNode) : n)),
      resources: f.resources.map((r) => (r.id === id ? ({ ...r, ...values } as WorkflowResource) : r)),
    }));
  }
  function patchAgent(id: string, patchValue: Partial<Agent>) {
    const node = formRef.current.nodes.find((n) => n.id === id);
    if (node?.type === 'agent')
      patch(id, {
        config: { ...defaultAgent(data), ...node.config, ...patchValue },
        ...(patchValue.name ? { name: patchValue.name } : {}),
      });
  }
  function rename(id: string, name: string) {
    const node = formRef.current.nodes.find((n) => n.id === id);
    if (node?.type === 'agent') patch(id, { name, config: { ...defaultAgent(data), ...node.config, name } });
    else patch(id, { name });
  }
  function safely(task: () => void) {
    try {
      task();
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function connect(c: Connection) {
    safely(() => change((f) => connectGraph(f, c)));
  }
  /** The agent card under a canvas point, so a toolbox item can be dropped straight onto it. */
  function agentAt(point: { x: number; y: number }) {
    return form.nodes.find((n) => {
      if (n.type !== 'agent' || !n.position) return false;
      const size = measurements[n.id] ?? { width: 250, height: 200 };
      return (
        point.x >= n.position.x &&
        point.x <= n.position.x + size.width &&
        point.y >= n.position.y &&
        point.y <= n.position.y + size.height
      );
    });
  }
  /** Where a pointer at these screen coordinates would drop: onto the canvas, and onto which agent card. */
  function dropPoint(x: number, y: number) {
    const rect = canvasRef.current?.getBoundingClientRect();
    const inside = Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    const position = inside ? flow?.screenToFlowPosition({ x, y }) : undefined;
    return { position, agent: position ? agentAt(position) : undefined };
  }
  function beginDrag(payload: Payload, label: string, e: React.PointerEvent) {
    if (e.button !== 0 || !e.isPrimary) return;
    const start = { x: e.clientX, y: e.clientY };
    const resource = payload.type === 'mcp' || payload.type === 'knowledge';
    let moved = false;
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('dragging-tool');
      setDrag(null);
    };
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      if (!moved) document.body.classList.add('dragging-tool');
      moved = true;
      ev.preventDefault();
      const point = dropPoint(ev.clientX, ev.clientY);
      setDrag({
        label,
        x: ev.clientX,
        y: ev.clientY,
        overCanvas: Boolean(point.position),
        agentId: resource ? point.agent?.id : undefined,
      });
    };
    const onUp = (ev: PointerEvent) => {
      finish();
      // A press that barely moved is a click; the item's click handler adds it.
      if (!moved) return;
      lastDragEnd = Date.now();
      const point = dropPoint(ev.clientX, ev.clientY);
      // Released outside the canvas: nothing is added.
      if (!point.position) return;
      add(payload, resource && point.agent ? undefined : point.position, point.agent?.id);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finish();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', onKey);
  }
  function add(payload: Payload, position?: { x: number; y: number }, anchorId?: string): string {
    let f = form;
    const type = payload.type;
    if (type === 'mcp' || type === 'knowledge') {
      let anchor =
        f.nodes.find((n) => n.id === anchorId && n.type === 'agent') ??
        f.nodes.find((n) => n.id === selected && n.type === 'agent') ??
        f.nodes.find((n) => n.type === 'agent');
      if (!anchor) {
        const id = newId('agent');
        anchor = {
          id,
          name: 'AI agent',
          type: 'agent',
          config: defaultAgent(data),
          prompt: '{{input}}',
          position: { x: 340, y: 110 },
        };
        f = insertStep(f, anchor, selected);
      }
      const id = newId(type);
      const pos = position ?? {
        x:
          (anchor.position?.x ?? 340) +
          f.resources.filter((r) =>
            f.bindings.some((b) => b.resourceId === r.id && b.agentNodeId === anchor!.id),
          ).length *
            280,
        y: (anchor.position?.y ?? 110) + 320,
      };
      let r: WorkflowResource;
      if (type === 'mcp') {
        const connection =
          data.connections.find((c) => c.id === payload.connectionId) ??
          data.connections.find((c) => c.enabled) ??
          data.connections[0];
        // Every discovered tool is granted to begin with; trim the list in the card's settings.
        r = {
          id,
          name: connection?.name ?? 'MCP tools',
          type,
          connectionId: connection?.id ?? '',
          tools: (connection?.tools ?? []).slice(0, 100).map((t: { name: string }) => t.name),
          position: pos,
        };
      } else {
        const kb = data.knowledge.find((k) => k.id === payload.knowledgeBaseId) ?? data.knowledge[0];
        r = { id, name: kb?.name ?? 'Knowledge', type, knowledgeBaseId: kb?.id ?? '', position: pos };
      }
      const withResource = {
        ...f,
        resources: [...f.resources, r],
        bindings: [...f.bindings, { agentNodeId: anchor.id, resourceId: id }],
      };
      change(position ? withResource : autoPlace(withResource));
      select(id);
      selectEdge('');
      reveal(id);
      return id;
    }
    const step = f.nodes.find((n) => n.id === selected);
    const id = newId(type),
      base = {
        id,
        name: labels[type],
        position: position ?? { x: (step?.position?.x ?? 220) + 310, y: step?.position?.y ?? 150 },
      };
    const n: WorkflowNode =
      type === 'agent'
        ? { ...base, type, config: defaultAgent(data), prompt: '{{last}}' }
        : type === 'tool'
          ? { ...base, type, connectionId: data.connections[0]?.id ?? '', tool: '', arguments: {} }
          : type === 'parallel'
            ? { ...base, type, agentNodeIds: [], agentIds: [], prompt: '{{last}}' }
            : type === 'condition'
              ? {
                  ...base,
                  type,
                  value: '{{last}}',
                  operator: 'contains',
                  compare: '',
                  onTrue: '',
                  onFalse: '',
                }
              : type === 'email'
                ? { ...base, type, to: '', subject: 'Report: {{input}}', body: '{{last}}' }
                : { ...base, type: 'finish', template: '{{last}}' };
    const inserted = type === 'finish' ? { ...f, nodes: [...f.nodes, n] } : insertStep(f, n, selected);
    change(position ? inserted : autoPlace(inserted));
    select(id);
    selectEdge('');
    reveal(id);
    return id;
  }
  /** A new agent card that only a Parallel step runs; it stays beside the execution path. */
  function addMember(parallelId: string) {
    const parallel = form.nodes.find((n) => n.id === parallelId);
    if (parallel?.type !== 'parallel') return;
    const id = newId('agent');
    const member: WorkflowNode = {
      id,
      name: `Agent ${parallel.agentNodeIds.length + 1}`,
      type: 'agent',
      config: { ...defaultAgent(data), name: `Agent ${parallel.agentNodeIds.length + 1}` },
      prompt: '{{input}}',
      position: { x: parallel.position?.x ?? 300, y: (parallel.position?.y ?? 100) + 260 },
    };
    change(
      autoPlace({
        ...form,
        nodes: [
          ...form.nodes.map((n) =>
            n.id === parallelId && n.type === 'parallel'
              ? { ...n, agentNodeIds: [...n.agentNodeIds, id] }
              : n,
          ),
          member,
        ],
      }),
    );
    reveal(id);
  }
  function reveal(id: string) {
    setTimeout(() => {
      if (!flow?.getNode(id)) return;
      void flow.fitView({ padding: 0.16, duration: 250, maxZoom: 1 });
    }, 60);
  }
  /** Lay out every card with the shared layout engine so nothing lands on top of another card. */
  function autoPlace(f: Workflow): Workflow {
    const items: GraphItem[] = [...f.nodes, ...f.resources];
    const links = [
      ...graphEdges(f)
        .filter((e) => !e.id.startsWith('resource:'))
        .map((e) => ({ from: e.source, to: e.target })),
      ...f.bindings.map((b) => ({ from: b.agentNodeId, to: b.resourceId, label: 'tool' })),
    ];
    const placed = layoutWorkflow(
      items.map((n) => ({ id: n.id, x: n.position?.x ?? 0, y: n.position?.y ?? 0 })),
      links,
      (n) => {
        const i = items.find((v) => v.id === n.id)!;
        return {
          width:
            i.type === 'start' || i.type === 'finish' || i.type === 'output'
              ? 175
              : i.type === 'mcp' || i.type === 'knowledge'
                ? 244
                : 286,
          height: i.type === 'agent' || i.type === 'parallel' ? 205 : 155,
        };
      },
      f.startAt,
    );
    const positions = new Map(placed.map((n) => [n.id, { x: n.x, y: n.y }]));
    return {
      ...f,
      nodes: f.nodes.map((n) => ({ ...n, position: positions.get(n.id) })),
      resources: f.resources.map((n) => ({ ...n, position: positions.get(n.id) })),
    };
  }
  function arrange() {
    change((f) => autoPlace(f));
    setTimeout(() => void flow?.fitView({ padding: 0.16, duration: 250, maxZoom: 1 }), 100);
  }
  function remove(id: string) {
    safely(() => {
      change((f) => removeGraphNode(f, id));
      select('');
      if (open?.kind === 'node' && open.id === id) setOpen(null);
    });
  }
  async function save(run = false) {
    setBusy(true);
    setError('');
    try {
      if (
        tab === 'canvas' &&
        Object.entries(invalidArguments).some(
          ([id, invalid]) => invalid && form.nodes.some((n) => n.id === id),
        )
      )
        throw new Error('Fix the invalid tool argument JSON before saving.');
      const parsed = workflowSchema.safeParse(tab === 'yaml' ? parse(yaml) : form);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .slice(0, 5)
            .map((i) => i.message)
            .join(' · '),
        );
      const result = await api<Entity>(`/workflows${value ? `/${value.id}` : ''}`, {
        method: value ? 'PUT' : 'POST',
        headers: value ? { 'If-Match': String(value.revision ?? 0) } : undefined,
        body: JSON.stringify(parsed.data),
      });
      await onSaved();
      setDirty(false);
      onClose();
      if (run) onRun?.(result.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const nextOptions = (self?: WorkflowNode) =>
    form.nodes.filter((n) => (n.id !== self?.id || self?.type === 'condition') && n.type !== 'start');
  const selectedLink = edges.find((e) => e.id === selectedEdge);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select,.modal')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        travel(e.shiftKey ? 'redo' : 'undo');
      }
      if (e.key === 'Enter' && selected && !open) {
        e.preventDefault();
        setOpen({ kind: 'node', id: selected });
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedEdge && selectedLink) {
          e.preventDefault();
          change(disconnectGraph(form, selectedLink));
          selectEdge('');
        } else if (selected) {
          e.preventDefault();
          remove(selected);
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [form, selected, selectedEdge, open]);

  function flowSelect(step: WorkflowNode, label: string, field: string, current: string | undefined) {
    return (
      <Field label={label}>
        <select
          aria-label={label}
          value={current ?? ''}
          onChange={(e) => patch(step.id, { [field]: e.target.value || undefined })}
        >
          <option value="">Not connected</option>
          {nextOptions(step).map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  const curl = value?.id
    ? `curl -X POST '${publicUrl}/api/runs' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: unique-request-id' \\\n  -d '{"workflowId": "${value.id}", "input": "Hello"}'`
    : '';
  const read = `# poll until status is succeeded or failed\ncurl '${publicUrl}/api/runs/RUN_ID' -H 'Authorization: Bearer YOUR_API_KEY'\n\n# or stream the trace and answer as they happen\ncurl -N '${publicUrl}/api/runs/RUN_ID/stream' -H 'Authorization: Bearer YOUR_API_KEY'`;
  const enabledConnections = data.connections.filter((c) => c.enabled && c.kind !== 'device');
  const machineConnections = data.connections.filter((c) => c.kind === 'device');
  return (
    <div
      className="workflow-screen harness-editor"
      role="dialog"
      aria-modal="true"
      aria-label="Workflow editor"
      data-history={historyVersion}
    >
      {drag &&
        createPortal(
          <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">
            {drag.label}
            <small>
              {drag.agentId
                ? 'Attach to this agent'
                : drag.overCanvas
                  ? 'Drop on the canvas'
                  : 'Drag onto the canvas'}
            </small>
          </div>,
          document.body,
        )}
      <header className="workflow-header">
        <IconButton title="Close workflow editor" onClick={onClose}>
          <X size={20} />
        </IconButton>
        <div className="workflow-name">
          <input
            aria-label="Workflow name"
            value={form.name}
            disabled={tab === 'yaml'}
            onChange={(e) => change({ ...form, name: e.target.value })}
          />
          <small>
            {dirty ? 'Unsaved' : 'Saved'} · {form.nodes.length} steps
            {form.schedule?.enabled ? ` · ${describeSchedule(form.schedule)}` : ''}
          </small>
        </div>
        <div className="history-actions">
          <IconButton
            title="Undo graph change"
            disabled={!undo.current.length}
            onClick={() => travel('undo')}
          >
            <Undo2 size={17} />
          </IconButton>
          <IconButton
            title="Redo graph change"
            disabled={!redo.current.length}
            onClick={() => travel('redo')}
          >
            <Redo2 size={17} />
          </IconButton>
        </div>
        <div className="segmented">
          <button
            className={tab === 'canvas' ? 'active' : ''}
            onClick={() =>
              safely(() => {
                if (tab === 'yaml') {
                  const parsed = workflowSchema.safeParse(parse(yaml));
                  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join(' · '));
                  change(editableWorkflow(parsed.data, data));
                  setArgumentDrafts({});
                  setInvalidArguments({});
                }
                setTab('canvas');
              })
            }
          >
            Canvas
          </button>
          <button
            className={tab === 'yaml' ? 'active' : ''}
            onClick={() => {
              setYaml(stringify(form));
              setTab('yaml');
            }}
          >
            YAML
          </button>
        </div>
        <Button variant="secondary" onClick={() => setOpen({ kind: 'workflow' })}>
          <Settings2 size={15} />
          Settings
        </Button>
        <Button variant="secondary" onClick={() => setOpen({ kind: 'api' })}>
          <Code2 size={15} />
          Use in your app
        </Button>
        <IconButton
          title="Export workflow YAML"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([stringify(form)], { type: 'application/yaml' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'workflow.yaml';
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download size={18} />
        </IconButton>
        <Button variant="secondary" disabled={busy} onClick={() => void save(true)}>
          <Play size={15} />
          Save & test
        </Button>
        <Button disabled={busy} onClick={() => void save()}>
          <Save size={16} />
          Save
        </Button>
      </header>
      {error && (
        <div className="workflow-error">
          <ErrorNotice error={error} />
          <IconButton title="Dismiss workflow error" onClick={() => setError('')}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      <div className="workflow-body">
        <aside className="toolbox" aria-label="Toolbox">
          <div className="toolbox-group">
            <h4>Steps</h4>
            {stepTypes.map((type) => (
              <ToolItem
                key={type}
                payload={{ type }}
                label={labels[type]}
                hint={stepHints[type]}
                icon={icons[type]}
                onAdd={() => add({ type })}
                onDragStart={beginDrag}
              />
            ))}
          </div>
          <div className="toolbox-group">
            <h4>
              MCP tools
              <button
                type="button"
                className="icon-button small"
                aria-label="Connect MCP server"
                title="Connect an MCP server"
                onClick={() => setAdding('connection')}
              >
                <Plus size={14} />
              </button>
            </h4>
            {enabledConnections.length ? (
              enabledConnections.map((c) => (
                <ToolItem
                  key={c.id}
                  className="mcp"
                  payload={{ type: 'mcp', connectionId: c.id }}
                  label={c.name}
                  hint={c.tools?.length ? `${c.tools.length} tools` : 'No tools discovered'}
                  icon={Plug}
                  onAdd={() => add({ type: 'mcp', connectionId: c.id })}
                  onDragStart={beginDrag}
                />
              ))
            ) : (
              <p className="toolbox-empty">No servers connected.</p>
            )}
          </div>
          {machineConnections.length > 0 && (
            <div className="toolbox-group">
              <h4>Machines</h4>
              {machineConnections.map((c) => {
                const machine = data.machines.find((m) => m.device_id === c.deviceId);
                return (
                  <ToolItem
                    key={c.id}
                    className="machine"
                    payload={{ type: 'mcp', connectionId: c.id }}
                    label={c.name}
                    hint={`${c.platform ?? 'machine'} · ${machine?.online ? 'online' : 'offline'} · ${c.tools?.length ?? 0} tools`}
                    icon={Laptop}
                    onAdd={() => add({ type: 'mcp', connectionId: c.id })}
                    onDragStart={beginDrag}
                  />
                );
              })}
            </div>
          )}
          <div className="toolbox-group">
            <h4>
              Knowledge
              <button
                type="button"
                className="icon-button small"
                aria-label="Create knowledge base"
                title="Create a knowledge base"
                onClick={() => setAdding('knowledge')}
              >
                <Plus size={14} />
              </button>
            </h4>
            {data.knowledge.length ? (
              data.knowledge.map((k) => (
                <ToolItem
                  key={k.id}
                  className="knowledge"
                  payload={{ type: 'knowledge', knowledgeBaseId: k.id }}
                  label={k.name}
                  hint="Documents & notes"
                  icon={BookOpen}
                  onAdd={() => add({ type: 'knowledge', knowledgeBaseId: k.id })}
                  onDragStart={beginDrag}
                />
              ))
            ) : (
              <p className="toolbox-empty">No knowledge bases.</p>
            )}
          </div>
          <p className="toolbox-hint">
            Drag onto the canvas or onto an agent. Double-click a card to edit it.
          </p>
        </aside>
        {tab === 'yaml' ? (
          <textarea
            className="yaml-editor"
            aria-label="Workflow YAML"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            spellCheck={false}
          />
        ) : (
          <div ref={canvasRef} className={`flow-canvas ${drag?.overCanvas ? 'drop-active' : ''}`}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={setFlow}
              onConnect={connect}
              connectionMode={ConnectionMode.Loose}
              connectOnClick
              connectionRadius={35}
              edgesReconnectable
              onReconnect={(old, c) => safely(() => change((f) => connectGraph(disconnectGraph(f, old), c)))}
              onNodeClick={(_, n) => {
                select(n.id);
                selectEdge('');
              }}
              onNodeDoubleClick={(_, n) => openSettings(n.id)}
              onPaneClick={() => {
                select('');
                selectEdge('');
              }}
              onEdgeClick={(_, e) => {
                selectEdge(e.id);
                select('');
              }}
              onEdgesDelete={(removed) => change((f) => removed.reduce(disconnectGraph, f))}
              onNodesDelete={(removed) =>
                safely(() => change((f) => removed.reduce((v, n) => removeGraphNode(v, n.id), f)))
              }
              onNodeDragStart={() => remember(form)}
              onNodesChange={(changes) => {
                const dims = changes.filter((c) => c.type === 'dimensions');
                if (dims.length)
                  setMeasurements((old) => {
                    let changed = false;
                    const next = { ...old };
                    for (const c of dims)
                      if (
                        c.type === 'dimensions' &&
                        c.dimensions &&
                        (next[c.id]?.width !== c.dimensions.width ||
                          next[c.id]?.height !== c.dimensions.height)
                      ) {
                        next[c.id] = c.dimensions;
                        changed = true;
                      }
                    return changed ? next : old;
                  });
                const moves = changes.filter((c) => c.type === 'position');
                if (moves.length)
                  change((f) => {
                    const place = <T extends GraphItem>(n: T): T => {
                      const c = moves.find((c) => c.id === n.id);
                      return c?.type === 'position' && c.position ? { ...n, position: c.position } : n;
                    };
                    return { ...f, nodes: f.nodes.map(place), resources: f.resources.map(place) };
                  }, false);
              }}
              fitView
              fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.7}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: false }}
            >
              <Background color="#d3dce6" gap={24} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(n) =>
                  n.selected
                    ? '#49a2dc'
                    : (n.data as FlowData).item.type === 'mcp'
                      ? '#c4b5d6'
                      : (n.data as FlowData).item.type === 'knowledge'
                        ? '#a9dcd3'
                        : '#c9d6e3'
                }
                maskColor="rgba(239,243,247,.8)"
                pannable
                zoomable
              />
            </ReactFlow>
            {(item || selectedLink) && (
              <div className="canvas-selection" role="toolbar" aria-label="Selection">
                {selectedLink ? (
                  <>
                    <span>
                      <strong>{all.find((n) => n.id === selectedLink.source)?.name}</strong> →{' '}
                      <strong>{all.find((n) => n.id === selectedLink.target)?.name}</strong>
                    </span>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        change((f) => disconnectGraph(f, selectedLink));
                        selectEdge('');
                      }}
                    >
                      <Unplug size={14} />
                      Disconnect
                    </Button>
                  </>
                ) : (
                  item && (
                    <>
                      <span>
                        <small>{labels[item.type]}</small>
                        <strong>{item.name}</strong>
                      </span>
                      <Button variant="secondary" onClick={() => setOpen({ kind: 'node', id: item.id })}>
                        <Settings2 size={14} />
                        Settings
                      </Button>
                      {item.type !== 'start' && (
                        <IconButton title="Delete selected component" onClick={() => remove(item.id)}>
                          <Trash2 size={15} />
                        </IconButton>
                      )}
                    </>
                  )
                )}
              </div>
            )}
            <Button className="arrange-button" variant="secondary" onClick={arrange}>
              <LayoutGrid size={15} />
              Auto layout
            </Button>
          </div>
        )}
      </div>
      {open?.kind === 'node' && openItem && (
        <Modal
          title={`${labels[openItem.type]}${openItem.name !== labels[openItem.type] ? ` · ${openItem.name}` : ''}`}
          onClose={() => setOpen(null)}
          wide={openItem.type === 'agent' || openItem.type === 'mcp' || openItem.type === 'tool'}
        >
          <div className="form-content node-settings">
            {openItem.type !== 'start' && (
              <Field label="Name">
                <input
                  aria-label="Component name"
                  value={openItem.name}
                  onChange={(e) => rename(openItem.id, e.target.value)}
                />
              </Field>
            )}
            {openStep?.type === 'start' && (
              <>
                <p className="field-help">
                  Runs start here from the playground, the API, a webhook or a schedule. The message is{' '}
                  <code>{'{{input}}'}</code>.
                </p>
                {flowSelect(openStep, 'First step', 'next', openStep.next)}
                <div className="compact-actions">
                  <Button variant="secondary" onClick={() => setOpen({ kind: 'workflow' })}>
                    <Clock3 size={14} />
                    Schedule
                  </Button>
                  <Button variant="secondary" onClick={() => setOpen({ kind: 'api' })}>
                    <Code2 size={14} />
                    Use in your app
                  </Button>
                </div>
              </>
            )}
            {openStep?.type === 'agent' && (
              <>
                <AgentFields
                  value={{ ...defaultAgent(data), ...openStep.config, name: openStep.name }}
                  data={data}
                  refresh={onSaved}
                  onChange={(p) => patchAgent(openStep.id, p)}
                />
                <Field
                  label="Message to this agent"
                  hint="{{input}} is the run input, {{last}} the previous step."
                >
                  <textarea
                    aria-label="Input prompt"
                    rows={2}
                    value={openStep.prompt}
                    onChange={(e) => patch(openStep.id, { prompt: e.target.value })}
                  />
                </Field>
                <div className="form-section">
                  <h3>
                    <Plug size={16} /> Tools & knowledge
                  </h3>
                  {form.bindings
                    .filter((b) => b.agentNodeId === openStep.id)
                    .map((b) => {
                      const r = form.resources.find((r) => r.id === b.resourceId)!;
                      return (
                        <div className="binding-row" key={r.id}>
                          <button type="button" onClick={() => setOpen({ kind: 'node', id: r.id })}>
                            {r.type === 'mcp' ? <Plug size={14} /> : <BookOpen size={14} />}
                            {r.name}
                            <small>{r.type === 'mcp' ? `${r.tools.length} tools` : 'knowledge'}</small>
                          </button>
                          <IconButton
                            title={`Disconnect ${r.name}`}
                            onClick={() =>
                              change({ ...form, bindings: form.bindings.filter((v) => v !== b) })
                            }
                          >
                            <Unplug size={14} />
                          </IconButton>
                        </div>
                      );
                    })}
                  <div className="compact-actions">
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setOpen({ kind: 'node', id: add({ type: 'mcp' }, undefined, openStep.id) })
                      }
                    >
                      <Plus size={13} />
                      MCP tools
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setOpen({ kind: 'node', id: add({ type: 'knowledge' }, undefined, openStep.id) })
                      }
                    >
                      <Plus size={13} />
                      Knowledge
                    </Button>
                  </div>
                </div>
              </>
            )}
            {openResource?.type === 'mcp' && (
              <McpControl
                data={data}
                refresh={onSaved}
                connectionId={openResource.connectionId}
                tools={openResource.tools}
                onChange={(connectionId, tools) =>
                  patch(openResource.id, {
                    connectionId,
                    tools,
                    name: data.connections.find((c) => c.id === connectionId)?.name ?? openResource.name,
                  })
                }
              />
            )}
            {openResource?.type === 'knowledge' && (
              <KnowledgeControl
                data={data}
                refresh={onSaved}
                value={openResource.knowledgeBaseId}
                onChange={(knowledgeBaseId) =>
                  patch(openResource.id, {
                    knowledgeBaseId,
                    name: data.knowledge.find((k) => k.id === knowledgeBaseId)?.name ?? openResource.name,
                  })
                }
              />
            )}
            {openResource && (
              <div className="form-section">
                <h3>Used by</h3>
                {agentNodes.length ? (
                  agentNodes.map((n) => (
                    <label className="check-row" key={n.id}>
                      <input
                        type="checkbox"
                        checked={form.bindings.some(
                          (b) => b.resourceId === openResource.id && b.agentNodeId === n.id,
                        )}
                        onChange={(e) =>
                          change((f) => ({
                            ...f,
                            bindings: e.target.checked
                              ? [...f.bindings, { agentNodeId: n.id, resourceId: openResource.id }]
                              : f.bindings.filter(
                                  (b) => !(b.resourceId === openResource.id && b.agentNodeId === n.id),
                                ),
                          }))
                        }
                      />
                      {n.name}
                    </label>
                  ))
                ) : (
                  <p className="field-help">Add an agent first.</p>
                )}
              </div>
            )}
            {openStep?.type === 'tool' && (
              <>
                <div className="two-columns">
                  <Field label="MCP server">
                    <select
                      aria-label="Action MCP connection"
                      value={openStep.connectionId}
                      onChange={(e) => {
                        setArgumentDrafts((drafts) => {
                          const next = { ...drafts };
                          delete next[openStep.id];
                          return next;
                        });
                        setInvalidArguments((v) => ({ ...v, [openStep.id]: false }));
                        patch(openStep.id, { connectionId: e.target.value, tool: '', arguments: {} });
                      }}
                    >
                      <option value="">Choose a server</option>
                      {data.connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Tool">
                    <select
                      aria-label="Action tool"
                      value={openStep.tool}
                      onChange={(e) => patch(openStep.id, { tool: e.target.value })}
                    >
                      <option value="">Choose a tool</option>
                      {data.connections
                        .find((c) => c.id === openStep.connectionId)
                        ?.tools?.map((t: any) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>
                <ArgumentEditor
                  key={openStep.id}
                  value={openStep.arguments}
                  draft={argumentDrafts[openStep.id]}
                  schema={
                    data.connections
                      .find((c) => c.id === openStep.connectionId)
                      ?.tools?.find((t: any) => t.name === openStep.tool)?.inputSchema
                  }
                  onChange={(v, invalid, text) => {
                    setArgumentDrafts((d) => ({ ...d, [openStep.id]: text }));
                    setInvalidArguments((d) => ({ ...d, [openStep.id]: invalid }));
                    if (!invalid) patch(openStep.id, { arguments: v });
                  }}
                />
              </>
            )}
            {openStep?.type === 'email' && (
              <>
                <Field label="To" hint="Comma-separated. Templates work: {{payload.email}}.">
                  <input
                    aria-label="Email recipients"
                    placeholder="team@example.com"
                    value={openStep.to}
                    onChange={(e) => patch(openStep.id, { to: e.target.value })}
                  />
                </Field>
                <Field label="Subject">
                  <input
                    aria-label="Email subject"
                    value={openStep.subject}
                    onChange={(e) => patch(openStep.id, { subject: e.target.value })}
                  />
                </Field>
                <Field label="Body">
                  <textarea
                    aria-label="Email body"
                    rows={5}
                    value={openStep.body}
                    onChange={(e) => patch(openStep.id, { body: e.target.value })}
                  />
                </Field>
                <p className="field-help">Sent through Settings → Email.</p>
              </>
            )}
            {openStep?.type === 'condition' && (
              <>
                <div className="two-columns">
                  <Field label="Value">
                    <input
                      aria-label="Condition value"
                      value={openStep.value}
                      onChange={(e) => patch(openStep.id, { value: e.target.value })}
                    />
                  </Field>
                  <Field label="Comparison">
                    <select
                      aria-label="Condition operator"
                      value={openStep.operator}
                      onChange={(e) => patch(openStep.id, { operator: e.target.value })}
                    >
                      {['equals', 'notEquals', 'contains', 'truthy', 'greaterThan'].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Compare with">
                  <input
                    aria-label="Condition compare value"
                    value={openStep.compare}
                    onChange={(e) => patch(openStep.id, { compare: e.target.value })}
                  />
                </Field>
                <div className="two-columns">
                  {flowSelect(openStep, 'When yes', 'onTrue', openStep.onTrue)}
                  {flowSelect(openStep, 'When no', 'onFalse', openStep.onFalse)}
                </div>
              </>
            )}
            {openStep?.type === 'parallel' && (
              <>
                <Field label="Message to each agent">
                  <textarea
                    aria-label="Parallel input prompt"
                    rows={2}
                    value={openStep.prompt}
                    onChange={(e) => patch(openStep.id, { prompt: e.target.value })}
                  />
                </Field>
                <div className="form-section">
                  <h3>Agents that run together</h3>
                  {agentNodes.map((a) => (
                    <label className="check-row" key={a.id}>
                      <input
                        type="checkbox"
                        checked={openStep.agentNodeIds.includes(a.id)}
                        onChange={(e) =>
                          patch(openStep.id, {
                            agentNodeIds: e.target.checked
                              ? [...openStep.agentNodeIds, a.id]
                              : openStep.agentNodeIds.filter((id) => id !== a.id),
                          })
                        }
                      />
                      {a.name}
                    </label>
                  ))}
                  <Button variant="secondary" onClick={() => addMember(openStep.id)}>
                    <Plus size={13} />
                    New agent in this group
                  </Button>
                  {data.agents.length > 0 && (
                    <details>
                      <summary>Saved agents</summary>
                      {data.agents.map((a) => (
                        <label className="check-row" key={a.id}>
                          <input
                            type="checkbox"
                            checked={openStep.agentIds.includes(a.id)}
                            onChange={(e) =>
                              patch(openStep.id, {
                                agentIds: e.target.checked
                                  ? [...openStep.agentIds, a.id]
                                  : openStep.agentIds.filter((id) => id !== a.id),
                              })
                            }
                          />
                          {a.name}
                        </label>
                      ))}
                    </details>
                  )}
                </div>
              </>
            )}
            {openStep && isFinish(openStep) && 'template' in openStep && (
              <Field
                label="Final response"
                hint="{{last}} returns the previous step; {{steps.id}} any earlier one."
              >
                <textarea
                  aria-label="Final response template"
                  rows={5}
                  value={openStep.template}
                  onChange={(e) => patch(openStep.id, { template: e.target.value })}
                />
              </Field>
            )}
            {openStep &&
              !isFinish(openStep) &&
              openStep.type !== 'condition' &&
              openStep.type !== 'start' &&
              flowSelect(openStep, 'Next step', 'next', openStep.next)}
          </div>
          <div className="form-actions between">
            {openItem.type !== 'start' ? (
              <Button variant="danger" onClick={() => remove(openItem.id)}>
                <Trash2 size={15} />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={() => setOpen(null)}>Done</Button>
          </div>
        </Modal>
      )}
      {open?.kind === 'workflow' && (
        <Modal title="Workflow settings" onClose={() => setOpen(null)} wide>
          <div className="form-content">
            <Field label="Description">
              <textarea
                aria-label="Workflow description"
                rows={2}
                value={form.description}
                onChange={(e) => change({ ...form, description: e.target.value })}
              />
            </Field>
            <div className="two-columns">
              <Field label="Step budget" hint="Loops stop at this limit.">
                <input
                  aria-label="Workflow step budget"
                  type="number"
                  min={1}
                  max={500}
                  value={form.maxSteps}
                  onChange={(e) => change({ ...form, maxSteps: Number(e.target.value) })}
                />
              </Field>
              <Field
                label="If a runner crashes"
                hint={
                  (form.resumePolicy ?? 'safe') === 'safe'
                    ? 'Resume unless a tool or email step was in flight.'
                    : (form.resumePolicy ?? 'safe') === 'always'
                      ? 'Always resume, even if a tool may already have acted.'
                      : 'Mark the run interrupted for review.'
                }
              >
                <select
                  aria-label="Resume policy"
                  value={form.resumePolicy ?? 'safe'}
                  onChange={(e) =>
                    change({ ...form, resumePolicy: e.target.value as Workflow['resumePolicy'] })
                  }
                >
                  <option value="safe">Resume when safe</option>
                  <option value="always">Always resume</option>
                  <option value="never">Never resume</option>
                </select>
              </Field>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => change({ ...form, enabled: e.target.checked })}
              />
              Workflow enabled
            </label>
            <div className="form-section">
              <h3>
                <BookOpen size={16} /> Knowledge workspace
              </h3>
              <Field
                label="Workspace"
                hint="Agents search it, read only what they need, and record findings, decisions and feedback there."
              >
                <select
                  aria-label="Knowledge workspace"
                  value={form.workspace?.knowledgeBaseId ?? ''}
                  onChange={(e) =>
                    change({
                      ...form,
                      workspace: e.target.value
                        ? {
                            knowledgeBaseId: e.target.value,
                            offloadToolResults: form.workspace?.offloadToolResults ?? true,
                          }
                        : undefined,
                      ...(e.target.value ? {} : { experience: undefined }),
                    })
                  }
                >
                  <option value="">No workspace</option>
                  {data.knowledge.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
              </Field>
              {form.workspace && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    aria-label="Offload large tool results"
                    checked={form.workspace.offloadToolResults !== false}
                    onChange={(e) =>
                      change({
                        ...form,
                        workspace: { ...form.workspace!, offloadToolResults: e.target.checked },
                      })
                    }
                  />
                  Save large tool results as notes and keep only a summary in the agent’s context
                </label>
              )}
              {form.workspace && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    aria-label="Learn from experience"
                    checked={Boolean(form.experience?.enabled)}
                    onChange={(e) =>
                      change({
                        ...form,
                        experience: {
                          recallLimit: form.experience?.recallLimit ?? 3,
                          learnFromFailures: form.experience?.learnFromFailures ?? true,
                          enabled: e.target.checked,
                        },
                      })
                    }
                  />
                  Learn from experience: turn feedback and failures into lessons in experience/ and recall
                  them in later runs
                </label>
              )}
            </div>
            <div className="form-section">
              <h3>
                <Clock3 size={16} /> Schedule
              </h3>
              <ScheduleFields
                value={form.schedule}
                onChange={(schedule) => change({ ...form, schedule })}
                nextRunAt={value?.nextRunAt}
                lastError={value?.lastScheduleError}
              />
            </div>
          </div>
          <div className="form-actions">
            <Button onClick={() => setOpen(null)}>Done</Button>
          </div>
        </Modal>
      )}
      {open?.kind === 'api' && (
        <Modal title="Use in your app" onClose={() => setOpen(null)} wide>
          <div className="form-content">
            {!value?.id ? (
              <div className="notice">Save the workflow first. Its ID is what other apps call.</div>
            ) : (
              <>
                <p className="field-help">
                  Create an API key in Integrations, then start runs from any language. Webhooks accept JSON
                  from other systems; schedules run without a caller.
                </p>
                <div className="code-card">
                  <div>
                    <span>Start a run</span>
                    <CopyButton value={curl} />
                  </div>
                  <pre>{curl}</pre>
                </div>
                <div className="code-card">
                  <div>
                    <span>Read the result</span>
                    <CopyButton value={read} />
                  </div>
                  <pre>{read}</pre>
                </div>
              </>
            )}
          </div>
          <div className="form-actions between">
            <Button
              variant="secondary"
              onClick={() => {
                if (dirty && !confirm('Leave without saving your changes?')) return;
                onClose();
                onNavigate?.('integrations');
              }}
            >
              <Code2 size={14} />
              Open Integrations
            </Button>
            <Button onClick={() => setOpen(null)}>Done</Button>
          </div>
        </Modal>
      )}
      {adding === 'connection' && (
        <ConnectionEditor
          data={data}
          onClose={() => setAdding(null)}
          onSaved={async (c) => {
            await onSaved();
            if (c) add({ type: 'mcp', connectionId: c.id });
          }}
        />
      )}
      {adding === 'knowledge' && (
        <KnowledgeEditor
          data={data}
          onClose={() => setAdding(null)}
          onSaved={async (k) => {
            await onSaved();
            if (k) add({ type: 'knowledge', knowledgeBaseId: k.id });
          }}
        />
      )}
    </div>
  );
}
function ArgumentEditor({
  value,
  draft,
  schema,
  onChange,
}: {
  value: Record<string, unknown>;
  draft?: string;
  schema?: any;
  onChange: (value: Record<string, unknown>, invalid: boolean, text: string) => void;
}) {
  const text = draft ?? JSON.stringify(value, null, 2);
  let error = '';
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
  } catch {
    error = 'Enter a JSON object.';
  }
  return (
    <>
      <Field label="Arguments (JSON)" hint="Templates like {{input}} fill values.">
        <textarea
          aria-label="Tool arguments JSON"
          rows={6}
          value={text}
          onChange={(e) => {
            try {
              const parsed = JSON.parse(e.target.value);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
              onChange(parsed, false, e.target.value);
            } catch {
              onChange(value, true, e.target.value);
            }
          }}
        />
      </Field>
      <ErrorNotice error={error} />
      {schema && (
        <details>
          <summary>Tool input schema</summary>
          <pre className="tool-schema">{JSON.stringify(schema, null, 2)}</pre>
        </details>
      )}
    </>
  );
}
