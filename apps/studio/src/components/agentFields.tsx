import { useState } from 'react';
import { Clock3 } from 'lucide-react';
import { agentRecipes } from '../../../../packages/core/src/starters.js';
import {
  autoEffort,
  effortLevels,
  effortPresets,
  type EffortLevel,
} from '../../../../packages/core/src/patterns.js';
import { describeSchedule } from '../../../../packages/core/src/schedule.js';
import type { Agent, Schedule } from '../../../../packages/core/src/schema.js';
import { timestamp, type Data } from '../api';
import { ErrorNotice, Field } from './ui';
import { PatternFields } from './editors';
import { ProviderControl } from './ResourceControls';

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
}: {
  value: Agent;
  data: Data;
  refresh: () => Promise<void>;
  onChange: (patch: Partial<Agent>) => void;
}) {
  const effort = value.effort ?? 'medium';
  return (
    <>
      <ProviderControl
        data={data}
        refresh={refresh}
        value={value.providerId}
        onChange={(providerId) => onChange({ providerId })}
      />
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
      <EffortControl value={effort} onChange={(level) => onChange(applyEffort(value, level))} />
      <Field label="Instructions">
        <textarea
          aria-label="Agent instructions"
          className="prompt-input"
          rows={7}
          value={value.systemPrompt}
          onChange={(e) => onChange({ systemPrompt: e.target.value })}
        />
      </Field>
      <div className="form-section">
        <h3>Reasoning pattern</h3>
        <PatternFields
          pattern={value.pattern ?? 'react'}
          config={value.patternConfig ?? {}}
          onPattern={(pattern) => onChange({ pattern })}
          onConfig={(patternConfig) => onChange({ patternConfig: patternConfig as Agent['patternConfig'] })}
        />
      </div>
      <details className="advanced">
        <summary>Limits</summary>
        {effort === 'auto' ? (
          <p className="field-help">
            Auto picks the budgets for each request: light ({effortPresets.light.maxTurns} turns,{' '}
            {compact(effortPresets.light.tokenBudget)} tokens), medium ({effortPresets.medium.maxTurns} turns,{' '}
            {compact(effortPresets.medium.tokenBudget)}) or high ({effortPresets.high.maxTurns} turns,{' '}
            {compact(effortPresets.high.tokenBudget)}). Choose a fixed level to set your own.
          </p>
        ) : (
          <div className="two-columns">
            <Field label="Turns per pass">
              <input
                aria-label="Maximum turns"
                type="number"
                min={1}
                max={40}
                value={value.maxTurns ?? 12}
                onChange={(e) => onChange({ maxTurns: Number(e.target.value) })}
              />
            </Field>
            <Field label="Token budget" hint="Prompt and completion tokens per run.">
              <input
                aria-label="Token budget"
                type="number"
                min={1000}
                max={50_000_000}
                step={1000}
                value={value.tokenBudget ?? effortPresets[effort].tokenBudget}
                onChange={(e) => onChange({ tokenBudget: Number(e.target.value) })}
              />
            </Field>
            <Field label="Time limit (seconds)">
              <input
                aria-label="Agent time limit"
                type="number"
                min={10}
                max={900}
                value={value.timeoutSeconds ?? 300}
                onChange={(e) => onChange({ timeoutSeconds: Number(e.target.value) })}
              />
            </Field>
          </div>
        )}
      </details>
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
