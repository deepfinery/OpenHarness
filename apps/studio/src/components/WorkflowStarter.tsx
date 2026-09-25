import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  GitBranch,
  GitFork,
  Mail,
  Plug,
  Route,
} from 'lucide-react';
import { makeStarter, starterRecipes, type StarterKind } from '../../../../packages/core/src/starters.js';
import type { Workflow } from '../../../../packages/core/src/schema.js';
import { errorMessage, type Data } from '../api';
import { Button, ErrorNotice, Field, Modal } from './ui';
import { KnowledgeControl, McpControl, ProviderControl } from './ResourceControls';
const starterIcons: Record<StarterKind, typeof Bot> = {
  research: BookOpen,
  mcp: Plug,
  review: Bot,
  team: GitFork,
  router: Route,
  notify: Mail,
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
              Every template includes Start and Finish. Multi-agent templates pass results between agents with{' '}
              <code>{'{{last}}'}</code> and <code>{'{{steps.id}}'}</code>; you can add, rewire or remove steps
              afterwards.
            </p>
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
            {kind === 'notify' && (
              <div className="notice">
                <Mail size={16} />
                <span>
                  The Email step sends through Settings → Email (SMTP). Set its recipient on the canvas; it
                  starts as a placeholder address.
                </span>
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
