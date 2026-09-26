import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  Eye,
  FlaskConical,
  LockKeyhole,
  MessageSquareWarning,
  Plus,
  Scale,
  Search,
  ShieldCheck,
  ShieldAlert,
  Code2,
  Download,
  Upload,
} from 'lucide-react';
import {
  guardrailPolicySchema,
  railStages,
  type GuardrailPolicy,
  type RailStage,
} from '../../../../packages/core/src/guardrailPolicy.js';
import {
  guardrailTemplates,
  type GuardrailTemplate,
} from '../../../../packages/core/src/guardrailTemplates.js';
import {
  guardrailYaml,
  guardrailYamlFilename,
  guardrailYamlMaxBytes,
  parseGuardrailYaml,
} from '../../../../packages/core/src/guardrailYaml.js';
import { api, send, errorMessage, type Data, type Entity } from '../api';
import { Button, Empty, ErrorNotice, Field, Modal, PageTitle } from './ui';

const icons = {
  bias: Scale,
  toxicity: MessageSquareWarning,
  hallucinations: BookOpen,
  opacity: Eye,
  pii: LockKeyhole,
  vulnerability: ShieldAlert,
};
const stageLabels: Record<RailStage, string> = {
  input: 'User input',
  output: 'Agent answers',
  retrieval: 'Retrieved knowledge',
  tool_input: 'Tool arguments',
  tool_output: 'Tool results',
};
const stageHints: Record<RailStage, string> = {
  input: 'Before the agent reads a request',
  output: 'Before an answer reaches the user',
  retrieval: 'Before knowledge enters the context',
  tool_input: 'Before a tool can execute',
  tool_output: 'Before results enter the context',
};

type PageTab = 'policies' | 'templates' | 'activity' | 'defaults';

export function GuardrailPicker({
  data,
  value = [],
  onChange,
  disabled = false,
}: {
  data: Data;
  value?: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="guardrail-picker" disabled={disabled}>
      <legend>Safety policies</legend>
      {data.guardrails.length ? (
        data.guardrails.map((p) => (
          <label key={p.id}>
            <input
              type="checkbox"
              checked={value.includes(p.id)}
              disabled={!p.enabled && !value.includes(p.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, p.id] : value.filter((id) => id !== p.id))
              }
            />
            {p.name}
            {!p.enabled && ' · Disabled'}
          </label>
        ))
      ) : (
        <p>Create a policy on the Guardrails page.</p>
      )}
    </fieldset>
  );
}

