import { useEffect, useState } from 'react';
import { KeyRound, Plug, Trash2 } from 'lucide-react';
import { api, errorMessage, send, timestamp, type Data } from '../api';
import { Button, ErrorNotice, Field, IconButton } from './ui';

type Secret = {
  name: string;
  source?: { connectionId: string; connectionName: string; queryParam?: string };
  updatedAt: string;
};

/** Settings → Python secrets: keys that Python steps and agents can be given as environment variables. */
export function PythonSecretsPanel({ data, isAdmin }: { data: Data; isAdmin: boolean }) {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [mode, setMode] = useState<'value' | 'connection'>('connection');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [queryParam, setQueryParam] = useState('apikey');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const connections = data.connections.filter((c) => c.kind !== 'device');
  const load = () =>
    api<Secret[]>('/executor/secrets')
      .then(setSecrets)
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);
  async function save() {
    setBusy(true);
    setError('');
    try {
      await send(
        `/executor/secrets/${encodeURIComponent(name.trim())}`,
        mode === 'value'
          ? { value }
          : { connectionId, ...(queryParam.trim() ? { queryParam: queryParam.trim() } : {}) },
        'PUT',
      );
      setName('');
      setValue('');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-card">
      <h2>Python secrets</h2>
      <p className="field-help">
        API keys and passwords that Python code needs, for example <code>FMP_API_KEY</code>. A Python step or
        an agent that runs Python gets only the secrets it lists, as environment variables (
        <code>os.environ["FMP_API_KEY"]</code>
        ). Values are stored encrypted and are never shown again. Copy a key that an MCP connection already
        holds instead of typing it.
      </p>
      <ErrorNotice error={error} />
      {secrets.length ? (
        <ul className="mongo-indexes" aria-label="Python secrets">
          {secrets.map((s) => (
            <li key={s.name}>
              <span>
                <strong>{s.name}</strong>
                <small>
                  {s.source
                    ? `From ${s.source.connectionName}${s.source.queryParam ? ` (${s.source.queryParam})` : ' (token)'}`
                    : 'Entered value'}{' '}
                  · updated {timestamp(s.updatedAt)}
                </small>
              </span>
              {isAdmin && (
                <IconButton
                  title={`Delete ${s.name}`}
                  onClick={() => {
                    if (
                      confirm(
                        `Delete the secret ${s.name}? Steps and agents that list it will fail until it is added again.`,
                      )
                    )
                      void api(`/executor/secrets/${encodeURIComponent(s.name)}`, { method: 'DELETE' })
                        .then(load)
                        .catch((e) => setError(errorMessage(e)));
                  }}
                >
                  <Trash2 size={14} />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-help">No secrets yet.</p>
      )}
      {isAdmin && (
        <form
          className="form-content"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="two-columns">
            <Field label="Name" hint="Upper-case letters, digits and _.">
              <input
                aria-label="Secret name"
                placeholder="FMP_API_KEY"
                required
                pattern="[A-Z][A-Z0-9_]{0,63}"
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Source">
              <select
                aria-label="Secret source"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'value' | 'connection')}
              >
                <option value="connection">Copy from an MCP connection</option>
                <option value="value">Enter a value</option>
              </select>
            </Field>
          </div>
          {mode === 'value' ? (
            <Field label="Value">
              <input
                aria-label="Secret value"
                type="password"
                autoComplete="new-password"
                required
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          ) : (
            <div className="two-columns">
              <Field label="MCP connection">
                <select
                  aria-label="Secret connection"
                  required
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                >
                  <option value="">Choose a connection</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="URL parameter"
                hint="The query parameter holding the key; empty uses the connection's access token."
              >
                <input
                  aria-label="Secret URL parameter"
                  placeholder="apikey"
                  value={queryParam}
                  onChange={(e) => setQueryParam(e.target.value)}
                />
              </Field>
            </div>
          )}
          <Button disabled={busy || !name.trim()}>
            {mode === 'value' ? <KeyRound size={14} /> : <Plug size={14} />}
            Save secret
          </Button>
        </form>
      )}
    </div>
  );
}
/** Comma-separated secret names, for step and agent settings. */
export const secretList = (text: string) => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ),
];
