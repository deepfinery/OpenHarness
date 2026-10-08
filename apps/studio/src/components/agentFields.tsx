import { secretList } from './PythonSecrets';
import { GuardrailPicker } from './GuardrailsPage';
import { humanSettingsSchema } from '../../../../packages/core/src/schema.js';
import { useId, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { agentRecipes } from '../../../../packages/core/src/starters.js';
import {
  autoEffort,
  effortLevels,
  effortPresets,
  type EffortLevel,
} from '../../../../packages/core/src/patterns.js';
import { describeSchedule } from '../../../../packages/core/src/schedule.js';
import { resolveNotebook } from '../../../../packages/core/src/notebooks.js';
import type { Agent, Schedule } from '../../../../packages/core/src/schema.js';
import { timestamp, type Data } from '../api';
import { ErrorNotice, Field } from './ui';
import { PatternFields } from './editors';
import { ProviderControl } from './ResourceControls';
import { SkillPicker } from './SkillsPage';

/** Effort sets the agent's budgets in one move: turns, tokens, time limit and pattern passes. */
export function applyEffort(agent: Agent, effort: EffortLevel): Partial<Agent> {
  if (effort === 'auto') return { effort, tokenBudget: undefined };
  const p = effortPresets[effort];
  return {
    effort,
    maxTurns: p.maxTurns,
    timeoutSeconds: p.timeoutSeconds,
    tokenBudget: p.tokenBudget,
    patternConfig: { ...agent.patternConfig, ...p.patternConfig },
  };
}
const compact = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`);
export function EffortControl({
  value,
  onChange,
}: {
  value: EffortLevel;
  onChange: (effort: EffortLevel) => void;
}) {
  return (
    <Field label="Effort" hint={value === 'auto' ? autoEffort.summary : effortPresets[value].summary}>
      <div className="segmented effort-control" role="radiogroup" aria-label="Effort">
        {effortLevels.map((level) => (
          <button
            type="button"
            key={level}
            role="radio"
            aria-checked={value === level}
            className={value === level ? 'active' : ''}
            onClick={() => onChange(level)}
          >
            {level === 'auto' ? autoEffort.label : effortPresets[level].label}
          </button>
        ))}
      </div>
    </Field>
  );
}
/** Everything that defines an agent card, without the node-level name and input prompt. */
export function AgentFields({
  value,
  data,
  refresh,
  onChange,
  inheritedMemory,
}: {
  value: Agent;
  data: Data;
  refresh: () => Promise<void>;
  onChange: (patch: Partial<Agent>) => void;
  inheritedMemory?: Pick<Agent, 'workspace' | 'experience'>;
}) {
  const categories = ['General', 'Reasoning', 'Knowledge', 'Safety & human input'];
  const [tab, setTab] = useState('General');
  const tabsId = useId();
  const categoryId = (category: string) => category.toLowerCase().replace(/[^a-z]+/g, '-');
  const effort = value.effort ?? 'medium';
  const notebook = resolveNotebook(value, inheritedMemory);
  return (
    <>
      <div className="agent-settings-tabs" role="tablist" aria-label="Agent settings categories">
        {categories.map((category, index) => (
          <button
            type="button"
            role="tab"
            key={category}
            id={`${tabsId}-tab-${categoryId(category)}`}
            aria-controls={`${tabsId}-panel-${categoryId(category)}`}
            aria-selected={tab === category}
            tabIndex={tab === category ? 0 : -1}
            onClick={() => setTab(category)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % categories.length
                  : event.key === 'ArrowLeft'
                    ? (index + categories.length - 1) % categories.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? categories.length - 1
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              setTab(categories[next]);
              document.getElementById(`${tabsId}-tab-${categoryId(categories[next])}`)?.focus();
            }}
          >
            {category}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={`${tabsId}-panel-general`}
        aria-labelledby={`${tabsId}-tab-general`}
        hidden={tab !== 'General'}
      >
        <ProviderControl
          data={data}
          refresh={refresh}
          value={value.providerId}
          onChange={(providerId) => onChange({ providerId })}
        />
        <Field
          label="Vision model"
          hint="Used for turns with images, including image follow-ups. Text-only conversations use the model above."
        >
          <select
            aria-label="Harness vision model"
            value={value.visionProviderId ?? ''}
            onChange={(e) => onChange({ visionProviderId: e.target.value || undefined })}
          >
            <option value="">
              {data.providers.find((p) => p.id === value.providerId)?.modelType === 'vision'
                ? 'Use the primary vision model'
                : 'No vision model selected'}
            </option>
            {data.providers
              .filter((p) => p.modelType === 'vision')
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Template">
          <select
            aria-label="Agent template"
            value=""
            onChange={(e) => {
              const r = agentRecipes.find((x) => x.id === e.target.value);
              if (r)
                onChange({
                  name: !value.name || value.name === 'AI agent' ? r.name : value.name,
                  description: r.description,
                  systemPrompt: r.systemPrompt,
                  pattern: r.pattern,
                  patternConfig: { ...value.patternConfig, ...r.patternConfig },
                });
            }}
          >
            <option value="">Start from a template…</option>
            {agentRecipes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} — {r.description}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Instructions">
          <textarea
            aria-label="Agent instructions"
            className="prompt-input"
            rows={7}
            value={value.systemPrompt}
            onChange={(e) => onChange({ systemPrompt: e.target.value })}
          />
        </Field>
        <Field
          label="Timezone"
          hint="Used for the runtime clock and relative dates. Leave empty to follow the requester's browser or API timezone, then the harness schedule timezone, then UTC."
        >
          <input
            aria-label="Agent timezone"
            placeholder="UTC or America/New_York"
            value={value.timezone ?? ''}
            onChange={(e) => onChange({ timezone: e.target.value || undefined })}
          />
        </Field>
      </section>
      <section
        role="tabpanel"
        id={`${tabsId}-panel-reasoning`}
        aria-labelledby={`${tabsId}-tab-reasoning`}
        hidden={tab !== 'Reasoning'}
      >
        <EffortControl value={effort} onChange={(level) => onChange(applyEffort(value, level))} />
        <div className="form-section">
          <h3>Sub-agents</h3>
          <label className="check-row">
            <input
              type="checkbox"
              aria-label="Can start sub-agents"
              checked={Boolean(value.delegation?.enabled)}
              onChange={(e) =>
                onChange({
                  delegation: { maxAgents: value.delegation?.maxAgents ?? 4, enabled: e.target.checked },
                })
              }
            />
            Can hand focused tasks to sub-agents that work in parallel with a share of this agent’s budget
          </label>
          {value.delegation?.enabled && (
            <Field label="Sub-agents per run">
              <input
                aria-label="Sub-agents per run"
                type="number"
                min={1}
                max={10_000}
                value={value.delegation.maxAgents ?? 4}
                onChange={(e) =>
                  onChange({
                    delegation: {
                      enabled: true,
                      maxAgents: Math.max(1, Math.min(10_000, Number(e.target.value) || 1)),
                    },
                  })
                }
              />
            </Field>
          )}
        </div>
        <div className="form-section">
          <h3>Reasoning pattern</h3>
          <PatternFields
            pattern={value.pattern ?? 'react'}
            config={value.patternConfig ?? {}}
            onPattern={(pattern) => onChange({ pattern })}
            onConfig={(patternConfig) => onChange({ patternConfig: patternConfig as Agent['patternConfig'] })}
          />
        </div>
        {value.pattern === 'reflection' && (
          <Field
            label="Judge model"
            hint="Choose a separate model for critique, or use the working model. Judge tokens share this agent’s budget."
          >
            <select
              aria-label="Judge model"
              value={value.patternConfig?.judgeProviderId ?? ''}
              onChange={(e) =>
                onChange({
                  patternConfig: { ...value.patternConfig, judgeProviderId: e.target.value || undefined },
                })
              }
            >
              <option value="">Same as working model</option>
              {data.providers
                .filter((p) => p.modelType !== 'embedding')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <div className="form-section">
          <h3>Limits</h3>
          <label className="check-row">
            <input
              type="checkbox"
              aria-label="Automatic context compaction"
              checked={value.contextCompaction !== false}
              onChange={(e) => onChange({ contextCompaction: e.target.checked })}
            />
            Compress context early and save displaced evidence in task memory
          </label>
          <p className="field-help">
            Context guards and a final-answer reserve always apply. Sub-agents can read saved evidence when
            delegation is enabled. A limit of 0 means no limit: the agent works until it is done.
          </p>
          {effort === 'auto' ? (
            <p className="field-help">
              Auto picks the budgets for each request: light ({effortPresets.light.maxTurns} turns,{' '}
              {compact(effortPresets.light.tokenBudget)} tokens), medium ({effortPresets.medium.maxTurns}{' '}
              turns, {compact(effortPresets.medium.tokenBudget)}) or high ({effortPresets.high.maxTurns}{' '}
              turns, {compact(effortPresets.high.tokenBudget)}). Choose a fixed level to set your own.
            </p>
          ) : (
            <div className="two-columns">
              <Field label="Turns per pass" hint="0 = unlimited.">
                <input
                  aria-label="Maximum turns"
                  type="number"
                  min={0}
                  max={10_000_000}
                  value={value.maxTurns ?? 12}
                  onChange={(e) => onChange({ maxTurns: Number(e.target.value) })}
                />
              </Field>
              <Field label="Token budget" hint="Prompt and completion tokens per run. 0 = unlimited.">
                <input
                  aria-label="Token budget"
                  type="number"
                  min={0}
                  max={1_000_000_000_000}
                  step={1000}
                  value={value.tokenBudget ?? effortPresets[effort].tokenBudget}
                  onChange={(e) => onChange({ tokenBudget: Number(e.target.value) })}
                />
              </Field>
              <Field label="Time limit (seconds)" hint="0 = unlimited.">
                <input
                  aria-label="Agent time limit"
                  type="number"
                  min={0}
                  max={31_536_000}
                  value={value.timeoutSeconds ?? 300}
                  onChange={(e) => onChange({ timeoutSeconds: Number(e.target.value) })}
                />
              </Field>
            </div>
          )}
        </div>{' '}
      </section>
      <section
        role="tabpanel"
        id={`${tabsId}-panel-knowledge`}
        aria-labelledby={`${tabsId}-tab-knowledge`}
        hidden={tab !== 'Knowledge'}
      >
        <Field
          label="Long-term memory"
          hint="Use a knowledge base as a persistent Markdown notebook for environment findings, conversation notes, skill-directed notes and feedback lessons. The default is harness memory, then the first attached knowledge base."
        >
          <select
            aria-label="Agent long-term memory"
            value={value.workspace?.knowledgeBaseId ?? ''}
            onChange={(e) =>
              onChange({
                workspace: e.target.value
                  ? { knowledgeBaseId: e.target.value, offloadToolResults: true }
                  : undefined,
                experience: e.target.value
                  ? { enabled: true, recallLimit: 3, learnFromFailures: true }
                  : undefined,
              })
            }
          >
            <option value="">Use harness memory or first attached knowledge base</option>
            {data.knowledge.map((kb) => (
              <option key={kb.id} value={kb.id}>
                {kb.name}
              </option>
            ))}
          </select>
        </Field>
        {notebook.workspace && (
          <label className="check-row">
            <input
              type="checkbox"
              aria-label="Agent learn from experience"
              checked={notebook.experience?.enabled !== false}
              onChange={(e) =>
                onChange({
                  experience: {
                    recallLimit: 3,
                    learnFromFailures: true,
                    ...value.experience,
                    enabled: e.target.checked,
                  },
                })
              }
            />
            Learn from feedback and failures
          </label>
        )}
        <SkillPicker
          data={data}
          refresh={refresh}
          value={value.skillIds ?? []}
          onChange={(skillIds) => onChange({ skillIds })}
        />
      </section>
      <section
        role="tabpanel"
        id={`${tabsId}-panel-safety-human-input`}
        aria-labelledby={`${tabsId}-tab-safety-human-input`}
        hidden={tab !== 'Safety & human input'}
      >
        <GuardrailPicker
          data={data}
          value={value.guardrailIds}
          onChange={(guardrailIds) => onChange({ guardrailIds })}
        />
        <Field
          label="Human input"
          hint="The agent can pause to ask a question. Answer it in the Inbox or Playground."
        >
          <label className="check-row">
            <input
              type="checkbox"
              checked={value.humanInput !== false}
              onChange={(e) => onChange({ humanInput: e.target.checked })}
            />
            Allow questions
          </label>
        </Field>
        <Field
          label="Python code"
          hint="The agent writes Python and runs it in a fresh container (run_python): data processing over this workspace’s MongoDB collections, API syncs, backtests. Many jobs can run in parallel."
        >
          <label className="check-row">
            <input
              type="checkbox"
              aria-label="Can run Python"
              checked={Boolean(value.codeExecution?.enabled)}
              onChange={(e) =>
                onChange({
                  codeExecution: {
                    timeoutSeconds: value.codeExecution?.timeoutSeconds ?? 0,
                    requireApproval: value.codeExecution?.requireApproval ?? false,
                    secrets: value.codeExecution?.secrets ?? [],
                    enabled: e.target.checked,
                  },
                })
              }
            />
            Can run Python it writes
          </label>
          {value.codeExecution?.enabled && (
            <>
              <label className="check-row">
                <input
                  type="checkbox"
                  aria-label="Approve Python before it runs"
                  checked={Boolean(value.codeExecution?.requireApproval)}
                  onChange={(e) =>
                    onChange({
                      codeExecution: {
                        timeoutSeconds: value.codeExecution?.timeoutSeconds ?? 0,
                        secrets: value.codeExecution?.secrets ?? [],
                        enabled: true,
                        requireApproval: e.target.checked,
                      },
                    })
                  }
                />
                Ask a human to approve the code before each run
              </label>
              <Field
                label="Seconds per job"
                hint="0 = the installation default. The agent may ask for more per call."
              >
                <input
                  aria-label="Python seconds per job"
                  type="number"
                  min={0}
                  max={2_592_000}
                  value={value.codeExecution?.timeoutSeconds ?? 0}
                  onChange={(e) =>
                    onChange({
                      codeExecution: {
                        requireApproval: value.codeExecution?.requireApproval ?? false,
                        secrets: value.codeExecution?.secrets ?? [],
                        enabled: true,
                        timeoutSeconds: Number(e.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field
                label="Secrets for the code"
                hint="Names from Settings → Python secrets, comma-separated."
              >
                <input
                  aria-label="Python secrets"
                  placeholder="FMP_API_KEY"
                  defaultValue={(value.codeExecution?.secrets ?? []).join(', ')}
                  onBlur={(e) =>
                    onChange({
                      codeExecution: {
                        timeoutSeconds: value.codeExecution?.timeoutSeconds ?? 0,
                        requireApproval: value.codeExecution?.requireApproval ?? false,
                        enabled: true,
                        secrets: secretList(e.target.value),
                      },
                    })
                  }
                />
              </Field>
            </>
          )}
        </Field>
        <Field
          label="Tool approvals"
          hint="Risk-based approval treats tools without a read-only annotation as risky. Per-tool rules can be configured in the API."
        >
          <select
            aria-label="Tool approvals"
            value={value.approvals?.mode ?? 'never'}
            onChange={(e) =>
              onChange({ approvals: humanSettingsSchema.parse({ ...value.approvals, mode: e.target.value }) })
            }
          >
            <option value="never">No approval required</option>
            <option value="when_risky">Ask for risky tools</option>
            <option value="always">Ask for every MCP tool</option>
          </select>
        </Field>
        <Field label="Approval timeout (minutes)">
          <input
            type="number"
            min={1}
            max={10080}
            value={(value.approvals?.timeoutSeconds ?? 86400) / 60}
            onChange={(e) =>
              onChange({
                approvals: humanSettingsSchema.parse({
                  ...value.approvals,
                  timeoutSeconds: Math.min(604800, Math.max(60, Number(e.target.value) * 60)),
                }),
              })
            }
          />
        </Field>
        <Field
          label="Timeout action"
          hint="Tools are denied on timeout. Continue allows a review step to use its original result; escalation gives administrators one more timeout period."
        >
          <select
            aria-label="Human timeout action"
            value={value.approvals?.timeoutAction ?? 'deny'}
            onChange={(e) =>
              onChange({
                approvals: humanSettingsSchema.parse({ ...value.approvals, timeoutAction: e.target.value }),
              })
            }
          >
            <option value="deny">Deny</option>
            <option value="continue">Continue without new input</option>
            <option value="escalate">Escalate to administrators</option>
          </select>
        </Field>
        <label className="check-row">
          <input
            type="checkbox"
            checked={value.approvals?.notifyEmail ?? false}
            onChange={(e) =>
              onChange({
                approvals: humanSettingsSchema.parse({ ...value.approvals, notifyEmail: e.target.checked }),
              })
            }
          />
          Email authorized approvers
        </label>
      </section>
    </>
  );
}

const frequencies = [
  { label: 'Every minute', minutes: 1 },
  { label: 'Every 5 minutes', minutes: 5 },
  { label: 'Every 15 minutes', minutes: 15 },
  { label: 'Every 30 minutes', minutes: 30 },
  { label: 'Every hour', minutes: 60 },
  { label: 'Every 6 hours', minutes: 360 },
  { label: 'Every day', minutes: 1440 },
  { label: 'Every week', minutes: 10080 },
  { label: 'Custom interval', minutes: 0 },
];
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function ScheduleFields({
  value,
  onChange,
  nextRunAt,
  lastError,
}: {
  value?: Schedule;
  onChange: (schedule: Schedule) => void;
  nextRunAt?: string;
  lastError?: string;
}) {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const s: Schedule = value ?? {
    enabled: false,
    everyMinutes: 1440,
    input: 'Run the scheduled task.',
    at: '09:00',
    timezone: browserZone,
  };
  const [custom, setCustom] = useState(!frequencies.some((f) => f.minutes === s.everyMinutes));
  const update = (patch: Partial<Schedule>) => onChange({ ...s, ...patch });
  const wallClock = s.everyMinutes >= 1440;
  return (
    <div className="schedule-fields">
      <label className="check-row">
        <input
          type="checkbox"
          aria-label="Run on a schedule"
          checked={s.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <span>
          <strong>Run on a schedule</strong>
          <small>{s.enabled ? describeSchedule(s) : 'Off'}</small>
        </span>
      </label>
      {s.enabled && (
        <>
          <div className="two-columns">
            <Field label="How often">
              <select
                aria-label="Schedule frequency"
                value={custom ? 0 : s.everyMinutes}
                onChange={(e) => {
                  const m = Number(e.target.value);
                  if (!m) return setCustom(true);
                  setCustom(false);
                  update({
                    everyMinutes: m,
                    weekday: m === 10080 ? (s.weekday ?? 1) : undefined,
                    ...(m >= 1440 ? { at: s.at ?? '09:00', timezone: s.timezone ?? browserZone } : {}),
                  });
                }}
              >
                {frequencies.map((f) => (
                  <option key={f.minutes} value={f.minutes}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
            {custom && (
              <Field label="Every (minutes)">
                <input
                  aria-label="Schedule interval"
                  type="number"
                  min={1}
                  max={525600}
                  value={s.everyMinutes}
                  onChange={(e) => update({ everyMinutes: Math.max(1, Number(e.target.value) || 1) })}
                />
              </Field>
            )}
            {s.everyMinutes === 10080 && (
              <Field label="On">
                <select
                  aria-label="Schedule weekday"
                  value={s.weekday ?? 1}
                  onChange={(e) => update({ weekday: Number(e.target.value) })}
                >
                  {days.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {wallClock && (
              <Field label="At">
                <input
                  aria-label="Schedule time"
                  type="time"
                  value={s.at ?? '09:00'}
                  onChange={(e) => update({ at: e.target.value || '09:00' })}
                />
              </Field>
            )}
            {wallClock && (
              <Field label="Time zone">
                <select
                  aria-label="Schedule time zone"
                  value={s.timezone ?? browserZone}
                  onChange={(e) => update({ timezone: e.target.value })}
                >
                  {[...new Set([browserZone, 'UTC', s.timezone].filter(Boolean) as string[])].map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <Field label="Message to send">
            <textarea
              aria-label="Scheduled input"
              rows={2}
              value={s.input}
              onChange={(e) => update({ input: e.target.value })}
            />
          </Field>
          {nextRunAt && (
            <p className="field-help schedule-next">
              <Clock3 size={13} /> Next run {timestamp(nextRunAt)}
            </p>
          )}
          <ErrorNotice error={lastError} />
        </>
      )}
    </div>
  );
}