export function GuardrailsPage({
  data,
  refresh,
  isAdmin,
}: {
  data: Data;
  refresh: () => Promise<void>;
  isAdmin: boolean;
}) {
  const [selectedTab, setTab] = useState<PageTab | null>(null);
  const tab = selectedTab ?? (data.guardrails.length ? 'policies' : 'templates');
  const [editing, setEditing] = useState<Entity | null | undefined>();
  const [form, setForm] = useState<GuardrailPolicy>(guardrailPolicySchema.parse({ name: 'Safety policy' }));
  const [editorTab, setEditorTab] = useState<'configure' | 'yaml' | 'test'>('configure');
  const [rules, setRules] = useState('[]');
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState('');
  const importInput = useRef<HTMLInputElement>(null);
  const importIntoEditor = useRef(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [defaults, setDefaults] = useState<string[]>([]);
  const [probe, setProbe] = useState('Contact alice@example.com');
  const [probeStage, setProbeStage] = useState<RailStage>('input');
  const [probeTool, setProbeTool] = useState('');
  const [result, setResult] = useState<{ decision: string; content: string; reason?: string }>();
  const [audit, setAudit] = useState<any[]>([]);
  const [evaluations, setEvaluations] = useState<any[]>([]);
  const [workflowId, setWorkflowId] = useState('');
  const load = () =>
    Promise.all([
      api('/tenant').then((t) => setDefaults(t.guardrailIds ?? [])),
      api('/guardrail-audit').then(setAudit),
      api('/guardrail-evaluations').then(setEvaluations),
    ]);
  useEffect(() => {
    load().catch((e) => setError(errorMessage(e)));
  }, []);
  const patch = (p: Partial<GuardrailPolicy>) => {
    setForm((f) => ({ ...f, ...p }));
    setResult(undefined);
  };
  const source = guardrailTemplates.find((t) => t.id === form.templateId);
  function open(p: Entity | null, template?: GuardrailTemplate) {
    const next = guardrailPolicySchema.parse(p ?? template?.policy ?? { name: 'Safety policy' });
    setEditing(p);
    setForm(next);
    setRules(JSON.stringify(next.argumentRules, null, 2));
    setYamlText(guardrailYaml(next));
    setYamlError('');
    setProbe(template?.sample ?? 'Contact alice@example.com');
    setProbeStage(next.stages[0]);
    setProbeTool('');
    setResult(undefined);
    setError('');
    setEditorTab('configure');
  }
  function parsedPolicy() {
    if (editorTab === 'yaml') return parseGuardrailYaml(yamlText);
    return guardrailPolicySchema.parse({
      ...form,
      argumentRules: JSON.parse(rules),
      deniedTerms: form.deniedTerms.filter((s) => s.trim()),
      blockedTopics: form.blockedTopics.filter((s) => s.trim()),
      deniedTools: form.deniedTools.filter((s) => s.trim()),
    });
  }
  function applyYaml(text: string) {
    const policy = parseGuardrailYaml(text);
    setForm(policy);
    setRules(JSON.stringify(policy.argumentRules, null, 2));
    setYamlError('');
    setResult(undefined);
    if (!policy.stages.includes(probeStage)) setProbeStage(policy.stages[0]);
    return policy;
  }
  function switchEditor(next: 'configure' | 'yaml' | 'test') {
    try {
      const policy = parsedPolicy();
      if (editorTab === 'yaml') applyYaml(yamlText);
      if (next === 'yaml' && editorTab !== 'yaml') setYamlText(guardrailYaml(policy));
      setError('');
      setYamlError('');
      setEditorTab(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function exportYaml() {
    try {
      const policy = parsedPolicy();
      const url = URL.createObjectURL(new Blob([guardrailYaml(policy)], { type: 'application/yaml' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = guardrailYamlFilename(policy.name);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function importYaml(file: File, intoEditor: boolean) {
    if (!isAdmin || busy) return;
    await act(async () => {
      if (!/\.ya?ml$/i.test(file.name)) throw new Error('Choose a .yaml or .yml file.');
      if (file.size > guardrailYamlMaxBytes) throw new Error('Policy YAML must be 256 KiB or smaller.');
      const text = await file.text();
      // Validate on the server too. Import only opens a draft; Save policy persists it.
      const { policy } = await send('/guardrail-yaml/validate', { yaml: text });
      if (!intoEditor) open(null);
      setForm(policy);
      setRules(JSON.stringify(policy.argumentRules, null, 2));
      setYamlText(text);
      setYamlError('');
      setProbeStage(policy.stages[0]);
      setResult(undefined);
      setEditorTab('yaml');
    }, false);
  }
  async function act(fn: () => Promise<unknown>, reload = true) {
    setBusy(true);
    setError('');
    try {
      await fn();
      if (reload) {
        await refresh();
        await load();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function workflowUses(w: Entity, id: string) {
    return (
      w.guardrailIds?.includes(id) ||
      w.resources?.some((r: any) => r.type === 'guardrail' && r.policyId === id) ||
      w.nodes?.some((n: any) => n.config?.guardrailIds?.includes(id))
    );
  }
  const policies = data.guardrails.filter((p) =>
    `${p.name} ${p.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="guardrails-page">
      <input
        ref={importInput}
        type="file"
        accept=".yaml,.yml,application/yaml,text/yaml"
        aria-label="Import policy YAML file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importYaml(file, importIntoEditor.current);
        }}
      />
      <PageTitle
        eyebrow="SAFETY & CONTROL"
        title="Guardrails"
        text="Build reusable safety policies. Choose a starting point, make it yours, and connect it to your agents."
        action={
          isAdmin && (
            <div className="guardrail-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  importIntoEditor.current = false;
                  importInput.current?.click();
                }}
              >
                <Upload size={15} />
                Import YAML
              </Button>
              <Button onClick={() => setTab('templates')}>
                <Plus size={16} />
                New policy
              </Button>
            </div>
          )
        }
      />
      <div className="guardrail-tabs" aria-label="Guardrail views">
        {(
          [
            ['policies', `My policies · ${data.guardrails.length}`],
            ['templates', 'Policy templates'],
            ['activity', 'Activity & evaluations'],
            ['defaults', 'Workspace defaults'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorNotice error={editing === undefined ? error : ''} />
      {success && (
        <div className="guardrail-success" role="status">
          <Check size={18} />
          <span>
            {success}{' '}
            <a href="/workflows">
              Open Workflows <ArrowRight size={14} />
            </a>
          </span>
          <button aria-label="Dismiss message" onClick={() => setSuccess('')}>
            ×
          </button>
        </div>
      )}
      {tab === 'templates' && (
        <>
          <div className="guardrail-section-heading">
            <div>
              <h2>Start with a safety template</h2>
              <p>Six focused starting points. Every policy is an editable copy you control.</p>
            </div>
            {isAdmin && (
              <Button variant="secondary" onClick={() => open(null)}>
                Create custom policy
              </Button>
            )}
          </div>
          <div className="guardrail-template-grid">
            {guardrailTemplates.map((t) => {
              const Icon = icons[t.id];
              return (
                <article className={`guardrail-template tone-${t.id}`} key={t.id}>
                  <div className="guardrail-template-top">
                    <span className="guardrail-icon">
                      <Icon size={23} />
                    </span>
                    <span className="guardrail-badge">
                      {t.policy.semanticChecks ? 'Safety model' : 'Pattern checks'}
                    </span>
                  </div>
                  <h3>{t.name}</h3>
                  <p>{t.description}</p>
                  <div className="guardrail-coverage">
                    <ShieldCheck size={14} />
                    {t.coverage}
                  </div>
                  <Button variant="secondary" onClick={() => open(null, t)}>
                    {isAdmin ? 'Use' : 'View'} {t.name} template
                    <ArrowRight size={15} />
                  </Button>
                </article>
              );
            })}
          </div>
          <div className="guardrail-guide">
            <ShieldCheck size={22} />
            <div>
              <h3>From policy to protected workflow</h3>
              <p>
                Choose a template → customize and save → open a workflow and add the policy from the toolbox.
                Connect its guardrail box above an agent, or select it in Workflow settings to cover the whole
                workflow.
              </p>
              <small>
                Safety-model templates require a configured NeMo classifier. Templates show their coverage and
                limitations before you save.
              </small>
            </div>
          </div>
        </>
      )}
      {tab === 'policies' && (
        <>
          <div className="guardrail-section-heading">
            <div>
              <h2>Your policy library</h2>
              <p>Saved policies are available in the workflow toolbox and agent settings.</p>
            </div>
            <label className="guardrail-search">
              <Search size={16} />
              <input
                aria-label="Search policies"
                placeholder="Search policies…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          {policies.length ? (
            <div className="guardrail-template-grid">
              {policies.map((p) => {
                const template = guardrailTemplates.find((t) => t.id === p.templateId),
                  Icon = template ? icons[template.id] : ShieldCheck;
                const uses = data.workflows.filter((w) => workflowUses(w, p.id)).length;
                return (
                  <article className="guardrail-template" key={p.id}>
                    <div className="guardrail-template-top">
                      <span className="guardrail-icon">
                        <Icon size={22} />
                      </span>
                      <span className={`guardrail-badge ${p.enabled ? 'enabled' : ''}`}>
                        {p.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <h3>{p.name}</h3>
                    <p>{p.description || 'Custom safety policy'}</p>
                    <div className="guardrail-tags">
                      <span>{template?.name ?? 'Custom'}</span>
                      <span>{p.provider === 'nemo' ? 'NeMo' : 'Built-in'}</span>
                      <span>{p.stages.length} stages</span>
                    </div>
                    <small>
                      {defaults.includes(p.id)
                        ? 'Workspace default · applies to every new run'
                        : `${uses} workflow${uses === 1 ? '' : 's'} · ${data.agents.filter((a) => a.guardrailIds?.includes(p.id)).length} standalone agents`}
                    </small>
                    <Button variant="secondary" onClick={() => open(p)}>
                      {isAdmin ? 'Edit policy' : 'View policy'}
                      <ArrowRight size={15} />
                    </Button>
                  </article>
                );
              })}
            </div>
          ) : (
            <Empty
              icon={<ShieldCheck />}
              title={query ? 'No matching policies' : 'Create your first safety policy'}
              text={
                query
                  ? 'Try a different search.'
                  : 'Start with a template, then attach your saved policy to a workflow.'
              }
              action={
                <Button
                  onClick={() => {
                    setQuery('');
                    setTab('templates');
                  }}
                >
                  Browse templates
                </Button>
              }
            />
          )}
        </>
      )}
      {tab === 'defaults' && (
        <section className="guardrail-panel">
          <h2>Workspace defaults</h2>
          <p>
            Apply these policies to every new run, in addition to workflow and agent policies. Changes do not
            alter runs already in progress.
          </p>
          <GuardrailPicker data={data} value={defaults} onChange={setDefaults} disabled={!isAdmin || busy} />
          {isAdmin && (
            <Button
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await send('/tenant', { guardrailIds: defaults }, 'PUT');
                  setSuccess('Workspace defaults saved.');
                })
              }
            >
              Save defaults
            </Button>
          )}
        </section>
      )}
      {tab === 'activity' && (
        <div className="guardrail-activity">
          <section className="guardrail-panel">
            <FlaskConical size={22} />
            <h2>Safety evaluations</h2>
            <p>Test a saved workflow before publishing. Reports retain the evaluated revision.</p>
            <Field label="Evaluation workflow">
              <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
                <option value="">Choose workflow…</option>
                {data.workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="guardrail-actions">
              <Button
                disabled={!workflowId || busy || !isAdmin}
                onClick={() => act(() => send('/guardrail-evaluations', { workflowId }))}
              >
                Evaluate workflow
              </Button>
              <Button
                variant="secondary"
                disabled={!workflowId || busy || !isAdmin}
                onClick={() => act(() => send('/guardrail-evaluations', { workflowId, suite: 'garak' }))}
              >
                Run Garak probes
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => act(load, false)}>
                Refresh reports
              </Button>
            </div>
            {!evaluations.length && (
              <p className="guardrail-muted">No evaluations yet. Choose a workflow to begin.</p>
            )}
            {evaluations.map((e) => (
              <details className="guardrail-report" key={e.id}>
                <summary>
                  {e.workflowName} · {e.status} · {e.passed ?? 0}/{e.total} checks passed
                </summary>
                {e.error && <ErrorNotice error={e.error} />}
                <pre>{JSON.stringify(e.results, null, 2)}</pre>
              </details>
            ))}
          </section>
          <section className="guardrail-panel">
            <div className="guardrail-section-heading">
              <h2>Recent decisions</h2>
              <Button variant="ghost" disabled={busy} onClick={() => act(load, false)}>
                Refresh decisions
              </Button>
            </div>
            {!audit.length && (
              <p className="guardrail-muted">Decisions appear here when a protected agent runs.</p>
            )}
            {audit.slice(0, 30).map((e) => (
              <div className="guardrail-decision" key={e.id}>
                <span className={`guardrail-badge decision-${e.decision}`}>{e.decision}</span>
                <div>
                  <strong>{data.guardrails.find((p) => p.id === e.policyId)?.name ?? 'Policy'}</strong>
                  <small>
                    {stageLabels[e.stage as RailStage] ?? e.stage} · {e.latencyMs} ms
                    {e.reason && ` · ${e.reason}`}
                  </small>
                </div>
              </div>
            ))}
          </section>
        </div>
      )}
      {editing !== undefined && (
        <Modal
          title={editing ? (isAdmin ? 'Edit policy' : 'View policy') : 'Create safety policy'}
          onClose={() => {
            if (!busy) setEditing(undefined);
          }}
          wide
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!isAdmin || busy) return;
              void act(async () => {
                const policy = parsedPolicy();
                await send(`/guardrails${editing ? `/${editing.id}` : ''}`, policy, editing ? 'PUT' : 'POST');
                setEditing(undefined);
                setTab('policies');
                setQuery('');
                setSuccess(`${policy.name} saved. Add it to a workflow to start using it.`);
              });
            }}
          >
            <div className="guardrail-editor">
              <div className="guardrail-editor-intro">
                <span className="guardrail-icon">
                  <ShieldCheck size={24} />
                </span>
                <div>
                  <strong>{source ? `${source.name} template` : 'Custom policy'}</strong>
                  <p>{source?.description ?? 'Choose what to inspect and how to respond.'}</p>
                </div>
              </div>
              <div className="guardrail-tabs">
                <button
                  type="button"
                  className={editorTab === 'configure' ? 'active' : ''}
                  aria-pressed={editorTab === 'configure'}
                  onClick={() => switchEditor('configure')}
                >
                  Configure policy
                </button>
                <button
                  type="button"
                  className={editorTab === 'test' ? 'active' : ''}
                  aria-pressed={editorTab === 'test'}
                  onClick={() => switchEditor('test')}
                >
                  Try it out
                </button>
                <button
                  type="button"
                  className={editorTab === 'yaml' ? 'active' : ''}
                  aria-pressed={editorTab === 'yaml'}
                  onClick={() => switchEditor('yaml')}
                >
                  <Code2 size={14} />
                  Policy YAML
                </button>
              </div>
              <div className="guardrail-yaml-toolbar">
                <span>
                  <Code2 size={15} />
                  {guardrailYamlFilename(form.name)}
                </span>
                {isAdmin && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      importIntoEditor.current = true;
                      importInput.current?.click();
                    }}
                  >
                    <Upload size={14} />
                    Import YAML into draft
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || Boolean(yamlError)}
                  onClick={exportYaml}
                >
                  <Download size={14} />
                  Export YAML
                </Button>
              </div>
              {editorTab === 'configure' ? (
                <fieldset className="guardrail-editor-fields" disabled={!isAdmin || busy}>
                  <div className="guardrail-form-row">
                    <Field label="Policy name">
                      <input
                        required
                        maxLength={100}
                        value={form.name}
                        onChange={(e) => patch({ name: e.target.value })}
                      />
                    </Field>
                    <Field label="Guardrail provider">
                      <select
                        value={form.provider}
                        onChange={(e) =>
                          patch({
                            provider: e.target.value as GuardrailPolicy['provider'],
                            ...(e.target.value === 'builtin' ? { semanticChecks: false } : {}),
                          })
                        }
                      >
                        <option value="nemo">NeMo Guardrails</option>
                        <option value="builtin">Built-in checks</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="Description">
                    <textarea
                      rows={2}
                      maxLength={1000}
                      value={form.description}
                      onChange={(e) => patch({ description: e.target.value })}
                    />
                  </Field>
                  <label className="guardrail-toggle">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(e) => patch({ enabled: e.target.checked })}
                    />
                    <span>
                      <strong>Enable policy</strong>
                      <small>Available for new workflow and agent runs.</small>
                    </span>
                  </label>
                  <h3>What this policy checks</h3>
                  {source && <p className="guardrail-limit">{source.limitation}</p>}
                  <div className="guardrail-check-grid">
                    {(
                      [
                        ['pii', 'Mask personal data', 'Email, US SSN, and payment-card patterns.'],
                        ['jailbreak', 'Prompt injection', 'Block common instruction-override patterns.'],
                        [
                          'contentSafety',
                          'Harmful content',
                          'Block a small baseline of harmful-content patterns.',
                        ],
                        [
                          'semanticChecks',
                          'Safety model checks',
                          'Classify content using your configured NeMo model.',
                        ],
                      ] as const
                    ).map(([key, label, hint]) => (
                      <label className="guardrail-toggle" key={key}>
                        <input
                          type="checkbox"
                          disabled={key === 'semanticChecks' && form.provider !== 'nemo'}
                          checked={form[key]}
                          onChange={(e) =>
                            patch({
                              [key]: e.target.checked,
                            })
                          }
                        />
                        <span>
                          <strong>{label}</strong>
                          <small>{hint}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  {(form.semanticChecks || form.safetyInstructions) && (
                    <>
                      {!form.semanticChecks && (
                        <ErrorNotice error="Safety instructions require NeMo safety model checks. Re-enable those checks or explicitly clear the instructions." />
                      )}
                      <div className="guardrail-limit">
                        Requires a NeMo safety model configured by your operator. Checks block if it is
                        unavailable unless you explicitly change the failure mode. Test the policy before
                        attaching it.
                      </div>
                      <Field
                        label="Safety instructions"
                        hint="Define what the classifier should allow or block. These instructions are applied at each selected stage."
                      >
                        <textarea
                          rows={6}
                          maxLength={4000}
                          value={form.safetyInstructions}
                          onChange={(e) => patch({ safetyInstructions: e.target.value })}
                        />
                      </Field>
                    </>
                  )}
                  <h3>Where to inspect</h3>
                  <div className="guardrail-check-grid">
                    {railStages.map((stage) => (
                      <label className="guardrail-toggle" key={stage}>
                        <input
                          type="checkbox"
                          checked={form.stages.includes(stage)}
                          onChange={(e) =>
                            patch({
                              stages: e.target.checked
                                ? [...form.stages, stage]
                                : form.stages.filter((s) => s !== stage),
                            })
                          }
                        />
                        <span>
                          <strong>{stageLabels[stage]}</strong>
                          <small>{stageHints[stage]}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  <Field label="Blocked response">
                    <textarea
                      rows={2}
                      maxLength={500}
                      value={form.blockMessage}
                      onChange={(e) => patch({ blockMessage: e.target.value })}
                    />
                  </Field>
                  <details className="guardrail-advanced">
                    <summary>Advanced rules & service settings</summary>
                    {(['deniedTerms', 'blockedTopics', 'deniedTools'] as const).map((key) => (
                      <Field
                        key={key}
                        label={
                          {
                            deniedTerms: 'Denied terms (one per line)',
                            blockedTopics: 'Blocked topics (one per line)',
                            deniedTools: 'Denied tool names (one per line)',
                          }[key]
                        }
                      >
                        <textarea
                          aria-label={key}
                          value={form[key].join('\n')}
                          onChange={(e) => patch({ [key]: e.target.value.split('\n') })}
                        />
                      </Field>
                    ))}
                    <Field
                      label="Argument rules (JSON)"
                      hint="Each rule has tool, path, operator (contains, equals, missing), and value."
                    >
                      <textarea
                        aria-label="Argument rules"
                        value={rules}
                        onChange={(e) => {
                          setRules(e.target.value);
                          setResult(undefined);
                        }}
                      />
                    </Field>
                    {form.provider === 'nemo' && (
                      <Field label="NeMo configuration">
                        <input value={form.configId} onChange={(e) => patch({ configId: e.target.value })} />
                      </Field>
                    )}
                    <Field label="Failure mode">
                      <select
                        value={form.failMode}
                        onChange={(e) => patch({ failMode: e.target.value as GuardrailPolicy['failMode'] })}
                      >
                        <option value="closed">Block if unavailable</option>
                        <option value="open">Allow if unavailable (audited)</option>
                      </select>
                    </Field>
                    <div className="guardrail-form-row">
                      <Field label="Timeout (ms)">
                        <input
                          type="number"
                          min={100}
                          max={30000}
                          value={form.timeoutMs}
                          onChange={(e) => patch({ timeoutMs: Number(e.target.value) })}
                        />
                      </Field>
                      <Field label="Run latency budget (ms)">
                        <input
                          type="number"
                          min={1000}
                          max={600000}
                          value={form.latencyBudgetMs}
                          onChange={(e) => patch({ latencyBudgetMs: Number(e.target.value) })}
                        />
                      </Field>
                    </div>
                  </details>
                </fieldset>
              ) : editorTab === 'yaml' ? (
                <div className="guardrail-yaml-panel">
                  <p>
                    Edit <code>custom_data.openharness.policy</code> to configure this policy. Valid YAML
                    updates the form and previews; form changes update the YAML.
                  </p>
                  <label className="guardrail-code-label" htmlFor="guardrail-policy-yaml">
                    Policy YAML content
                  </label>
                  <textarea
                    id="guardrail-policy-yaml"
                    aria-label="Policy YAML content"
                    spellCheck={false}
                    readOnly={!isAdmin || busy}
                    value={yamlText}
                    onChange={(e) => {
                      const text = e.target.value;
                      setYamlText(text);
                      setResult(undefined);
                      setError('');
                      try {
                        applyYaml(text);
                      } catch (err) {
                        setYamlError(errorMessage(err));
                      }
                    }}
                  />
                  <ErrorNotice error={yamlError} />
                  <div className="guardrail-yaml-status">
                    <span>
                      {yamlError
                        ? 'Fix the YAML before saving, exporting, or switching views.'
                        : 'Valid policy · synchronized with the form'}
                    </span>
                    {isAdmin && yamlError && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setYamlText(guardrailYaml(form));
                          setYamlError('');
                          setError('');
                        }}
                      >
                        Restore last valid policy
                      </Button>
                    )}
                  </div>
                  <small>
                    Uses the installed NeMo OpenHarness flow. Stage routing and tool rules are enforced by
                    OpenHarness. Formatting and comments are normalized when saved or changed through the
                    form; service credentials are configured separately.
                  </small>
                </div>
              ) : (
                <div className="guardrail-test">
                  <h3>Preview a decision</h3>
                  <p>
                    Try the current settings before saving. This preview checks text only and never executes a
                    tool.
                  </p>
                  <Field label="Inspection stage">
                    <select
                      value={probeStage}
                      onChange={(e) => {
                        setProbeStage(e.target.value as RailStage);
                        setResult(undefined);
                      }}
                    >
                      {railStages.map((stage) => (
                        <option key={stage} value={stage}>
                          {stageLabels[stage]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {!form.stages.includes(probeStage) && (
                    <p className="guardrail-limit">
                      This stage is not enabled. Select an enabled stage or update “Where to inspect”.
                    </p>
                  )}
                  {probeStage === 'tool_input' && (
                    <Field label="Tool name">
                      <input
                        value={probeTool}
                        onChange={(e) => {
                          setProbeTool(e.target.value);
                          setResult(undefined);
                        }}
                      />
                    </Field>
                  )}
                  <Field label="Test content">
                    <textarea
                      rows={5}
                      value={probe}
                      onChange={(e) => {
                        setProbe(e.target.value);
                        setResult(undefined);
                      }}
                    />
                  </Field>
                  <Button
                    type="button"
                    disabled={
                      busy ||
                      !isAdmin ||
                      !form.stages.includes(probeStage) ||
                      (probeStage === 'tool_input' && !probeTool.trim())
                    }
                    onClick={() =>
                      act(async () => {
                        setResult(undefined);
                        setResult(
                          await send('/guardrail-check', {
                            policy: parsedPolicy(),
                            stage: probeStage,
                            content: probe,
                            ...(probeStage === 'tool_input' ? { tool: probeTool } : {}),
                          }),
                        );
                      }, false)
                    }
                  >
                    <FlaskConical size={16} />
                    Check content
                  </Button>
                  {!isAdmin && <p>Policy previews require a workspace administrator.</p>}
                  {result && (
                    <div className="guardrail-preview" role="status">
                      <span className={`guardrail-badge decision-${result.decision}`}>{result.decision}</span>
                      {result.reason && <p>{result.reason}</p>}
                      <pre>{result.content}</pre>
                    </div>
                  )}
                </div>
              )}
              <ErrorNotice error={error} />
            </div>
            <div className="modal-footer guardrail-editor-footer">
              {editing && isAdmin && (
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await send(`/guardrails/${editing.id}`, undefined, 'DELETE');
                      setEditing(undefined);
                      setSuccess('Policy deleted.');
                    })
                  }
                >
                  Delete policy
                </Button>
              )}
              <Button variant="secondary" type="button" disabled={busy} onClick={() => setEditing(undefined)}>
                Cancel
              </Button>
              {isAdmin && (
                <Button type="submit" disabled={busy || Boolean(yamlError)}>
                  {busy ? 'Saving…' : 'Save policy'}
                </Button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
