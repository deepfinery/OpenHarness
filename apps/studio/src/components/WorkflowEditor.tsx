import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  BookOpen,
  Bot,
  Check,
  Code2,
  Download,
  GitBranch,
  GitFork,
  LayoutGrid,
  LoaderCircle,
  LogOut,
  Plug,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { parse, stringify } from 'yaml';
import { workflowSchema, type Workflow, type WorkflowNode } from '../../../../packages/core/src/schema.js';
import { layoutWorkflow } from '../workflowLayout';
import { send, type Data, type Entity, errorMessage } from '../api';
import { Button, ErrorNotice, Field, IconButton } from './ui';

const colors: Record<string, string> = {
  agent: 'green',
  tool: 'blue',
  condition: 'amber',
  output: 'slate',
  parallel: 'violet',
};
const icons = { agent: Bot, tool: Plug, condition: GitBranch, output: LogOut, parallel: GitFork };
type FlowData = { node: WorkflowNode; detail: string; isStart: boolean; count: number } & Record<
  string,
  unknown
>;
function FlowCard({ data, selected }: NodeProps<Node<FlowData>>) {
  const Icon = icons[data.node.type];
  return (
    <div className={`flow-card ${colors[data.node.type]} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      {data.isStart && <span className="start-label">START</span>}
      <div className="flow-card-top">
        <span className="node-icon">
          <Icon size={19} />
        </span>
        <div>
          <small>
            {data.node.type === 'parallel'
              ? 'PARALLEL AGENTS'
              : data.node.type === 'tool'
                ? 'MCP TOOL'
                : data.node.type.toUpperCase()}
          </small>
          <strong>{data.node.name}</strong>
        </div>
      </div>
      <p>{data.detail}</p>
      {data.node.type === 'agent' && (
        <div className="node-footer">
          <Plug size={12} /> {data.count} tools attached
        </div>
      )}
      {data.node.type === 'condition' ? (
        <>
          <Handle type="source" position={Position.Right} id="true" style={{ top: '35%' }} />
          <Handle type="source" position={Position.Right} id="false" style={{ top: '75%' }} />
          <span className="branch-label yes">yes</span>
          <span className="branch-label no">no</span>
        </>
      ) : (
        data.node.type !== 'output' && <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}
const nodeTypes = { studio: FlowCard };
function initial(value?: Entity): Workflow {
  if (value) return structuredClone(value) as unknown as Workflow;
  return {
    name: '',
    description: '',
    enabled: true,
    startAt: 'output',
    nodes: [
      {
        id: 'output',
        name: 'Final response',
        type: 'output',
        template: '{{input}}',
        position: { x: 280, y: 200 },
      },
    ],
  };
}
export function WorkflowEditor({
  value,
  data,
  onClose,
  onSaved,
}: {
  value?: Entity;
  data: Data;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, set] = useState<Workflow>(() => initial(value));
  const [selected, select] = useState<string>('');
  const [tab, setTab] = useState<'canvas' | 'yaml'>('canvas');
  const [yaml, setYaml] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invalidArguments, setInvalidArguments] = useState<Record<string, boolean>>({});
  const [flow, setFlow] = useState<ReactFlowInstance<Node<FlowData>> | null>(null);
  const [measurements, setMeasurements] = useState<Record<string, { width: number; height: number }>>({});
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  const updateNode = (id: string, patch: Record<string, unknown>) =>
    set((f) => ({
      ...f,
      nodes: f.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as WorkflowNode) : n)),
    }));
  const node = form.nodes.find((n) => n.id === selected);
  const nodes: Node<FlowData>[] = useMemo(
    () =>
      form.nodes.map((n, index) => {
        const agent = n.type === 'agent' ? data.agents.find((a) => a.id === n.agentId) : undefined;
        return {
          id: n.id,
          type: 'studio',
          measured: measurements[n.id],
          position: n.position ?? { x: 80 + index * 320, y: 140 },
          selected: selected === n.id,
          data: {
            node: n,
            isStart: form.startAt === n.id,
            detail:
              n.type === 'agent'
                ? (agent?.name ?? 'Choose an agent')
                : n.type === 'tool'
                  ? n.tool || 'Choose a tool'
                  : n.type === 'parallel'
                    ? `${n.agentIds.length} agents run together`
                    : n.type === 'condition'
                      ? `${n.value} ${n.operator} ${n.compare}`
                      : n.template,
            count:
              agent?.connections.reduce((total: number, binding: any) => total + binding.tools.length, 0) ??
              0,
          },
        };
      }),
    [form, data, selected, measurements],
  );
  const edges = useMemo(
    () =>
      form.nodes.flatMap((n) => {
        const links =
          n.type === 'condition'
            ? [
                { to: n.onTrue, label: 'true' },
                { to: n.onFalse, label: 'false' },
              ]
            : n.type !== 'output' && n.next
              ? [{ to: n.next, label: '' }]
              : [];
        return links
          .filter((l) => form.nodes.some((n) => n.id === l.to))
          .map((l) => ({
            id: `${n.id}:${l.label}:${l.to}`,
            source: n.id,
            target: l.to,
            label: l.label,
            ...(l.label ? { sourceHandle: l.label } : {}),
            animated: false,
            type: 'smoothstep',
            style: { stroke: l.label === 'false' ? '#bd8a56' : '#91a69a', strokeWidth: 1.8 },
          }));
      }),
    [form],
  );
  function connect(c: Connection) {
    const source = form.nodes.find((n) => n.id === c.source);
    if (!source || c.source === c.target) return;
    updateNode(
      source.id,
      source.type === 'condition'
        ? { [c.sourceHandle === 'false' ? 'onFalse' : 'onTrue']: c.target }
        : { next: c.target },
    );
  }
  function add(type: WorkflowNode['type']) {
    const id = `${type}_${crypto.randomUUID().slice(0, 6)}`;
    const output = form.nodes.find((n) => n.type === 'output');
    const tail = form.nodes.find(
      (n) => n.type !== 'condition' && n.type !== 'output' && n.next === output?.id,
    );
    const base = {
      id,
      name:
        type === 'agent'
          ? 'Agent step'
          : type === 'tool'
            ? 'MCP tool'
            : type === 'parallel'
              ? 'Parallel agents'
              : type === 'condition'
                ? 'Condition'
                : 'Final response',
      position: { x: 180 + form.nodes.length * 80, y: 160 },
      next: output?.id,
    };
    const newNode: WorkflowNode =
      type === 'agent'
        ? {
            ...base,
            type,
            agentId: data.agents[0]?.id ?? '',
            prompt: form.startAt === output?.id ? '{{input}}' : '{{last}}',
          }
        : type === 'tool'
          ? {
              ...base,
              type,
              connectionId: data.connections[0]?.id ?? '',
              tool: data.connections[0]?.tools?.[0]?.name ?? '',
              arguments: {},
            }
          : type === 'parallel'
            ? { ...base, type, agentIds: data.agents[0] ? [data.agents[0].id] : [], prompt: '{{input}}' }
            : type === 'condition'
              ? {
                  ...base,
                  type,
                  value: '{{last}}',
                  operator: 'contains',
                  compare: '',
                  onTrue: output?.id ?? '',
                  onFalse: output?.id ?? '',
                }
              : { id, name: base.name, position: base.position, type, template: '{{last}}' };
    set((f) => ({
      ...f,
      startAt: f.startAt === output?.id && type !== 'output' ? id : f.startAt,
      nodes: [
        ...f.nodes.map((n) =>
          n.id === tail?.id
            ? { ...n, next: id }
            : n.type === 'output' && f.startAt === n.id && n.template === '{{input}}'
              ? { ...n, template: '{{last}}' }
              : n,
        ),
        newNode,
      ] as WorkflowNode[],
    }));
    select(id);
  }
  function removeNode() {
    if (!node) return;
    set((f) => ({
      ...f,
      startAt: f.startAt === node.id ? (f.nodes.find((n) => n.id !== node.id)?.id ?? '') : f.startAt,
      nodes: f.nodes
        .filter((n) => n.id !== node.id)
        .map((n) =>
          n.type !== 'output' && n.type !== 'condition' && n.next === node.id ? { ...n, next: undefined } : n,
        ),
    }));
    select('');
  }
  function arrange() {
    const placed = layoutWorkflow(
      form.nodes.map((n, i) => ({ ...n, x: n.position?.x ?? i * 300, y: n.position?.y ?? 100 })),
      edges.map((e) => ({ from: e.source, to: e.target })),
      () => ({ width: 250, height: 155 }),
      form.startAt,
    );
    set((f) => ({
      ...f,
      nodes: placed.map(({ x, y, ...n }) => ({ ...n, position: { x, y } })) as WorkflowNode[],
    }));
    setTimeout(() => flow?.fitView({ padding: 0.25, duration: 250 }), 100);
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      if (tab === 'canvas' && form.nodes.some((n) => invalidArguments[n.id]))
        throw new Error('Fix invalid JSON arguments before saving');
      const body = workflowSchema.parse(tab === 'yaml' ? parse(yaml) : form);
      await send(`/workflows${value ? `/${value.id}` : ''}`, body, value ? 'PUT' : 'POST');
      await onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const nextOptions = form.nodes.filter((n) => n.id !== node?.id);
  return (
    <div className="workflow-screen" role="dialog" aria-modal="true" aria-label="Workflow editor">
      <header className="workflow-header">
        <IconButton title="Close workflow editor" onClick={onClose}>
          <X size={20} />
        </IconButton>
        <div className="workflow-name">
          <input
            disabled={tab === 'yaml'}
            aria-label="Workflow name"
            placeholder="Untitled workflow"
            value={form.name}
            onChange={(e) => set({ ...form, name: e.target.value })}
          />
          <small>AGENT ORCHESTRATION</small>
        </div>
        <div className="segmented">
          <button
            className={tab === 'canvas' ? 'active' : ''}
            onClick={() => {
              if (tab === 'yaml') {
                try {
                  const parsed = workflowSchema.parse(parse(yaml));
                  set(parsed);
                  setTab('canvas');
                  setError('');
                } catch (e) {
                  setError(errorMessage(e));
                }
              }
            }}
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
        <Button
          variant="secondary"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([stringify(form)], { type: 'text/yaml' }));
            a.download = `${form.name || 'workflow'}.yaml`;
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          <Download size={15} />
          Export
        </Button>
        <Button onClick={save} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Save workflow
        </Button>
      </header>
      {error && (
        <div className="workflow-error">
          <ErrorNotice error={error} />
        </div>
      )}
      <div className="workflow-body">
        <aside className="node-palette">
          <div className="eyebrow">BUILD YOUR FLOW</div>
          <p>Connect focused agents with the tools they need.</p>
          {(['agent', 'tool', 'parallel', 'condition', 'output'] as const).map((type) => {
            const Icon = icons[type];
            return (
              <button className={`palette-item ${colors[type]}`} key={type} onClick={() => add(type)}>
                <span className="node-icon">
                  <Icon size={19} />
                </span>
                <span>
                  <strong>
                    {type === 'tool'
                      ? 'MCP tool'
                      : type === 'parallel'
                        ? 'Parallel agents'
                        : type[0].toUpperCase() + type.slice(1)}
                  </strong>
                  <small>
                    {
                      {
                        agent: 'Reason and act',
                        tool: 'Call one tool',
                        parallel: 'Work concurrently',
                        condition: 'Choose a branch',
                        output: 'Return the result',
                      }[type]
                    }
                  </small>
                </span>
                <Plus size={14} />
              </button>
            );
          })}
          <div className="palette-bottom">
            <Field label="Description">
              <textarea
                aria-label="Workflow description"
                rows={3}
                value={form.description}
                onChange={(e) => set({ ...form, description: e.target.value })}
              />
            </Field>
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set({ ...form, enabled: e.target.checked })}
              />
              Workflow enabled
            </label>
            <details>
              <summary>Scheduled runs</summary>
              <ErrorNotice
                error={
                  value?.lastScheduleError
                    ? `Last scheduling attempt: ${value.lastScheduleError}. Retrying in one minute.`
                    : undefined
                }
              />
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={form.schedule?.enabled ?? false}
                  onChange={(e) =>
                    set({
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
                        set({
                          ...form,
                          schedule: { ...form.schedule!, everyMinutes: Number(e.target.value) },
                        })
                      }
                    />
                  </Field>
                  <Field label="Scheduled input">
                    <textarea
                      aria-label="Scheduled input"
                      rows={3}
                      value={form.schedule.input}
                      onChange={(e) =>
                        set({ ...form, schedule: { ...form.schedule!, input: e.target.value } })
                      }
                    />
                  </Field>
                </>
              )}
            </details>
          </div>
        </aside>
        {tab === 'yaml' ? (
          <textarea
            className="yaml-editor"
            aria-label="Workflow YAML"
            spellCheck={false}
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
          />
        ) : (
          <div className="flow-canvas">
            <div className="canvas-caption">
              <span className="live-dot" />
              Canvas <span>Drag between handles to connect steps</span>
            </div>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={setFlow}
              onConnect={connect}
              onNodeClick={(_event, n) => select(n.id)}
              onPaneClick={() => select('')}
              onNodesChange={(changes) => {
                const dimensions = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
                if (dimensions.length)
                  setMeasurements((previous) => {
                    const next = { ...previous };
                    for (const change of dimensions) {
                      if (change.type === 'dimensions' && change.dimensions)
                        next[change.id] = change.dimensions;
                    }
                    return next;
                  });
                if (!changes.some((c) => c.type === 'position')) return;
                set((f) => ({
                  ...f,
                  nodes: f.nodes.map((n) => {
                    const change = changes.find((c) => c.type === 'position' && c.id === n.id);
                    return change?.type === 'position' && change.position
                      ? { ...n, position: change.position }
                      : n;
                  }),
                }));
              }}
              onNodeDragStop={(_event, n) => updateNode(n.id, { position: n.position })}
              fitView
              minZoom={0.25}
              maxZoom={1.6}
              deleteKeyCode={null}
            >
              <Background color="#cbd5cf" gap={22} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(n) => (n.selected ? '#3d7960' : '#c7d9ce')}
                maskColor="rgba(245,247,244,.75)"
              />
            </ReactFlow>
            <Button className="arrange-button" variant="secondary" onClick={arrange}>
              <LayoutGrid size={15} />
              Auto layout
            </Button>
          </div>
        )}
        <aside className="node-inspector">
          {node ? (
            <>
              <div className="inspector-title">
                <h3>{node.type === 'tool' ? 'MCP tool' : 'Step settings'}</h3>
                <IconButton title="Delete step" onClick={removeNode}>
                  <Trash2 size={16} />
                </IconButton>
              </div>
              <Field label="Step name">
                <input
                  aria-label="Step name"
                  value={node.name}
                  onChange={(e) => updateNode(node.id, { name: e.target.value })}
                />
              </Field>
              <small className="mono">ID: {node.id}</small>
              <label className="check-row">
                <input
                  type="radio"
                  checked={form.startAt === node.id}
                  onChange={() => set({ ...form, startAt: node.id })}
                />
                Start workflow here
              </label>
              {node.type === 'agent' && (
                <>
                  <Field label="Agent">
                    <select
                      aria-label="Step agent"
                      value={node.agentId}
                      onChange={(e) => updateNode(node.id, { agentId: e.target.value })}
                    >
                      <option value="">Select an agent</option>
                      {data.agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Input prompt">
                    <textarea
                      aria-label="Step input prompt"
                      rows={5}
                      value={node.prompt}
                      onChange={(e) => updateNode(node.id, { prompt: e.target.value })}
                    />
                  </Field>
                </>
              )}
              {node.type === 'parallel' && (
                <>
                  <Field label="Agents">
                    {data.agents.map((a) => (
                      <label className="check-row" key={a.id}>
                        <input
                          type="checkbox"
                          checked={node.agentIds.includes(a.id)}
                          onChange={() =>
                            updateNode(node.id, {
                              agentIds: node.agentIds.includes(a.id)
                                ? node.agentIds.filter((id) => id !== a.id)
                                : [...node.agentIds, a.id],
                            })
                          }
                        />
                        {a.name}
                      </label>
                    ))}
                  </Field>
                  <Field label="Input prompt">
                    <textarea
                      aria-label="Parallel input prompt"
                      rows={4}
                      value={node.prompt}
                      onChange={(e) => updateNode(node.id, { prompt: e.target.value })}
                    />
                  </Field>
                </>
              )}
              {node.type === 'tool' && (
                <>
                  <Field label="MCP server">
                    <select
                      aria-label="Step MCP server"
                      value={node.connectionId}
                      onChange={(e) => updateNode(node.id, { connectionId: e.target.value, tool: '' })}
                    >
                      <option value="">Select a server</option>
                      {data.connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Tool">
                    <select
                      aria-label="Step MCP tool"
                      value={node.tool}
                      onChange={(e) => updateNode(node.id, { tool: e.target.value })}
                    >
                      <option value="">Select a tool</option>
                      {data.connections
                        .find((c) => c.id === node.connectionId)
                        ?.tools?.map((t: any) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <JsonArguments
                    key={node.id}
                    onValidity={(valid) =>
                      setInvalidArguments((previous) => ({ ...previous, [node.id]: !valid }))
                    }
                    value={node.arguments}
                    onChange={(argumentsValue) => updateNode(node.id, { arguments: argumentsValue })}
                  />
                </>
              )}
              {node.type === 'condition' && (
                <>
                  <Field label="Value">
                    <input
                      aria-label="Condition value"
                      value={node.value}
                      onChange={(e) => updateNode(node.id, { value: e.target.value })}
                    />
                  </Field>
                  <Field label="Operator">
                    <select
                      aria-label="Condition operator"
                      value={node.operator}
                      onChange={(e) => updateNode(node.id, { operator: e.target.value })}
                    >
                      {['equals', 'notEquals', 'contains', 'truthy', 'greaterThan'].map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Compare with">
                    <input
                      aria-label="Condition comparison"
                      value={node.compare}
                      onChange={(e) => updateNode(node.id, { compare: e.target.value })}
                    />
                  </Field>
                  {(['onTrue', 'onFalse'] as const).map((key) => (
                    <Field key={key} label={key === 'onTrue' ? 'If true' : 'If false'}>
                      <select
                        aria-label={key === 'onTrue' ? 'True branch' : 'False branch'}
                        value={node[key]}
                        onChange={(e) => updateNode(node.id, { [key]: e.target.value })}
                      >
                        <option value="">Select a step</option>
                        {nextOptions.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </>
              )}
              {node.type === 'output' && (
                <Field label="Response template">
                  <textarea
                    aria-label="Response template"
                    rows={5}
                    value={node.template}
                    onChange={(e) => updateNode(node.id, { template: e.target.value })}
                  />
                </Field>
              )}
              {node.type !== 'output' && node.type !== 'condition' && (
                <Field label="Next step">
                  <select
                    aria-label="Next step"
                    value={node.next ?? ''}
                    onChange={(e) => updateNode(node.id, { next: e.target.value || undefined })}
                  >
                    <option value="">Finish here</option>
                    {nextOptions.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <div className="template-help">
                <strong>Use values from your flow</strong>
                <code>{'{{input}}'}</code>
                <span>Original input</span>
                <code>{'{{last}}'}</code>
                <span>Previous step output</span>
                <code>{'{{steps.step_id}}'}</code>
                <span>A named step’s output</span>
              </div>
            </>
          ) : (
            <div className="inspector-empty">
              <GitBranch size={30} />
              <h3>Every step, connected.</h3>
              <p>Select a step to edit its settings. Attach MCP tools and knowledge in the agent editor.</p>
              <div className="notice">
                Changes take effect on new runs. Each run saves a snapshot of its agents and workflow.
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
function JsonArguments({
  value,
  onChange,
  onValidity,
}: {
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  onValidity: (valid: boolean) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  return (
    <Field label="Arguments (JSON)" hint={error || 'Use {{input}} or {{steps.step_id}} in values.'}>
      <textarea
        aria-label="Tool arguments JSON"
        className="mono"
        rows={8}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value);
            if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an object');
            onChange(v);
            onValidity(true);
            setError('');
          } catch {
            onValidity(false);
            setError('Enter a valid JSON object before saving.');
          }
        }}
      />
    </Field>
  );
}
