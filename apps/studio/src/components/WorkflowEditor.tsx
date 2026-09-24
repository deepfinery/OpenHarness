import { useEffect, useMemo, useRef, useState } from 'react';
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
  Check,
  Download,
  Flag,
  GitBranch,
  GitFork,
  LayoutGrid,
  Play,
  Plug,
  Plus,
  Redo2,
  Save,
  Trash2,
  Undo2,
  Unplug,
  X,
} from 'lucide-react';
import { parse, stringify } from 'yaml';
import {
  agentSchema,
  workflowSchema,
  type Agent,
  type Workflow,
  type WorkflowNode,
  type WorkflowResource,
} from '../../../../packages/core/src/schema.js';
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
import { Button, ErrorNotice, Field, IconButton } from './ui';
import { KnowledgeControl, McpControl, ProviderControl } from './ResourceControls';

type GraphItem = WorkflowNode | WorkflowResource;
type FlowData = { item: GraphItem; detail: string; attached: number; warning?: string } & Record<
  string,
  unknown
>;
const icons = {
  start: Play,
  finish: Flag,
  output: Flag,
  agent: Bot,
  tool: Plug,
  condition: GitBranch,
  parallel: GitFork,
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
  mcp: 'MCP tools',
  knowledge: 'Knowledge',
};
function GraphCard({ data, selected }: NodeProps<Node<FlowData>>) {
  const n = data.item,
    Icon = icons[n.type],
    resource = n.type === 'mcp' || n.type === 'knowledge',
    finish = n.type === 'finish' || n.type === 'output';
  return (
    <div
      className={`flow-card harness-card kind-${n.type} ${selected ? 'selected' : ''} ${data.warning ? 'needs-config' : ''}`}
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
      <div className="flow-card-top">
        <span className="node-icon">
          <Icon size={20} />
        </span>
        <div>
          <small>{labels[n.type]}</small>
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
              ? `${data.attached} agent${data.attached === 1 ? '' : 's'} connected`
              : 'Drag to an agent’s Tools or Knowledge port'}
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
export function WorkflowEditor({
  value,
  draft,
  data,
  onClose,
  onSaved,
  onRun,
}: {
  value?: Entity;
  draft?: Workflow;
  data: Data;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onRun?: (id: string) => void;
}) {
  const [form, setForm] = useState<Workflow>(() => editableWorkflow(value ?? draft, data));
  const [selected, select] = useState(form.nodes.find((n) => n.type === 'agent')?.id ?? form.startAt),
    [selectedEdge, selectEdge] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<'canvas' | 'yaml'>('canvas'),
    [yaml, setYaml] = useState('');
  const [argumentDrafts, setArgumentDrafts] = useState<Record<string, string>>({});
  const [invalidArguments, setInvalidArguments] = useState<Record<string, boolean>>({}),
    [dirty, setDirty] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance<Node<FlowData>> | null>(null);
  const [measurements, setMeasurements] = useState<Record<string, { width: number; height: number }>>({});
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
  const item = all.find((n) => n.id === selected),
    step = form.nodes.find((n) => n.id === selected),
    resource = form.resources.find((r) => r.id === selected);
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
              ? '#6887ae'
              : '#9673b7'
            : '#4e826c',
          strokeWidth: 2,
          strokeDasharray: edge.id.startsWith('resource:') ? '6 5' : undefined,
        },
        markerEnd: edge.id.startsWith('flow:')
          ? { type: MarkerType.ArrowClosed, color: '#4e826c', width: 18, height: 18 }
          : undefined,
        labelStyle: { fill: '#476253', fontSize: 11 },
        labelBgStyle: { fill: '#f8faf7' },
      })),
    [form, selectedEdge],
  );
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
            : form.bindings.filter((b) => b.resourceId === n.id).length;
        const detail =
          n.type === 'agent'
            ? (data.providers.find((p) => p.id === agent?.providerId)?.model ?? 'Choose a model')
            : n.type === 'start'
              ? 'API · Chat · Webhook · Schedule'
              : n.type === 'finish' || n.type === 'output'
                ? 'Return the workflow result'
                : n.type === 'mcp'
                  ? `${connection?.name ?? 'Choose a server'} · ${n.tools.length} tools`
                  : n.type === 'knowledge'
                    ? (knowledge?.name ?? 'Choose a knowledge base')
                    : n.type === 'tool'
                      ? `${connection?.name ?? 'MCP server'} / ${n.tool || 'Choose an action'}`
                      : n.type === 'parallel'
                        ? `${n.agentIds.length} agents`
                        : `${n.value} ${n.operator} ${n.compare}`;
        const warning =
          n.type === 'agent' && !agent?.providerId
            ? 'Select a model to run'
            : n.type === 'mcp' && (!n.connectionId || !n.tools.length)
              ? 'Select tools'
              : n.type === 'knowledge' && !n.knowledgeBaseId
                ? 'Select a knowledge base'
                : undefined;
        return {
          id: n.id,
          type: 'studio',
          position: n.position ?? { x: 60 + i * 300, y: 150 },
          selected: n.id === selected,
          measured: measurements[n.id],
          data: { item: n, detail, attached: count, warning },
        };
      }),
    [form, data, selected, measurements],
  );
  function patch(id: string, values: Record<string, unknown>) {
    change((f) => ({
      ...f,
      nodes: f.nodes.map((n) => (n.id === id ? ({ ...n, ...values } as WorkflowNode) : n)),
      resources: f.resources.map((r) => (r.id === id ? ({ ...r, ...values } as WorkflowResource) : r)),
    }));
  }
  function patchAgent(patchValue: Partial<Agent>) {
    if (step?.type === 'agent')
      patch(step.id, { config: { ...defaultAgent(data), ...step.config, ...patchValue } });
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
  function add(
    type: 'agent' | 'tool' | 'parallel' | 'condition' | 'finish' | 'mcp' | 'knowledge',
    position?: { x: number; y: number },
  ) {
    let f = form;
    let anchor =
      f.nodes.find((n) => n.id === selected && n.type === 'agent') ?? f.nodes.find((n) => n.type === 'agent');
    if (type === 'mcp' || type === 'knowledge') {
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
      const id = newId(type),
        pos = position ?? {
          x:
            (anchor.position?.x ?? 340) +
            f.resources.filter((r) =>
              f.bindings.some((b) => b.resourceId === r.id && b.agentNodeId === anchor!.id),
            ).length *
              280,
          y: (anchor.position?.y ?? 110) + 320,
        };
      const r: WorkflowResource =
        type === 'mcp'
          ? {
              id,
              name: 'MCP tools',
              type,
              connectionId: data.connections[0]?.id ?? '',
              tools: [],
              position: pos,
            }
          : { id, name: 'Knowledge', type, knowledgeBaseId: data.knowledge[0]?.id ?? '', position: pos };
      change({
        ...f,
        resources: [...f.resources, r],
        bindings: [...f.bindings, { agentNodeId: anchor.id, resourceId: id }],
      });
      select(id);
      selectEdge('');
      return;
    }
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
            ? { ...base, type, agentIds: data.agents[0] ? [data.agents[0].id] : [], prompt: '{{last}}' }
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
              : { ...base, type: 'finish', template: '{{last}}' };
    change(type === 'finish' ? { ...f, nodes: [...f.nodes, n] } : insertStep(f, n, selected));
    select(id);
    selectEdge('');
  }
  function arrange() {
    const items = [...form.nodes, ...form.resources];
    const links = [
      ...edges.filter((e) => e.id.startsWith('flow:')).map((e) => ({ from: e.source, to: e.target })),
      ...form.bindings.map((b) => ({ from: b.agentNodeId, to: b.resourceId, label: 'tool' })),
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
          height: i.type === 'agent' ? 205 : 155,
        };
      },
      form.startAt,
    );
    const positions = new Map(placed.map((n) => [n.id, { x: n.x, y: n.y }]));
    change((f) => ({
      ...f,
      nodes: f.nodes.map((n) => ({ ...n, position: positions.get(n.id) })),
      resources: f.resources.map((n) => ({ ...n, position: positions.get(n.id) })),
    }));
    setTimeout(() => void flow?.fitView({ padding: 0.16, duration: 250 }), 100);
  }
  function remove(id: string) {
    safely(() => {
      change((f) => removeGraphNode(f, id));
      select('');
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
  const nextOptions = form.nodes.filter(
    (n) => (n.id !== step?.id || step?.type === 'condition') && n.type !== 'start',
  );
  const selectedLink = edges.find((e) => e.id === selectedEdge);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select,.modal')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        travel(e.shiftKey ? 'redo' : 'undo');
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
  }, [form, selected, selectedEdge]);

  function flowSelect(label: string, field: string, current: string | undefined) {
    return (
      <Field label={label}>
        <select
          aria-label={label}
          value={current ?? ''}
          onChange={(e) => step && patch(step.id, { [field]: e.target.value || undefined })}
        >
          <option value="">Connect a step</option>
          {nextOptions.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  return (
    <div
      className="workflow-screen harness-editor"
      role="dialog"
      aria-modal="true"
      aria-label="Workflow editor"
      data-history={historyVersion}
    >
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
            {dirty ? 'Unsaved changes' : 'Workflow harness'} · {form.nodes.length} steps ·{' '}
            {form.resources.length} resources
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
          Save workflow
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
        <aside className="node-palette">
          <span className="eyebrow">BUILD YOUR FLOW</span>
          <p>Click to insert a step, or drag it onto the canvas. Drag between the large ports to connect.</p>
          <h4>Execution steps</h4>
          {(['agent', 'tool', 'condition', 'parallel', 'finish'] as const).map((type) => {
            const Icon = icons[type];
            return (
              <button
                className="palette-item"
                key={type}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('application/agentic-node', type)}
                onClick={() => add(type)}
                aria-label={`Add ${labels[type]}`}
              >
                <span className="node-icon">
                  <Icon size={19} />
                </span>
                <span>
                  <strong>{labels[type]}</strong>
                  <small>
                    {
                      {
                        agent: 'Reason and act',
                        tool: 'Call one MCP action',
                        condition: 'Choose the next path',
                        parallel: 'Run agents together',
                        finish: 'Return a result',
                      }[type]
                    }
                  </small>
                </span>
                <Plus size={14} />
              </button>
            );
          })}
          <h4>Attach to an agent</h4>
          {(['mcp', 'knowledge'] as const).map((type) => {
            const Icon = icons[type];
            return (
              <button
                key={type}
                className={`palette-item resource-palette ${type}`}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('application/agentic-node', type)}
                onClick={() => add(type)}
                aria-label={`Add ${labels[type]}`}
              >
                <span className="node-icon">
                  <Icon size={19} />
                </span>
                <span>
                  <strong>{labels[type]}</strong>
                  <small>{type === 'mcp' ? 'Agent chooses when to call' : 'Reference your documents'}</small>
                </span>
                <Plus size={14} />
              </button>
            );
          })}
          <div className="palette-guide">
            <strong>Two kinds of connections</strong>
            <p>
              <i className="flow-key" />
              Next connects execution steps.
            </p>
            <p>
              <i className="resource-key" />
              Bottom ports attach tools and knowledge to an agent.
            </p>
          </div>
          <div className="palette-bottom">
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => change({ ...form, enabled: e.target.checked })}
              />
              Workflow enabled
            </label>
            <Field label="Step budget">
              <input
                aria-label="Workflow step budget"
                type="number"
                min={1}
                max={500}
                value={form.maxSteps}
                onChange={(e) => change({ ...form, maxSteps: Number(e.target.value) })}
              />
            </Field>
            <small>Loops stop at this limit. Agent turns have their own budget.</small>
          </div>
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
          <div
            className="flow-canvas"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              const type = e.dataTransfer.getData('application/agentic-node');
              if (['agent', 'tool', 'condition', 'parallel', 'finish', 'mcp', 'knowledge'].includes(type))
                add(
                  type as Parameters<typeof add>[0],
                  flow?.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
                );
            }}
          >
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
              fitViewOptions={{ padding: 0.16 }}
              minZoom={0.2}
              maxZoom={1.7}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: false }}
            >
              <Background color="#ccd8d1" gap={24} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(n) =>
                  n.selected
                    ? '#3d7960'
                    : (n.data as FlowData).item.type === 'mcp'
                      ? '#c4b5d6'
                      : (n.data as FlowData).item.type === 'knowledge'
                        ? '#b6c7de'
                        : '#c7d9ce'
                }
                maskColor="rgba(245,247,244,.8)"
                pannable
                zoomable
              />
            </ReactFlow>
            <div className="canvas-hint">
              Drag a port to connect · Click a line to disconnect · Scroll to zoom
            </div>
            <Button className="arrange-button" variant="secondary" onClick={arrange}>
              <LayoutGrid size={15} />
              Auto layout
            </Button>
          </div>
        )}
        <aside className="node-inspector">
          {selectedLink ? (
            <>
              <div className="inspector-title">
                <h3>Connection</h3>
              </div>
              <p>
                {all.find((n) => n.id === selectedLink.source)?.name} →{' '}
                {all.find((n) => n.id === selectedLink.target)?.name}
              </p>
              <p className="field-help">
                {selectedLink.id.startsWith('resource:')
                  ? 'This gives the agent access to this resource.'
                  : 'Execution follows this connection after the step finishes.'}
              </p>
              <Button
                variant="danger"
                onClick={() => {
                  change((f) => disconnectGraph(f, selectedLink));
                  selectEdge('');
                }}
              >
                <Unplug size={16} />
                Disconnect
              </Button>
            </>
          ) : item ? (
            <>
              <div className="inspector-title">
                <h3>{labels[item.type]}</h3>
                {item.type !== 'start' && (
                  <IconButton title="Delete selected component" onClick={() => remove(item.id)}>
                    <Trash2 size={16} />
                  </IconButton>
                )}
              </div>
              <Field label="Component name">
                <input
                  aria-label="Component name"
                  value={item.name}
                  onChange={(e) => patch(item.id, { name: e.target.value })}
                />
              </Field>
              {step?.type === 'start' && (
                <>
                  <div className="notice">
                    Every trigger enters here. The input is available as <code>{'{{input}}'}</code>.
                  </div>
                  <div className="trigger-list">
                    <strong>API & conversation</strong>
                    <p>
                      Use an API key from Integrations to call <code>/api/runs</code> or{' '}
                      <code>/api/chat</code>.
                    </p>
                    <strong>Webhook</strong>
                    <p>
                      Create an authenticated webhook in Integrations. JSON fields are available as{' '}
                      <code>{'{{payload.field}}'}</code>.
                    </p>
                    <strong>Playground & iframe</strong>
                    <p>Test with a message or use an embedded conversation.</p>
                  </div>
                  <details>
                    <summary>Scheduled runs</summary>
                    <ErrorNotice error={value?.lastScheduleError} />
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={form.schedule?.enabled ?? false}
                        onChange={(e) =>
                          change({
                            ...form,
                            schedule: {
                              everyMinutes: 60,
                              input: 'Run the scheduled task.',
                              ...form.schedule,
                              enabled: e.target.checked,
                            },
                          })
                        }
                      />
                      Enable schedule
                    </label>
                    {form.schedule?.enabled && (
                      <>
                        <Field label="Every (minutes)">
                          <input
                            aria-label="Schedule interval"
                            type="number"
                            min={1}
                            value={form.schedule.everyMinutes}
                            onChange={(e) =>
                              change({
                                ...form,
                                schedule: { ...form.schedule!, everyMinutes: Number(e.target.value) },
                              })
                            }
                          />
                        </Field>
                        <Field label="Scheduled input">
                          <textarea
                            value={form.schedule.input}
                            onChange={(e) =>
                              change({ ...form, schedule: { ...form.schedule!, input: e.target.value } })
                            }
                          />
                        </Field>
                      </>
                    )}
                  </details>
                </>
              )}
              {step?.type === 'agent' && (
                <>
                  <ProviderControl
                    data={data}
                    refresh={onSaved}
                    value={step.config?.providerId ?? ''}
                    onChange={(providerId) => patchAgent({ providerId })}
                  />
                  <Field label="Instructions">
                    <textarea
                      aria-label="Agent instructions"
                      rows={6}
                      value={step.config?.systemPrompt ?? ''}
                      onChange={(e) => patchAgent({ systemPrompt: e.target.value })}
                    />
                  </Field>
                  <Field label="Input prompt" hint="Use {{input}}, {{last}}, or {{steps.step_id}}.">
                    <textarea
                      aria-label="Input prompt"
                      rows={3}
                      value={step.prompt}
                      onChange={(e) => patch(step.id, { prompt: e.target.value })}
                    />
                  </Field>
                  <div className="inspector-section">
                    <h4>Agent resources</h4>
                    <p className="field-help">
                      These cards connect to the bottom of this agent. It chooses when to call its tools.
                    </p>
                    <div className="compact-actions">
                      <Button variant="secondary" onClick={() => add('mcp')}>
                        <Plus size={13} />
                        MCP tools
                      </Button>
                      <Button variant="secondary" onClick={() => add('knowledge')}>
                        <Plus size={13} />
                        Knowledge
                      </Button>
                    </div>
                    {form.bindings
                      .filter((b) => b.agentNodeId === step.id)
                      .map((b) => {
                        const r = form.resources.find((r) => r.id === b.resourceId)!;
                        return (
                          <div className="binding-row" key={r.id}>
                            <button onClick={() => select(r.id)}>{r.name}</button>
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
                  </div>
                  <details>
                    <summary>Agent limits & saved agents</summary>
                    <Field label="Maximum reasoning turns">
                      <input
                        type="number"
                        min={1}
                        max={40}
                        value={step.config?.maxTurns ?? 12}
                        onChange={(e) => patchAgent({ maxTurns: Number(e.target.value) })}
                      />
                    </Field>
                    <Field label="Agent timeout (seconds)">
                      <input
                        type="number"
                        min={10}
                        max={900}
                        value={step.config?.timeoutSeconds ?? 300}
                        onChange={(e) => patchAgent({ timeoutSeconds: Number(e.target.value) })}
                      />
                    </Field>
                    <Field label="Use a saved agent as a starting point">
                      <select
                        aria-label="Use saved agent"
                        value=""
                        onChange={(e) => {
                          const a = data.agents.find((a) => a.id === e.target.value);
                          if (a)
                            change((f) =>
                              editableWorkflow(
                                {
                                  ...f,
                                  nodes: f.nodes.map((n) =>
                                    n.id === step.id
                                      ? ({ ...n, config: agentSchema.parse(a) } as WorkflowNode)
                                      : n,
                                  ),
                                },
                                data,
                              ),
                            );
                        }}
                      >
                        <option value="">Choose an agent to copy</option>
                        {data.agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </details>
                </>
              )}
              {resource?.type === 'mcp' && (
                <McpControl
                  data={data}
                  refresh={onSaved}
                  connectionId={resource.connectionId}
                  tools={resource.tools}
                  onChange={(connectionId, tools) => patch(resource.id, { connectionId, tools })}
                />
              )}
              {resource?.type === 'knowledge' && (
                <KnowledgeControl
                  data={data}
                  refresh={onSaved}
                  value={resource.knowledgeBaseId}
                  onChange={(knowledgeBaseId) => patch(resource.id, { knowledgeBaseId })}
                />
              )}
              {resource && (
                <div className="inspector-section">
                  <h4>Connected agents</h4>
                  <p className="field-help">Connect by dragging ports, or select agents here.</p>
                  {form.nodes
                    .filter((n) => n.type === 'agent')
                    .map((n) => (
                      <label className="check-row" key={n.id}>
                        <input
                          type="checkbox"
                          checked={form.bindings.some(
                            (b) => b.resourceId === resource.id && b.agentNodeId === n.id,
                          )}
                          onChange={(e) =>
                            change((f) => ({
                              ...f,
                              bindings: e.target.checked
                                ? [...f.bindings, { agentNodeId: n.id, resourceId: resource.id }]
                                : f.bindings.filter(
                                    (b) => !(b.resourceId === resource.id && b.agentNodeId === n.id),
                                  ),
                            }))
                          }
                        />
                        {n.name}
                      </label>
                    ))}
                </div>
              )}
              {step?.type === 'tool' && (
                <>
                  <Field label="MCP connection">
                    <select
                      aria-label="Action MCP connection"
                      value={step.connectionId}
                      onChange={(e) => {
                        setArgumentDrafts((drafts) => {
                          const next = { ...drafts };
                          delete next[step.id];
                          return next;
                        });
                        setInvalidArguments((v) => ({ ...v, [step.id]: false }));
                        patch(step.id, { connectionId: e.target.value, tool: '', arguments: {} });
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
                      value={step.tool}
                      onChange={(e) => patch(step.id, { tool: e.target.value })}
                    >
                      <option value="">Choose a discovered action</option>
                      {data.connections
                        .find((c) => c.id === step.connectionId)
                        ?.tools?.map((t: any) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <ArgumentEditor
                    key={step.id}
                    value={step.arguments}
                    draft={argumentDrafts[step.id]}
                    schema={
                      data.connections
                        .find((c) => c.id === step.connectionId)
                        ?.tools?.find((t: any) => t.name === step.tool)?.inputSchema
                    }
                    onChange={(value, invalid, text) => {
                      setArgumentDrafts((v) => ({ ...v, [step.id]: text }));
                      setInvalidArguments((v) => ({ ...v, [step.id]: invalid }));
                      if (!invalid) patch(step.id, { arguments: value });
                    }}
                  />
                  <p className="field-help">
                    This is a direct action in the execution path. Attach MCP tools to an agent when it should
                    choose its own calls.
                  </p>
                </>
              )}
              {step?.type === 'condition' && (
                <>
                  <Field label="Value">
                    <input value={step.value} onChange={(e) => patch(step.id, { value: e.target.value })} />
                  </Field>
                  <Field label="Comparison">
                    <select
                      value={step.operator}
                      onChange={(e) => patch(step.id, { operator: e.target.value })}
                    >
                      {['equals', 'notEquals', 'contains', 'truthy', 'greaterThan'].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Compare with">
                    <input
                      value={step.compare}
                      onChange={(e) => patch(step.id, { compare: e.target.value })}
                    />
                  </Field>
                  {flowSelect('When true', 'onTrue', step.onTrue)}
                  {flowSelect('When false', 'onFalse', step.onFalse)}
                </>
              )}
              {step?.type === 'parallel' && (
                <>
                  <Field label="Input prompt">
                    <textarea
                      value={step.prompt}
                      onChange={(e) => patch(step.id, { prompt: e.target.value })}
                    />
                  </Field>
                  {data.agents.length ? (
                    data.agents.map((a) => (
                      <label className="check-row" key={a.id}>
                        <input
                          type="checkbox"
                          checked={step.agentIds.includes(a.id)}
                          onChange={(e) =>
                            patch(step.id, {
                              agentIds: e.target.checked
                                ? [...step.agentIds, a.id]
                                : step.agentIds.filter((id) => id !== a.id),
                            })
                          }
                        />
                        {a.name}
                      </label>
                    ))
                  ) : (
                    <p>Add reusable agents in the Agents page to use parallel execution.</p>
                  )}
                </>
              )}
              {step && isFinish(step) && 'template' in step && (
                <Field
                  label="Final response"
                  hint="Return {{last}} or compose an answer from {{steps.step_id}}."
                >
                  <textarea
                    aria-label="Final response template"
                    rows={6}
                    value={step.template}
                    onChange={(e) => patch(step.id, { template: e.target.value })}
                  />
                </Field>
              )}
              {step &&
                !isFinish(step) &&
                step.type !== 'condition' &&
                flowSelect('Next step', 'next', step.next)}
              <small className="component-id">ID: {item.id}</small>
            </>
          ) : (
            <>
              <div className="inspector-title">
                <h3>Your workflow</h3>
              </div>
              <p>Select a component to configure it, or a connection to remove it.</p>
              <Field label="Description">
                <textarea
                  value={form.description}
                  onChange={(e) => change({ ...form, description: e.target.value })}
                />
              </Field>
              <div className="notice">
                Start a run from the Playground, an API call, a conversation, a webhook, or a schedule. Every
                route uses the same queued harness.
              </div>
            </>
          )}
        </aside>
      </div>
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
      <Field
        label="Tool arguments (JSON)"
        hint="Template values preserve types when they fill a whole field."
      >
        <textarea
          aria-label="Tool arguments JSON"
          rows={7}
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
