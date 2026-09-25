import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  GitBranch,
  GitFork,
  Laptop,
  Mail,
  Plug,
  Route,
} from 'lucide-react';
import { makeStarter, starterRecipes, type StarterKind } from '../../../../packages/core/src/starters.js';
import type { Workflow } from '../../../../packages/core/src/schema.js';
import { defaultProviderId, errorMessage, type Data } from '../api';
import { Button, ErrorNotice, Field, Modal } from './ui';
import { KnowledgeControl, McpControl, ProviderControl } from './ResourceControls';
const starterIcons: Record<StarterKind, typeof Bot> = {
  research: BookOpen,
  mcp: Plug,
  review: Bot,
  team: GitFork,
  router: Route,
  notify: Mail,
  machine: Laptop,
  blank: GitBranch,
};
export function WorkflowStarter({
  data,
  refresh,
  onClose,
  onChoose,
}: {
  data: Data;
  refresh: () => Promise<void>;
  onClose: () => void;
  onChoose: (workflow: Workflow) => void;
}) {
  const [kind, setKind] = useState<StarterKind>('mcp'),
    [stage, setStage] = useState(0),
    [name, setName] = useState('MCP tool assistant'),
    [providerId, setProviderId] = useState(defaultProviderId(data)),
    [knowledgeBaseId, setKnowledge] = useState(data.knowledge[0]?.id ?? ''),
    [connectionId, setConnection] = useState(data.connections[0]?.id ?? ''),
    [tools, setTools] = useState<string[]>([]),
    [machineId, setMachineId] = useState(
      (data.machines.find((m) => m.online && m.connectionId && m.tools.length) ?? data.machines[0])
        ?.device_id ?? '',
    ),
    [error, setError] = useState('');
  const recipe = starterRecipes.find((r) => r.id === kind)!;
  useEffect(() => {
    if (!providerId && data.providers.length) setProviderId(defaultProviderId(data));
  }, [data.providers]);
  function open() {
    try {
      const chosen = data.machines.find((m) => m.device_id === machineId);
      const machine =
        kind === 'machine' && chosen?.connectionId
          ? { connectionId: chosen.connectionId, name: chosen.name, tools: chosen.tools.map((t) => t.name) }
          : undefined;
      onChoose(makeStarter({ kind, name, providerId, knowledgeBaseId, connectionId, tools, machine }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <Modal title="Start a workflow" wide onClose={onClose}>
      <div className="starter-body">
        <div className="starter-progress">
          <span className="active">
            <Check size={14} /> Choose a template
          </span>
          <i />
          <span className={stage ? 'active' : ''}>Connect resources</span>
          <i />
          <span>Edit on the canvas</span>
        </div>
        {stage === 0 ? (
          <>
            <h3>Pick a starting point</h3>
            <div className="starter-grid three">
              {starterRecipes.map((r) => {
                const Icon = starterIcons[r.id];
                return (
                  <button
                    key={r.id}
                    className={`starter-card ${kind === r.id ? 'selected' : ''}`}
                    aria-pressed={kind === r.id}
                    onClick={() => {
                      setKind(r.id);
                      setName(r.name);
                      setError('');
                    }}
                  >
                    <span className="starter-card-top">
                      <Icon size={22} />
                      {r.agents > 0 && (
                        <span className="status next">
                          {r.agents} agent{r.agents === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                    <strong>{r.name}</strong>
                    <span>{r.description}</span>
                    <small>{r.shape}</small>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <h3>{recipe.name}</h3>
            <Field label="Workflow name">
              <input
                aria-label="Starter workflow name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <ProviderControl data={data} refresh={refresh} value={providerId} onChange={setProviderId} />
            {recipe.needsKnowledge && (
              <KnowledgeControl
                data={data}
                refresh={refresh}
                value={knowledgeBaseId}
                onChange={setKnowledge}
              />
            )}
            {recipe.needsTools && (
              <McpControl
                data={data}
                refresh={refresh}
                connectionId={connectionId}
                tools={tools}
                onChange={(id, t) => {
                  setConnection(id);
                  setTools(t);
                }}
              />
            )}
            {kind === 'machine' && (
              <>
                <Field
                  label="Machine"
                  hint="Its tools are attached to the agent. In a chat you can still pick another machine."
                >
                  <select
                    aria-label="Starter machine"
                    value={machineId}
                    onChange={(e) => setMachineId(e.target.value)}
                  >
                    <option value="">Choose in each chat</option>
                    {data.machines
                      .filter((m) => m.connectionId && !m.disabled)
                      .map((m) => (
                        <option key={m.device_id} value={m.device_id} disabled={!m.tools.length}>
                          {m.name} · {m.platform} · {m.online ? 'online' : 'offline'}
                          {m.tools.length ? ` · ${m.tools.length} tools` : ' · no tools yet'}
                        </option>
                      ))}
                  </select>
                </Field>
                <div className="notice">
                  <Laptop size={16} />
                  <span>
                    {data.machines.length
                      ? 'After saving, open the Playground, pick this workflow and ask, for example, “list the files in the work directory”, “run uname -a” or “how much disk space is free?”. Commands run only if the machine’s allow-list permits them.'
                      : 'No machines yet. Enroll one on the Machines page, then choose it here or in the Playground.'}
                  </span>
                </div>
              </>
            )}
            {kind === 'notify' && (
              <div className="notice">
                <Mail size={16} />
                <span>Set the Email step’s recipient on the canvas. It sends through Settings → Email.</span>
              </div>
            )}
          </>
        )}
        <ErrorNotice error={error} />
        <div className="starter-footer">
          {stage > 0 ? (
            <Button variant="ghost" onClick={() => setStage(0)}>
              <ArrowLeft size={15} /> Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button
            onClick={() => {
              if (!stage && kind !== 'blank') setStage(1);
              else open();
            }}
            disabled={
              stage > 0 &&
              (!providerId ||
                !name.trim() ||
                (recipe.needsKnowledge && !knowledgeBaseId) ||
                (recipe.needsTools && (!connectionId || !tools.length)))
            }
          >
            {stage === 0 && kind !== 'blank' ? 'Connect resources' : 'Open canvas'}
            <ArrowRight size={15} />
          </Button>
        </div>
      </div>
    </Modal>
  );
}
