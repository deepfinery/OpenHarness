import { useEffect, useState } from 'react';
import { BookOpen, Check, Cpu, KeyRound, LoaderCircle, Plug, Plus, Sparkles, X } from 'lucide-react';
import { api, errorMessage, send, type Data, type Entity } from '../api';
import { Button, CopyButton, ErrorNotice, Field, Modal, SaveForm } from './ui';
import { patternDescriptions } from '../../../../packages/core/src/patterns.js';
import { agentPatterns, type AgentPattern } from '../../../../packages/core/src/schema.js';

type Props = {
  value?: Entity;
  data: Data;
  onClose: () => void;
  onSaved: (created?: Entity) => Promise<void>;
};
const defaultPatternConfig = { reflections: 1, iterations: 3, doneMarker: 'DONE', maxPlanSteps: 5 };

export function PatternFields({
  pattern,
  config,
  onPattern,
  onConfig,
}: {
  pattern: AgentPattern;
  config: Record<string, any>;
  onPattern: (p: AgentPattern) => void;
  onConfig: (c: Record<string, any>) => void;
}) {
  const merged = { ...defaultPatternConfig, ...config };
  return (
    <div className="pattern-picker">
      <div className="pattern-options" role="radiogroup" aria-label="Agentic pattern">
        {agentPatterns.map((p) => (
          <button
            type="button"
            key={p}
            role="radio"
            aria-checked={pattern === p}
            className={`pattern-option ${pattern === p ? 'selected' : ''}`}
            onClick={() => onPattern(p)}
          >
            <strong>{patternDescriptions[p].name}</strong>
            <span>{patternDescriptions[p].summary}</span>
          </button>
        ))}
      </div>
      <p className="field-help">{patternDescriptions[pattern].detail}</p>
      {pattern === 'plan-execute' && (
        <Field label="Maximum plan steps" hint="Each step runs with tools before the final synthesis.">
          <input
            aria-label="Maximum plan steps"
            type="number"
            min={1}
            max={8}
            value={merged.maxPlanSteps}
            onChange={(e) => onConfig({ ...merged, maxPlanSteps: Number(e.target.value) })}
          />
        </Field>
      )}
      {pattern === 'reflection' && (
        <Field label="Critique rounds" hint="Each round critiques the draft and revises it.">
          <input
            aria-label="Critique rounds"
            type="number"
            min={1}
            max={3}
            value={merged.reflections}
            onChange={(e) => onConfig({ ...merged, reflections: Number(e.target.value) })}
          />
        </Field>
      )}
      {pattern === 'loop' && (
        <div className="two-columns">
          <Field label="Maximum iterations">
            <input
              aria-label="Maximum iterations"
              type="number"
              min={1}
              max={10}
              value={merged.iterations}
              onChange={(e) => onConfig({ ...merged, iterations: Number(e.target.value) })}
            />
          </Field>
          <Field label="Done marker" hint="The agent ends its final message with this word.">
            <input
              aria-label="Done marker"
              value={merged.doneMarker}
              maxLength={50}
              onChange={(e) => onConfig({ ...merged, doneMarker: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

type Preset = {
  id: string;
  kind: 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama';
  name: string;
  baseUrl: string;
  hint: string;
  chatModels: string[];
  embeddingModels: string[];
  keyHint: string;
};
const presets: Preset[] = [
  {
    id: 'openai',
    kind: 'openai-compatible',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    hint: 'Chat and embeddings from one key.',
    chatModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
    keyHint: 'Create a key at platform.openai.com. It is stored encrypted.',
  },
  {
    id: 'anthropic',
    kind: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    hint: 'Claude models for chat and tools. No embeddings: pair with another provider for knowledge.',
    chatModels: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'],
    embeddingModels: [],
    keyHint: 'Create a key in the Anthropic console. It is stored encrypted.',
  },
  {
    id: 'gemini',
    kind: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    hint: 'Gemini chat models and embeddings with an API key. This does not enable Google login.',
    chatModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    embeddingModels: ['gemini-embedding-001', 'text-embedding-004'],
    keyHint: 'Create a key in Google AI Studio. It is stored encrypted.',
  },
  {
    id: 'ollama',
    kind: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://host.docker.internal:11434',
    hint: 'Models running on your own machine or server. Pull the models before using them.',
    chatModels: ['llama3.1', 'qwen2.5', 'mistral', 'gemma3'],
    embeddingModels: ['nomic-embed-text', 'mxbai-embed-large', 'bge-m3'],
    keyHint: 'Usually no key. Add one only if your Ollama server is behind an authenticating proxy.',
  },
  {
    id: 'compatible',
    kind: 'openai-compatible',
    name: 'Other OpenAI-compatible',
    baseUrl: 'https://your-endpoint.example/v1',
    hint: 'vLLM, LM Studio, Azure OpenAI, DeepSeek, Mistral, Groq, OpenRouter and similar servers.',
    chatModels: [],
    embeddingModels: [],
    keyHint: 'Use the key your service issues. Include /v1 in the base URL when the service requires it.',
  },
];
export function ProviderEditor({ value, onClose, onSaved }: Props) {
  const presetFor = (v?: Entity) =>
    v
      ? (presets.find((p) => p.kind === v.kind && p.baseUrl === v.baseUrl) ??
        presets.find((p) => p.kind === v.kind && p.id !== 'openai' && p.id !== 'compatible') ??
        presets.find((p) => p.kind === v.kind)!)
      : presets[0];
  const [preset, setPreset] = useState<Preset>(presetFor(value));
  const [form, set] = useState<any>(
    value
      ? { ...value, apiKey: undefined }
      : {
          name: presets[0].name,
          kind: presets[0].kind,
          baseUrl: presets[0].baseUrl,
          model: presets[0].chatModels[0] ?? '',
          embeddingModel: presets[0].embeddingModels[0] ?? '',
          maxOutputTokens: 4096,
          contextWindow: 128000,
          outputTokenParameter: 'max_tokens',
          streaming: true,
        },
  );
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState('');
  const update = (key: string, v: unknown) => set((f: any) => ({ ...f, [key]: v }));
  function choose(p: Preset) {
    setPreset(p);
    setTest(null);
    set((f: any) => ({
      ...f,
      kind: p.kind,
      baseUrl: p.baseUrl,
      name: !value && (!f.name || presets.some((x) => x.name === f.name)) ? p.name : f.name,
      model: p.chatModels[0] ?? '',
      embeddingModel: p.kind === 'anthropic' ? '' : (p.embeddingModels[0] ?? ''),
    }));
  }
  async function runTest() {
    setTesting(true);
    setTestError('');
    setTest(null);
    try {
      const { hasApiKey, id, createdAt, updatedAt, revision, createdBy, updatedBy, ...body } = form;
      setTest(await send('/providers/test-config', { ...body, providerId: value?.id }));
    } catch (e) {
      setTestError(errorMessage(e));
    } finally {
      setTesting(false);
    }
  }
  return (
    <Modal title={value ? 'Edit model provider' : 'Add a model provider'} onClose={onClose} wide>
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
        <div className="form-section first">
          <h3>
            <Cpu size={17} /> Provider
          </h3>
          <div className="preset-grid" role="radiogroup" aria-label="Provider">
            {presets.map((p) => (
              <button
                type="button"
                key={p.id}
                role="radio"
                aria-checked={preset.id === p.id}
                className={`preset-card ${preset.id === p.id ? 'selected' : ''}`}
                onClick={() => choose(p)}
              >
                <strong>{p.name}</strong>
                <span>{p.hint}</span>
              </button>
            ))}
          </div>
          <div className="two-columns">
            <Field label="Provider name">
              <input
                aria-label="Provider name"
                placeholder={preset.name}
                required
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
              />
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
          </div>
          <Field
            label="API key"
            hint={
              value?.hasApiKey ? 'A key is saved. Leave this field untouched to keep it.' : preset.keyHint
            }
          >
            <input
              aria-label="Provider API key"
              type="password"
              autoComplete="new-password"
              placeholder={
                value?.hasApiKey
                  ? '•••••••• (saved)'
                  : preset.kind === 'ollama'
                    ? 'Optional'
                    : 'Paste your API key'
              }
              value={form.apiKey ?? ''}
              onChange={(e) => update('apiKey', e.target.value)}
            />
          </Field>
        </div>
        <div className="form-section">
          <h3>
            <Sparkles size={17} /> Chat model
          </h3>
          <Field label="Model ID" hint="Any model your provider offers.">
            <input
              aria-label="Chat model"
              required
              list="chat-model-suggestions"
              placeholder="Model ID"
              value={form.model}
              onChange={(e) => update('model', e.target.value)}
            />
          </Field>
          <datalist id="chat-model-suggestions">
            {preset.chatModels.map((m) => (
              <option value={m} key={m} />
            ))}
          </datalist>
        </div>
        <div className="form-section">
          <h3>
            <BookOpen size={17} /> Embedding model
          </h3>
          {preset.kind === 'anthropic' ? (
            <div className="notice">
              Anthropic has no embedding models. Knowledge bases use another provider for embeddings.
            </div>
          ) : (
            <>
              <Field
                label="Embedding model ID (optional)"
                hint="For knowledge bases. Fixed once one uses it."
              >
                <input
                  aria-label="Embedding model"
                  list="embedding-model-suggestions"
                  placeholder="Embedding model ID"
                  value={form.embeddingModel ?? ''}
                  onChange={(e) => update('embeddingModel', e.target.value)}
                />
              </Field>
              <datalist id="embedding-model-suggestions">
                {preset.embeddingModels.map((m) => (
                  <option value={m} key={m} />
                ))}
              </datalist>
            </>
          )}
        </div>
        <details className="advanced">
          <summary>Advanced</summary>
          <div className="two-columns">
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
            <Field
              label="Context window (tokens)"
              hint="Long conversations are trimmed to fit. Learned automatically from the provider's first limit error."
            >
              <input
                aria-label="Context window"
                type="number"
                min={2048}
                max={4000000}
                step={1024}
                value={form.contextWindow ?? 128000}
                onChange={(e) => update('contextWindow', Number(e.target.value))}
              />
            </Field>
            {form.kind === 'openai-compatible' && (
              <Field label="Output budget field" hint="Some reasoning models require max_completion_tokens.">
                <select
                  aria-label="Output token parameter"
                  value={form.outputTokenParameter ?? 'max_tokens'}
                  onChange={(e) => update('outputTokenParameter', e.target.value)}
                >
                  <option value="max_tokens">max_tokens</option>
                  <option value="max_completion_tokens">max_completion_tokens</option>
                </select>
              </Field>
            )}
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.streaming !== false}
              onChange={(e) => update('streaming', e.target.checked)}
            />
            <span>
              <strong>Stream answers</strong>
              <small>Turn off for servers that reject the stream flag.</small>
            </span>
          </label>
        </details>
        <div className="test-panel">
          <div className="row-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={testing || !form.model || !form.baseUrl}
              onClick={() => void runTest()}
            >
              {testing ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              Test connection
            </Button>
            <small className="field-help">Checks the models before you save.</small>
          </div>
          <ErrorNotice error={testError} />
          {test && (
            <div className="test-results">
              <div className={`test-result ${test.chat.ok ? 'ok' : 'bad'}`}>
                {test.chat.ok ? <Check size={14} /> : <X size={14} />}
                <span>
                  <strong>Chat model</strong>
                  <small>{test.chat.ok ? `Replied: “${test.chat.text}”` : test.chat.error}</small>
                </span>
              </div>
              {test.embedding && (
                <div className={`test-result ${test.embedding.ok ? 'ok' : 'bad'}`}>
                  {test.embedding.ok ? <Check size={14} /> : <X size={14} />}
                  <span>
                    <strong>Embedding model</strong>
                    <small>
                      {test.embedding.ok
                        ? `Vectors of ${test.embedding.dimensions} dimensions`
                        : test.embedding.error}
                    </small>
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
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
  const [publicUrl, setPublicUrl] = useState(location.origin);
  useEffect(() => {
    void api('/config')
      .then((c) => setPublicUrl(c.publicUrl))
      .catch(() => {});
  }, []);
  const update = (key: string, v: unknown) => set((f: any) => ({ ...f, [key]: v }));
  const callback = `${publicUrl.replace(/\/$/, '')}/api/mcp/oauth/callback`;
  return (
    <Modal title={value ? 'Edit MCP connection' : 'Connect an MCP server'} onClose={onClose} wide>
      <SaveForm
        onCancel={onClose}
        label={
          value
            ? 'Save connection'
            : form.authType === 'oauth'
              ? 'Save, then authorize'
              : 'Save and discover tools'
        }
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
          <span>
            Any remote MCP server: no auth, an API key, or OAuth. Tools are discovered after saving.
          </span>
        </div>
        <Field label="Connection name">
          <input
            aria-label="Connection name"
            placeholder="Finnhub, GitHub, internal tools…"
            required
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
          />
        </Field>
        <Field label="Server URL" hint="For example https://mcp.example.com/mcp.">
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
              <option value="oauth">OAuth 2.0 (sign in with the provider)</option>
            </select>
          </Field>
        </div>
        {form.authType === 'token' && (
          <>
            <Field
              label="Token header"
              hint="Authorization sends “Bearer <token>”. Other headers send the raw value."
            >
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
          <div className="oauth-guide">
            <ol>
              <li>
                Save, then click <strong>Authorize</strong> and sign in with the provider.
              </li>
              <li>If the provider asks for a redirect URL, use the callback below.</li>
              <li>
                Providers with a fixed client ID (for example Finnhub): enter it, leave the secret empty.
              </li>
            </ol>
            <div className="callback-row">
              <span>
                <small className="eyebrow">Callback URL</small>
                <code>{callback}</code>
              </span>
              <CopyButton value={callback} />
            </div>
            <div className="two-columns">
              <Field label="Client ID (optional)">
                <input
                  aria-label="OAuth client ID"
                  placeholder="Provided by the MCP server, if any"
                  value={form.oauthClientId ?? ''}
                  onChange={(e) => update('oauthClientId', e.target.value || undefined)}
                />
              </Field>
              <Field label="Client secret (optional)">
                <input
                  aria-label="OAuth client secret"
                  type="password"
                  autoComplete="new-password"
                  placeholder={value?.hasClientSecret ? '•••••••• (saved)' : 'Usually empty'}
                  value={form.oauthClientSecret ?? ''}
                  onChange={(e) => update('oauthClientSecret', e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Scopes (optional)"
              hint="Space-separated. Leave empty to accept the server’s defaults."
            >
              <input
                aria-label="OAuth scopes"
                placeholder="read write"
                value={form.oauthScope}
                onChange={(e) => update('oauthScope', e.target.value)}
              />
            </Field>
            <div className="notice">
              <KeyRound size={16} />
              <span>Tokens are stored encrypted and refreshed automatically.</span>
            </div>
          </div>
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
  const [addingProvider, setAddingProvider] = useState(false);
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
            placeholder="What is in here?"
            value={form.description}
            onChange={(e) => set({ ...form, description: e.target.value })}
          />
        </Field>
        <Field label="Embedding provider" hint="Fixed for the life of the knowledge base.">
          <select
            aria-label="Embedding provider"
            required
            disabled={Boolean(value)}
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
          <div className="notice">
            <span>No provider has an embedding model yet. Add one (OpenAI, Gemini or Ollama) first.</span>
          </div>
        )}
        {!value && (
          <button type="button" className="text-button" onClick={() => setAddingProvider(true)}>
            <Plus size={14} /> Add a provider with an embedding model
          </button>
        )}
      </SaveForm>
      {addingProvider && (
        <ProviderEditor
          data={data}
          onClose={() => setAddingProvider(false)}
          onSaved={async (p) => {
            await onSaved();
            if (p?.embeddingModel) set((f: any) => ({ ...f, providerId: p.id }));
          }}
        />
      )}
    </Modal>
  );
}
