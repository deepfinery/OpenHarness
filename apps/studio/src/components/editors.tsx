import { useState } from 'react';
import { BookOpen, Check, KeyRound, Plug, Plus } from 'lucide-react';
import { api, send, type Data, type Entity } from '../api';
import { Button, Field, Modal, SaveForm } from './ui';

type Props = {
  value?: Entity;
  data: Data;
  onClose: () => void;
  onSaved: (created?: Entity) => Promise<void>;
};
export function AgentEditor({ value, data, onClose, onSaved }: Props) {
  const [form, set] = useState<any>(
    value ?? {
      name: '',
      description: '',
      systemPrompt:
        'You are a helpful, precise assistant. Use your connected tools when needed. Explain what you found and cite your knowledge sources.',
      providerId: data.providers[0]?.id ?? '',
      connections: [],
      knowledgeBaseIds: [],
      maxTurns: 12,
      timeoutSeconds: 300,
      enabled: true,
    },
  );
  const update = (key: string, v: unknown) => set((f: any) => ({ ...f, [key]: v }));
  function toggleTool(connectionId: string, tool: string) {
    const bindings = [...form.connections];
    const index = bindings.findIndex((b: any) => b.connectionId === connectionId);
    const binding = index >= 0 ? bindings[index] : { connectionId, tools: [] };
    const tools = binding.tools.includes(tool)
      ? binding.tools.filter((t: string) => t !== tool)
      : [...binding.tools, tool];
    if (index >= 0) bindings[index] = { connectionId, tools };
    else bindings.push({ connectionId, tools });
    update(
      'connections',
      bindings.filter((b) => b.tools.length),
    );
  }
  return (
    <Modal title={value ? 'Edit agent' : 'Create an agent'} onClose={onClose} wide>
      <SaveForm
        onCancel={onClose}
        label={value ? 'Save agent' : 'Create agent'}
        onSave={async () => {
          const created = await send(`/agents${value ? `/${value.id}` : ''}`, form, value ? 'PUT' : 'POST');
          await onSaved(created);
          onClose();
        }}
      >
        <div className="two-columns">
          <Field label="Agent name">
            <input
              aria-label="Agent name"
              required
              maxLength={100}
              placeholder="Research assistant"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
            />
          </Field>
          <Field label="Model provider">
            <select
              aria-label="Agent model provider"
              required
              value={form.providerId}
              onChange={(e) => update('providerId', e.target.value)}
            >
              <option value="" disabled>
                Choose a model provider
              </option>
              {data.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <>
          {!data.providers.length && (
            <div className="notice">Add a model provider in Settings before creating your first agent.</div>
          )}
        </>
        <Field label="Description">
          <input
            aria-label="Agent description"
            placeholder="What does this agent do?"
            value={form.description}
            onChange={(e) => update('description', e.target.value)}
          />
        </Field>
        <Field label="Instructions" hint="Define the agent’s purpose, constraints, and expected output.">
          <textarea
            aria-label="Agent instructions"
            className="prompt-input"
            rows={7}
            required
            value={form.systemPrompt}
            onChange={(e) => update('systemPrompt', e.target.value)}
          />
        </Field>
        <div className="form-section">
          <h3>
            <Plug size={17} /> MCP tools
          </h3>
          <p>Select the exact tools this agent may call. You can use several MCP servers.</p>
          {!data.connections.length && (
            <div className="inline-empty">Add an MCP server in Connections, then discover its tools.</div>
          )}
          {data.connections.map((c) => (
            <details
              className="tool-group"
              key={c.id}
              open={form.connections.some((b: any) => b.connectionId === c.id)}
            >
              <summary>
                {c.name}
                <span>{c.tools?.length ?? 0} tools</span>
              </summary>
              <div>
                {!c.tools?.length && <p>Discover tools on the Connections page first.</p>}
                {c.tools?.map((t: any) => (
                  <label className="check-row" key={t.name}>
                    <input
                      type="checkbox"
                      checked={form.connections.some(
                        (b: any) => b.connectionId === c.id && b.tools.includes(t.name),
                      )}
                      onChange={() => toggleTool(c.id, t.name)}
                    />
                    <span>
                      <strong>{t.name}</strong>
                      <small>{t.description?.slice(0, 200)}</small>
                    </span>
                  </label>
                ))}
              </div>
            </details>
          ))}
        </div>
        <div className="form-section">
          <h3>
            <BookOpen size={17} /> Knowledge
          </h3>
          <p>Retrieve relevant passages before the agent starts reasoning.</p>
          {!data.knowledge.length && (
            <div className="inline-empty">Create a knowledge base to give this agent source material.</div>
          )}
          {data.knowledge.map((k) => (
            <label className="check-row" key={k.id}>
              <input
                type="checkbox"
                checked={form.knowledgeBaseIds.includes(k.id)}
                onChange={() =>
                  update(
                    'knowledgeBaseIds',
                    form.knowledgeBaseIds.includes(k.id)
                      ? form.knowledgeBaseIds.filter((id: string) => id !== k.id)
                      : [...form.knowledgeBaseIds, k.id],
                  )
                }
              />
              <span>{k.name}</span>
            </label>
          ))}
        </div>
        <div className="two-columns">
          <Field label="Maximum turns">
            <input
              aria-label="Maximum turns"
              type="number"
              min={1}
              max={40}
              value={form.maxTurns}
              onChange={(e) => update('maxTurns', Number(e.target.value))}
            />
          </Field>
          <Field label="Time limit (seconds)">
            <input
              aria-label="Agent time limit"
              type="number"
              min={10}
              max={900}
              value={form.timeoutSeconds}
              onChange={(e) => update('timeoutSeconds', Number(e.target.value))}
            />
          </Field>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => update('enabled', e.target.checked)}
          />
          Agent enabled
        </label>
      </SaveForm>
    </Modal>
  );
}
const providerDefaults: Record<string, { baseUrl: string; hint: string }> = {
  'openai-compatible': {
    baseUrl: 'https://api.openai.com/v1',
    hint: 'OpenAI, vLLM, LM Studio, DeepSeek, Mistral, and compatible endpoints. Include /v1 when required.',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    hint: 'Use the Anthropic Messages API base URL, including /v1.',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    hint: 'Use a Gemini API key. This does not enable Google login.',
  },
  ollama: {
    baseUrl: 'http://host.docker.internal:11434',
    hint: 'Use your local Ollama server. Pull the chat and embedding models before running them.',
  },
};
export function ProviderEditor({ value, onClose, onSaved }: Props) {
  const [form, set] = useState<any>(
    value
      ? { ...value, apiKey: undefined }
      : {
          name: '',
          kind: 'openai-compatible',
          baseUrl: providerDefaults['openai-compatible'].baseUrl,
          model: '',
          embeddingModel: '',
          maxOutputTokens: 4096,
        },
  );
  const update = (key: string, v: unknown) => set((f: any) => ({ ...f, [key]: v }));
  return (
    <Modal title={value ? 'Edit model provider' : 'Add a model provider'} onClose={onClose}>
      <SaveForm
        onCancel={onClose}
        label="Save provider"
        onSave={async () => {
          const created = await send(
            `/providers${value ? `/${value.id}` : ''}`,
            form,
            value ? 'PUT' : 'POST',
          );
          await onSaved(created);
          onClose();
        }}
      >
        <Field label="Name">
          <input
            aria-label="Provider name"
            placeholder="My local models"
            required
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
          />
        </Field>
        <Field label="Provider type" hint={providerDefaults[form.kind].hint}>
          <select
            aria-label="Provider type"
            value={form.kind}
            onChange={(e) =>
              set({ ...form, kind: e.target.value, baseUrl: providerDefaults[e.target.value].baseUrl })
            }
          >
            <option value="openai-compatible">OpenAI compatible</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Google Gemini</option>
            <option value="ollama">Ollama (local)</option>
          </select>
        </Field>
        <Field label="API base URL">
          <input
            aria-label="Provider base URL"
            type="url"
            required
            value={form.baseUrl}
            onChange={(e) => update('baseUrl', e.target.value)}
          />
        </Field>
        <Field
          label="API key"
          hint={
            value?.hasApiKey
              ? 'A key is saved. Leave this field untouched to keep it.'
              : 'Optional for local endpoints; stored encrypted on the server.'
          }
        >
          <input
            aria-label="Provider API key"
            type="password"
            autoComplete="new-password"
            placeholder={value?.hasApiKey ? '•••••••• (saved)' : 'Provider API key'}
            value={form.apiKey ?? ''}
            onChange={(e) => update('apiKey', e.target.value)}
          />
        </Field>
        <Field label="Chat model" hint="Enter the exact model ID offered by your provider.">
          <input
            aria-label="Chat model"
            required
            placeholder="Model ID"
            value={form.model}
            onChange={(e) => update('model', e.target.value)}
          />
        </Field>
        {form.kind === 'openai-compatible' && (
          <Field
            label="Output budget field"
            hint="Most compatible endpoints use max_tokens. Some reasoning models require max_completion_tokens."
          >
            <select
              aria-label="Output token parameter"
              value={form.outputTokenParameter ?? 'max_tokens'}
              onChange={(e) => update('outputTokenParameter', e.target.value)}
            >
              <option value="max_tokens">Standard · max_tokens</option>
              <option value="max_completion_tokens">Reasoning models · max_completion_tokens</option>
            </select>
          </Field>
        )}
        {form.kind !== 'anthropic' && (
          <Field
            label="Embedding model (optional)"
            hint="Required when this provider is used by a knowledge base."
          >
            <input
              aria-label="Embedding model"
              placeholder="Embedding model ID"
              value={form.embeddingModel}
              onChange={(e) => update('embeddingModel', e.target.value)}
            />
          </Field>
        )}
        <Field label="Maximum output tokens">
          <input
            aria-label="Maximum output tokens"
            type="number"
            min={128}
            max={32768}
            value={form.maxOutputTokens}
            onChange={(e) => update('maxOutputTokens', Number(e.target.value))}
          />
        </Field>
      </SaveForm>
    </Modal>
  );
}
export function ConnectionEditor({ value, onClose, onSaved }: Props) {
  const [form, set] = useState<any>(
    value
      ? { ...value, token: undefined, oauthClientSecret: undefined }
      : {
          name: '',
          url: '',
          transport: 'http',
          authType: 'none',
          tokenHeader: 'Authorization',
          oauthScope: '',
          enabled: true,
        },
  );
  const update = (key: string, v: unknown) => set((f: any) => ({ ...f, [key]: v }));
  return (
    <Modal title={value ? 'Edit MCP connection' : 'Connect an MCP server'} onClose={onClose}>
      <SaveForm
        onCancel={onClose}
        label="Save connection"
        onSave={async () => {
          const created = await send(
            `/connections${value ? `/${value.id}` : ''}`,
            form,
            value ? 'PUT' : 'POST',
          );
          await onSaved(created);
          onClose();
        }}
      >
        <div className="notice">
          <Plug size={18} />
          <span>One connector. Any tool exposed by an MCP server.</span>
        </div>
        <Field label="Connection name">
          <input
            aria-label="Connection name"
            placeholder="My MCP server"
            required
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
          />
        </Field>
        <Field label="Server URL">
          <input
            aria-label="MCP server URL"
            placeholder="https://your-server.example/mcp"
            type="url"
            required
            value={form.url}
            onChange={(e) => update('url', e.target.value)}
          />
        </Field>
        <div className="two-columns">
          <Field label="Transport">
            <select
              aria-label="MCP transport"
              value={form.transport}
              onChange={(e) => update('transport', e.target.value)}
            >
              <option value="http">Streamable HTTP</option>
              <option value="sse">Legacy SSE</option>
            </select>
          </Field>
          <Field label="Authentication">
            <select
              aria-label="MCP authentication"
              value={form.authType}
              onChange={(e) => update('authType', e.target.value)}
            >
              <option value="none">No authentication</option>
              <option value="token">Access token / API key</option>
              <option value="oauth">OAuth 2.0 + PKCE</option>
            </select>
          </Field>
        </div>
        {form.authType === 'token' && (
          <>
            <Field label="Token header">
              <input
                aria-label="Token header"
                list="token-headers"
                value={form.tokenHeader}
                onChange={(e) => update('tokenHeader', e.target.value)}
              />
              <datalist id="token-headers">
                <option value="Authorization" />
                <option value="X-API-Key" />
                <option value="api-key" />
              </datalist>
            </Field>
            <Field
              label="Access token"
              hint={
                value?.hasToken
                  ? 'Leave untouched to keep the saved token.'
                  : 'Stored encrypted. It is never returned to the browser.'
              }
            >
              <input
                aria-label="MCP access token"
                type="password"
                autoComplete="new-password"
                value={form.token ?? ''}
                placeholder={value?.hasToken ? '•••••••• (saved)' : 'Access token'}
                onChange={(e) => update('token', e.target.value)}
              />
            </Field>
          </>
        )}
        {form.authType === 'oauth' && (
          <>
            <div className="notice">
              Save the connection, then select Authorize. Metadata discovery and dynamic client registration
              are used when supported.
            </div>
            <Field label="Client ID (optional)">
              <input
                aria-label="OAuth client ID"
                value={form.oauthClientId ?? ''}
                onChange={(e) => update('oauthClientId', e.target.value || undefined)}
              />
            </Field>
            <Field label="Client secret (optional)">
              <input
                aria-label="OAuth client secret"
                type="password"
                autoComplete="new-password"
                placeholder={value?.hasClientSecret ? '•••••••• (saved)' : ''}
                value={form.oauthClientSecret ?? ''}
                onChange={(e) => update('oauthClientSecret', e.target.value)}
              />
            </Field>
            <Field label="Scopes (optional)">
              <input
                aria-label="OAuth scopes"
                placeholder="Space-separated scopes"
                value={form.oauthScope}
                onChange={(e) => update('oauthScope', e.target.value)}
              />
            </Field>
          </>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => update('enabled', e.target.checked)}
          />
          Connection enabled
        </label>
      </SaveForm>
    </Modal>
  );
}
export function KnowledgeEditor({ value, data, onClose, onSaved }: Props) {
  const providers = data.providers.filter((p) => p.embeddingModel && p.kind !== 'anthropic');
  const [form, set] = useState<any>(
    value ?? { name: '', description: '', providerId: providers[0]?.id ?? '' },
  );
  return (
    <Modal title={value ? 'Edit knowledge base' : 'Create a knowledge base'} onClose={onClose}>
      <SaveForm
        onCancel={onClose}
        label="Save knowledge base"
        onSave={async () => {
          const created = await send(
            `/knowledge${value ? `/${value.id}` : ''}`,
            form,
            value ? 'PUT' : 'POST',
          );
          await onSaved(created);
          onClose();
        }}
      >
        <Field label="Name">
          <input
            aria-label="Knowledge base name"
            required
            placeholder="Team handbook"
            value={form.name}
            onChange={(e) => set({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Description">
          <textarea
            aria-label="Knowledge base description"
            rows={3}
            value={form.description}
            onChange={(e) => set({ ...form, description: e.target.value })}
          />
        </Field>
        <Field label="Embedding provider" hint="The same embedding model is used for indexing and retrieval.">
          <select
            aria-label="Embedding provider"
            required
            value={form.providerId}
            onChange={(e) => set({ ...form, providerId: e.target.value })}
          >
            <option value="" disabled>
              Select an embedding provider
            </option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.embeddingModel}
              </option>
            ))}
          </select>
        </Field>
        {!providers.length && (
          <div className="notice">Add an embedding model to a provider in Settings first.</div>
        )}
      </SaveForm>
    </Modal>
  );
}
