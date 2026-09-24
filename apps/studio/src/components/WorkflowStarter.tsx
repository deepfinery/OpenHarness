import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Bot, Check, GitBranch, Plug } from 'lucide-react';
import { makeStarter, starterRecipes, type StarterKind } from '../../../../packages/core/src/starters.js';
import type { Workflow } from '../../../../packages/core/src/schema.js';
import { errorMessage, type Data } from '../api';
import { Button, ErrorNotice, Field, Modal } from './ui';
import { KnowledgeControl, McpControl, ProviderControl } from './ResourceControls';
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
  const [kind, setKind] = useState<StarterKind>('research'),
    [stage, setStage] = useState(0),
    [name, setName] = useState('Knowledge research'),
    [providerId, setProviderId] = useState(data.providers[0]?.id ?? ''),
    [knowledgeBaseId, setKnowledge] = useState(data.knowledge[0]?.id ?? ''),
    [connectionId, setConnection] = useState(data.connections[0]?.id ?? ''),
    [tools, setTools] = useState<string[]>([]),
    [error, setError] = useState('');
  const recipe = starterRecipes.find((r) => r.id === kind)!;
  useEffect(() => {
    if (!providerId && data.providers[0]) setProviderId(data.providers[0].id);
  }, [data.providers]);
  function open() {
    try {
      onChoose(makeStarter({ kind, name, providerId, knowledgeBaseId, connectionId, tools }));
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
          <span className={stage ? 'active' : ''}>Connect your resources</span>
          <i />
          <span>Make it yours</span>
        </div>
        {stage === 0 ? (
          <>
            <h3>Start with a working structure.</h3>
            <p>
              Each template includes Start and Finish. Your tools and knowledge attach directly to the agent.
            </p>
            <div className="starter-grid">
              {starterRecipes.map((r) => {
                const Icon =
                  r.id === 'research'
                    ? BookOpen
                    : r.id === 'mcp'
                      ? Plug
                      : r.id === 'review'
                        ? Bot
                        : GitBranch;
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
                    <Icon size={25} />
                    <strong>{r.name}</strong>
                    <span>{r.description}</span>
                    <small>
                      {r.id === 'blank'
                        ? 'Start → Finish'
                        : r.id === 'review'
                          ? 'Start → Research → Review → Finish'
                          : 'Start → Agent → Finish'}
                    </small>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <h3>{recipe.name}</h3>
            <p>Use shared workspace resources or add them here. No separate agent setup is needed.</p>
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
