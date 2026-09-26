import { useEffect, useState } from 'react';
import { ShieldCheck, Plus } from 'lucide-react';
import {
  guardrailPolicySchema,
  railStages,
  type GuardrailPolicy,
} from '../../../../packages/core/src/guardrailPolicy.js';
import { api, send, errorMessage, type Data, type Entity } from '../api';
import { Button, ErrorNotice, Field, Modal } from './ui';

export function GuardrailPicker({
  data,
  value = [],
  onChange,
}: {
  data: Data;
  value?: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="guardrail-picker">
      <legend>Safety policies</legend>
      {data.guardrails.length ? (
        data.guardrails.map((p) => (
          <label key={p.id}>
            <input
              type="checkbox"
              checked={value.includes(p.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, p.id] : value.filter((id) => id !== p.id))
              }
            />
            {p.name} · {p.provider}
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
  const [editing, setEditing] = useState<Entity | null | undefined>();
  const [form, setForm] = useState<GuardrailPolicy>(guardrailPolicySchema.parse({ name: 'Safety policy' }));
  const [rules, setRules] = useState('[]');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [probe, setProbe] = useState('Contact alice@example.com');
  const [result, setResult] = useState<any>();
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
  const patch = (p: Partial<GuardrailPolicy>) => setForm((f) => ({ ...f, ...p }));
  function open(p: Entity | null) {
    setEditing(p);
    setForm(guardrailPolicySchema.parse(p ?? { name: 'Safety policy' }));
    setRules(JSON.stringify(p?.argumentRules ?? [], null, 2));
    setResult(undefined);
    setError('');
  }
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Guardrails</h2>
          <p>Inspect inputs, answers, retrieved knowledge and tool calls with a shared safety policy.</p>
        </div>
        {isAdmin && (
          <Button onClick={() => open(null)}>
            <Plus size={16} />
            New policy
          </Button>
        )}
      </div>
      <ErrorNotice error={error} />
      <div className="resource-grid">
        {data.guardrails.map((p) => (
          <article className="resource-card" key={p.id}>
            <ShieldCheck />
            <h3>{p.name}</h3>
            <p>
              {p.description ||
                `${p.provider === 'nemo' ? 'NeMo Guardrails' : 'Built-in checks'} · ${p.stages.length} stages`}
            </p>
            <p>
              {p.enabled ? 'Enabled' : 'Disabled'} · Fail {p.failMode}
            </p>
            <Button onClick={() => open(p)}>{isAdmin ? 'Edit policy' : 'View policy'}</Button>
          </article>
        ))}
      </div>
      <section className="settings-section">
        <h3>Workspace defaults</h3>
        <p>These policies apply to every new run, in addition to workflow and agent policies.</p>
        <GuardrailPicker data={data} value={defaults} onChange={setDefaults} />
        {isAdmin && (
          <Button
            disabled={busy}
            onClick={() => act(() => send('/tenant', { guardrailIds: defaults }, 'PUT'))}
          >
            Save defaults
          </Button>
        )}
      </section>
      <section className="settings-section">
        <h3>Safety evaluations</h3>
        <p>
          Run a bounded safety dataset against a workflow before publishing it. Reports retain the workflow
          revision.
        </p>
        <select
          aria-label="Evaluation workflow"
          value={workflowId}
          onChange={(e) => setWorkflowId(e.target.value)}
        >
          <option value="">Choose workflow…</option>
          {data.workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <Button
          disabled={!workflowId || busy || !isAdmin}
          onClick={() => act(() => send('/guardrail-evaluations', { workflowId }))}
        >
          Evaluate workflow
        </Button>
        <Button
          disabled={!workflowId || busy || !isAdmin}
          onClick={() => act(() => send('/guardrail-evaluations', { workflowId, suite: 'garak' }))}
        >
          Run Garak probes
        </Button>
        <Button onClick={() => act(load)}>Refresh reports</Button>
        {evaluations.map((e) => (
          <details key={e.id}>
            <summary>
              {e.workflowName} · {e.status} · {e.passed ?? 0}/{e.total} checks passed
            </summary>
            <pre>{JSON.stringify(e.results, null, 2)}</pre>
          </details>
        ))}
      </section>
      <section className="settings-section">
        <h3>Recent decisions</h3>
        <Button onClick={() => act(load)}>Refresh decisions</Button>
        {audit.slice(0, 30).map((e) => (
          <p key={e.id}>
            {e.stage} · {e.decision} · {e.latencyMs} ms · {e.reason ?? e.policyId}
          </p>
        ))}
      </section>
      {editing !== undefined && (
        <Modal
          title={editing ? 'Guardrail policy' : 'New guardrail policy'}
          onClose={() => setEditing(undefined)}
          wide
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const policy = guardrailPolicySchema.parse({
                  ...form,
                  argumentRules: JSON.parse(rules),
                  deniedTerms: form.deniedTerms.filter(Boolean),
                  blockedTopics: form.blockedTopics.filter(Boolean),
                  deniedTools: form.deniedTools.filter(Boolean),
                });
                await send(`/guardrails${editing ? `/${editing.id}` : ''}`, policy, editing ? 'PUT' : 'POST');
                setEditing(undefined);
              });
            }}
          >
            <div className="form-content">
              <Field label="Policy name">
                <input
                  required
                  aria-label="Policy name"
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label="Description">
                <input value={form.description} onChange={(e) => patch({ description: e.target.value })} />
              </Field>
              <Field label="Guardrail provider">
                <select
                  aria-label="Guardrail provider"
                  value={form.provider}
                  onChange={(e) => patch({ provider: e.target.value as any })}
                >
                  <option value="nemo">NeMo Guardrails service</option>
                  <option value="builtin">Built-in checks</option>
                </select>
              </Field>
              {form.provider === 'nemo' && (
                <Field label="NeMo configuration">
                  <input value={form.configId} onChange={(e) => patch({ configId: e.target.value })} />
                </Field>
              )}
              <fieldset>
                <legend>Inspection stages</legend>
                {railStages.map((stage) => (
                  <label key={stage}>
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
                    {stage.replaceAll('_', ' ')}
                  </label>
                ))}
              </fieldset>
              {(['enabled', 'pii', 'jailbreak', 'contentSafety', 'semanticChecks'] as const).map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={form[key]}
                    onChange={(e) => patch({ [key]: e.target.checked })}
                  />
                  {
                    {
                      enabled: 'Enable policy',
                      pii: 'Mask PII patterns',
                      jailbreak: 'Detect jailbreak patterns',
                      contentSafety: 'Content safety patterns',
                      semanticChecks: 'Use configured safety model (NeMo only)',
                    }[key]
                  }
                </label>
              ))}
              <p>
                Pattern checks are a baseline. Semantic checks require an operator-configured local or NIM
                safety model.
              </p>
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
              <Field label="Argument rules (JSON)">
                <textarea
                  aria-label="Argument rules"
                  value={rules}
                  onChange={(e) => setRules(e.target.value)}
                />
                <small>Each rule has tool, path, operator (contains, equals, missing), and value.</small>
              </Field>
              <Field label="Failure mode">
                <select value={form.failMode} onChange={(e) => patch({ failMode: e.target.value as any })}>
                  <option value="closed">Block if unavailable</option>
                  <option value="open">Allow if unavailable (audited)</option>
                </select>
              </Field>
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
              <Field label="Blocked response">
                <textarea
                  value={form.blockMessage}
                  onChange={(e) => patch({ blockMessage: e.target.value })}
                />
              </Field>
              <Field label="Try a policy input">
                <textarea value={probe} onChange={(e) => setProbe(e.target.value)} />
              </Field>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  act(async () =>
                    setResult(
                      await send('/guardrail-check', {
                        policy: { ...form, argumentRules: JSON.parse(rules) },
                        stage: 'input',
                        content: probe,
                      }),
                    ),
                  )
                }
              >
                Check input
              </Button>
              {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
              <ErrorNotice error={error} />
            </div>
            <div className="modal-footer">
              {isAdmin && (
                <Button type="submit" disabled={busy}>
                  Save policy
                </Button>
              )}
              {editing && isAdmin && (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await send(`/guardrails/${editing.id}`, undefined, 'DELETE');
                      setEditing(undefined);
                    })
                  }
                >
                  Delete policy
                </Button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
