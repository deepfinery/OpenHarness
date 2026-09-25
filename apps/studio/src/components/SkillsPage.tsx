import { useState } from 'react';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { api, send, type Data, type Entity } from '../api';
import { Button, Empty, Field, IconButton, Modal, PageTitle, SaveForm } from './ui';

type PageProps = {
  data: Data;
  refresh: () => Promise<void>;
  act: (task: () => Promise<unknown>) => Promise<void>;
};
const example = {
  name: 'Incident triage',
  description: 'Use when someone reports an outage, error spike or failing service.',
  instructions:
    '1. Ask for (or look up) the affected service, start time and symptoms.\n2. Check recent deploys and error logs before guessing.\n3. Classify severity: SEV1 customer-facing outage, SEV2 degraded, SEV3 internal.\n4. Answer with: summary, likely cause, evidence, next action, owner.',
};

/** Edits one skill. `onSaved` receives the saved skill so callers (like an agent form) can attach it right away. */
export function SkillEditor({
  value,
  onClose,
  onSaved,
}: {
  value?: Entity;
  onClose: () => void;
  onSaved: (skill: Entity) => Promise<void> | void;
}) {
  const [form, set] = useState({
    name: value?.name ?? '',
    description: value?.description ?? '',
    instructions: value?.instructions ?? '',
    enabled: value?.enabled ?? true,
  });
  return (
    <Modal title={value ? 'Edit skill' : 'New skill'} onClose={onClose} wide>
      <SaveForm
        label="Save skill"
        onCancel={onClose}
        onSave={async () => {
          const saved = await send(`/skills${value ? `/${value.id}` : ''}`, form, value ? 'PUT' : 'POST');
          await onSaved(saved);
          onClose();
        }}
      >
        <Field label="Name">
          <input
            aria-label="Skill name"
            required
            maxLength={64}
            placeholder={example.name}
            value={form.name}
            onChange={(e) => set({ ...form, name: e.target.value })}
          />
        </Field>
        <Field
          label="When to use it"
          hint="The agent sees only this line until it decides the skill applies. Be specific."
        >
          <input
            aria-label="Skill description"
            required
            maxLength={500}
            placeholder={example.description}
            value={form.description}
            onChange={(e) => set({ ...form, description: e.target.value })}
          />
        </Field>
        <Field
          label="Instructions"
          hint="Loaded and followed when the skill applies. Steps, checklists, formats, examples."
        >
          <textarea
            aria-label="Skill instructions"
            className="prompt-input"
            required
            rows={10}
            placeholder={example.instructions}
            value={form.instructions}
            onChange={(e) => set({ ...form, instructions: e.target.value })}
          />
        </Field>
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set({ ...form, enabled: e.target.checked })}
          />
          Skill enabled
        </label>
      </SaveForm>
    </Modal>
  );
}

export function SkillsPage({ data, refresh, act }: PageProps) {
  const [editing, setEditing] = useState<Entity | 'new' | null>(null);
  const usage = (id: string) =>
    data.workflows.filter((w) => w.nodes?.some((n: any) => n.config?.skillIds?.includes(id))).length +
    data.agents.filter((a) => a.skillIds?.includes(id)).length;
  return (
    <>
      <PageTitle
        title="Skills"
        action={
          <Button onClick={() => setEditing('new')}>
            <Plus size={17} />
            New skill
          </Button>
        }
      />
      {!data.skills.length ? (
        <Empty
          icon={<Sparkles size={30} />}
          title="No skills yet"
          text="A skill is a named set of instructions with a one-line “when to use it”. Give an agent several; it loads the right one when a request matches."
          action={
            <Button onClick={() => setEditing('new')}>
              <Plus size={16} />
              New skill
            </Button>
          }
        />
      ) : (
        <div className="card-grid">
          {data.skills.map((s) => (
            <article className="resource-card skill-card" key={s.id}>
              <div className="card-top">
                <div className="resource-icon">
                  <Sparkles size={22} />
                </div>
                <span className={`status ${s.enabled ? 'ready' : 'disabled'}`}>
                  <i />
                  {s.enabled ? 'enabled' : 'disabled'}
                </span>
                <IconButton
                  title={`Delete ${s.name}`}
                  onClick={() => {
                    if (confirm(`Delete skill “${s.name}”?`))
                      void act(async () => {
                        await api(`/skills/${s.id}`, { method: 'DELETE' });
                        await refresh();
                      });
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
              <button className="card-name" onClick={() => setEditing(s)}>
                {s.name}
              </button>
              <p>{s.description}</p>
              <div className="card-footer">
                <small>
                  {usage(s.id)
                    ? `Used by ${usage(s.id)} agent${usage(s.id) === 1 ? '' : 's'}`
                    : 'Not used yet'}{' '}
                  · {s.instructions.length} chars
                </small>
                <Button variant="secondary" onClick={() => setEditing(s)}>
                  Edit
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing && (
        <SkillEditor
          value={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => refresh()}
        />
      )}
    </>
  );
}

/** Skill picker for an agent: tick library skills or create one in place. */
export function SkillPicker({
  data,
  refresh,
  value,
  onChange,
}: {
  data: Data;
  refresh: () => Promise<void>;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="form-section skill-picker">
      <h3>
        <Sparkles size={16} /> Skills
      </h3>
      <p className="field-help">
        The agent sees each skill’s “when to use it” line and loads the instructions only when a request
        matches.
      </p>
      {data.skills.map((s) => (
        <label className="tool-choice" key={s.id}>
          <input
            type="checkbox"
            aria-label={`Skill ${s.name}`}
            checked={value.includes(s.id)}
            disabled={!s.enabled && !value.includes(s.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((v) => v !== s.id))}
          />
          <span>
            <strong>
              {s.name}
              {!s.enabled && ' (disabled)'}
            </strong>
            <small>{s.description}</small>
          </span>
        </label>
      ))}
      {!data.skills.length && <p className="toolbox-empty">No skills in this workspace yet.</p>}
      <button type="button" className="text-button" onClick={() => setCreating(true)}>
        <Plus size={14} /> New skill
      </button>
      {creating && (
        <SkillEditor
          onClose={() => setCreating(false)}
          onSaved={async (skill) => {
            await refresh();
            onChange([...value, skill.id]);
          }}
        />
      )}
    </div>
  );
}
