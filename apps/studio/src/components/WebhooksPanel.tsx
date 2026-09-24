import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, errorMessage, send, timestamp, type Data, type Entity } from '../api';
import { Button, CopyButton, ErrorNotice, Field, Modal, SaveForm } from './ui';
export function WebhooksPanel({ data }: { data: Data }) {
  const [hooks, setHooks] = useState<Entity[]>([]),
    [error, setError] = useState(''),
    [adding, setAdding] = useState(false),
    [secret, setSecret] = useState<any>(null);
  const targets = [
    ...data.workflows.map((w) => ({ ...w, type: 'workflow' })),
    ...data.agents.map((a) => ({ ...a, type: 'agent' })),
  ];
  const [form, setForm] = useState({
    name: '',
    target: targets[0] ? `${targets[0].type}:${targets[0].id}` : '',
    inputPath: 'input',
    expiresDays: 30,
  });
  async function load() {
    try {
      setHooks(await api('/integrations/webhooks'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <div className="section-toolbar">
        <div>
          <h2>Trigger a workflow from another application.</h2>
          <p>Authenticated webhooks accept JSON and submit a durable run to the same queue.</p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus size={16} />
          Create webhook
        </Button>
      </div>
      <ErrorNotice error={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Endpoint</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {hooks.map((h) => (
              <tr key={h.id}>
                <td>
                  <strong>{h.name}</strong>
                </td>
                <td>
                  <code>{h.url}</code>
                  <CopyButton value={h.url} />
                </td>
                <td>{timestamp(h.expiresAt)}</td>
                <td>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (!confirm(`Revoke webhook “${h.name}”?`)) return;
                      try {
                        await api(`/integrations/webhooks/${h.id}`, { method: 'DELETE' });
                        await load();
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    }}
                  >
                    <Trash2 size={14} />
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
            {!hooks.length && (
              <tr>
                <td colSpan={4} className="empty-table">
                  No webhooks yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="notice provider-note">
        <div>
          <strong>Send a JSON payload with the webhook secret.</strong>
          <p>
            Use <code>Authorization: Bearer …</code>. Choose a JSON field for the workflow input, or leave it
            blank to pass the whole payload. Steps can also reference <code>{'{{payload.field}}'}</code>. An{' '}
            <code>Idempotency-Key</code> prevents duplicate deliveries.
          </p>
          <p>
            The response includes a run ID. Poll <code>GET /api/hooks/:webhookId/runs/:runId</code> using the
            same secret to read the result.
          </p>
        </div>
      </div>
      {adding && (
        <Modal title="Create a webhook" onClose={() => setAdding(false)}>
          <SaveForm
            label="Create webhook"
            onCancel={() => setAdding(false)}
            onSave={async () => {
              const [type, id] = form.target.split(':');
              if (!id) throw new Error('Choose a target');
              const result = await send('/integrations/webhooks', {
                name: form.name,
                [type === 'agent' ? 'agentId' : 'workflowId']: id,
                inputPath: form.inputPath,
                expiresDays: form.expiresDays,
              });
              setSecret(result);
              setAdding(false);
              await load();
            }}
          >
            <Field label="Webhook name">
              <input
                aria-label="Webhook name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Target">
              <select
                aria-label="Webhook target"
                value={form.target}
                onChange={(e) => setForm({ ...form, target: e.target.value })}
              >
                <option value="">Choose a workflow or agent</option>
                {targets.map((t) => (
                  <option key={t.id} value={`${t.type}:${t.id}`}>
                    {t.name} · {t.type}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Input JSON field"
              hint="For example input, message, or event.text. Leave blank to use the whole JSON body."
            >
              <input
                aria-label="Webhook input field"
                value={form.inputPath}
                onChange={(e) => setForm({ ...form, inputPath: e.target.value })}
              />
            </Field>
            <Field label="Expires in days">
              <input
                type="number"
                min={1}
                max={365}
                value={form.expiresDays}
                onChange={(e) => setForm({ ...form, expiresDays: Number(e.target.value) })}
              />
            </Field>
          </SaveForm>
        </Modal>
      )}
      {secret && (
        <Modal title="Webhook ready" onClose={() => setSecret(null)}>
          <div className="form-content">
            <p>Copy the secret now. It will not be shown again.</p>
            <Field label="Endpoint">
              <code>{secret.url}</code>
              <CopyButton value={secret.url} />
            </Field>
            <Field label="Webhook secret">
              <pre className="secret-value">{secret.secret}</pre>
              <CopyButton value={secret.secret} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
