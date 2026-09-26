import { useEffect, useRef, useState } from 'react';
import { Search, Download, Play, Square, ChevronDown, Copy } from 'lucide-react';
import { api, type Data } from '../api';
import { Button, Field } from './ui';
type Document = {
  servers: { url: string }[];
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
  'x-openharness-capabilities': Record<string, { supported: boolean; limitations: string[] }>;
};
function sample(schema: any, doc: Document, depth = 0): any {
  if (!schema || depth > 6) return undefined;
  if (schema.$ref) return sample(doc.components.schemas[schema.$ref.split('/').at(-1)], doc, depth + 1);
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf) return sample(schema.oneOf[0], doc, depth + 1);
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key]) => (schema.required ?? []).includes(key))
        .map(([key, value]) => [key, sample(value, doc, depth + 1)]),
    );
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 1;
  return '';
}
export function ApiExplorer({ data }: { data: Data }) {
  const [doc, setDoc] = useState<Document | null>(null),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [domain, setDomain] = useState('all'),
    [selected, setSelected] = useState('harnesses.list'),
    [legacyHarness, setLegacyHarness] = useState('openharness'),
    [harness, setHarness] = useState(data.workflows[0]?.id ?? ''),
    [params, setParams] = useState<Record<string, string>>({}),
    [body, setBody] = useState('{}'),
    [token, setToken] = useState(''),
    [response, setResponse] = useState(''),
    [status, setStatus] = useState(''),
    [running, setRunning] = useState(false),
    [uploads, setUploads] = useState<File[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let live = true;
    void api('/config')
      .then(async (c) => {
        if (live) setLegacyHarness(c.openHarness.harnessId);
        const r = await fetch(`${c.openHarness.basePath}/openapi.json`, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('API documentation unavailable');
        const d = await r.json();
        if (live) setDoc(d);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
      controller.current?.abort();
    };
  }, []);
  const endpoints = doc
    ? Object.entries(doc.paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
      )
    : [];
  const endpoint = endpoints.find((e) => e.operation.operationId === selected);
  const media = endpoint?.operation.requestBody?.content ?? {},
    mime = Object.keys(media)[0],
    schema = media[mime]?.schema;
  useEffect(() => {
    if (!doc || !endpoint) return;
    setParams({});
    setUploads([]);
    setResponse('');
    setStatus('');
    setError('');
    const initial = sample(schema, doc) ?? {};
    if (initial && typeof initial === 'object' && 'message' in initial) initial.message = 'Hello';
    if (initial && typeof initial === 'object' && 'content' in initial) initial.content = 'Hello';
    setBody(mime === 'application/octet-stream' ? '' : JSON.stringify(initial, null, 2));
    controller.current?.abort();
  }, [selected, doc]);
  if (!doc) return <div className="empty">{error || 'Loading API reference…'}</div>;
  const groups = [...new Set(endpoints.map((e) => e.operation.tags[0]))];
  const filtered = endpoints.filter(
    (e) =>
      (domain === 'all' || e.operation.tags[0] === domain) &&
      `${e.path} ${e.operation.summary} ${e.method}`.toLowerCase().includes(search.toLowerCase()),
  );
  function requestPath() {
    if (!endpoint) throw new Error('Choose an endpoint');
    let path = endpoint.path;
    const query = new URLSearchParams();
    for (const p of endpoint.operation.parameters ?? []) {
      const value = p.name === 'harnessId' ? harness : (params[p.name] ?? '');
      if (p.required && !value) throw new Error(`Enter ${p.name}`);
      if (p.in === 'path')
        path = path.replace(
          `{${p.name}}`,
          p.name === 'path' ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value),
        );
      else if (value) query.set(p.name, value);
    }
    return `${doc!.servers[0].url}${path}${query.size ? '?' + query : ''}`;
  }
  async function execute() {
    if (!endpoint) return;
    setError('');
    setResponse('');
    setStatus('');
    setRunning(true);
    const ctrl = new AbortController();
    controller.current = ctrl;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const path = requestPath();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      let payload: BodyInit | undefined;
      if (endpoint.method !== 'get' && endpoint.method !== 'delete') {
        if (mime === 'multipart/form-data') {
          const form = new FormData();
          const fields = JSON.parse(body);
          for (const [key, value] of Object.entries(fields))
            if (key !== 'files' && key !== 'file' && key !== 'snapshot' && key !== 'bundle')
              form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
          const fileField =
            selected === 'agents.import'
              ? 'bundle'
              : selected === 'memory.import'
                ? 'snapshot'
                : selected === 'files.upload'
                  ? 'file'
                  : 'files';
          for (const f of uploads) form.append(fileField, f, f.name);
          payload = form;
        } else {
          headers['Content-Type'] = mime ?? 'application/json';
          payload = mime === 'application/octet-stream' ? body : JSON.stringify(JSON.parse(body));
        }
      }
      timeout = setTimeout(() => ctrl.abort(), 120000);
      const start = performance.now();
      const r = await fetch(path, {
        method: endpoint.method.toUpperCase(),
        headers,
        body: payload,
        credentials: token ? 'omit' : 'same-origin',
        signal: ctrl.signal,
      });
      setStatus(`${r.status} ${r.statusText} · ${Math.round(performance.now() - start)} ms`);
      const type = r.headers.get('content-type') ?? '';
      if (type.includes('text/event-stream')) {
        const reader = r.body!.getReader(),
          decoder = new TextDecoder();
        let text = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          setResponse(text.slice(-200000));
          if (text.length > 2000000) {
            ctrl.abort();
            break;
          }
        }
      } else if (
        r.ok &&
        (r.headers.get('content-disposition')?.includes('attachment') ||
          type.includes('zip') ||
          type.includes('octet-stream'))
      ) {
        const blob = await r.blob(),
          url = URL.createObjectURL(blob),
          a = document.createElement('a');
        a.href = url;
        a.download =
          /filename="?([^";]+)/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setResponse(`Downloaded ${blob.size.toLocaleString()} bytes.`);
      } else {
        const text = await r.text();
        try {
          setResponse(JSON.stringify(JSON.parse(text), null, 2));
        } catch {
          setResponse(text || 'No response body');
        }
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.name === 'AbortError'
            ? 'Request stopped. Any execution already started remains available in Executions.'
            : e.message
          : 'Request failed',
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      setRunning(false);
      controller.current = null;
    }
  }
  async function copyCurl() {
    try {
      const path = requestPath();
      const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
      const lines = [
        `curl -X ${endpoint!.method.toUpperCase()} ${quote(location.origin + path)}`,
        "  -H 'Authorization: Bearer YOUR_OPEN_HARNESS_KEY'",
      ];
      if (mime === 'application/json')
        lines.push("  -H 'Content-Type: application/json'", `  --data ${quote(body)}`);
      else if (mime === 'application/octet-stream')
        lines.push("  -H 'Content-Type: application/octet-stream'", `  --data-binary ${quote(body)}`);
      else if (mime === 'multipart/form-data') {
        for (const [key, value] of Object.entries(JSON.parse(body)))
          if (!['files', 'file', 'bundle', 'snapshot'].includes(key))
            lines.push(
              `  --form-string ${quote(key + '=' + (typeof value === 'object' ? JSON.stringify(value) : String(value)))}`,
            );
        const field =
          selected === 'agents.import'
            ? 'bundle'
            : selected === 'memory.import'
              ? 'snapshot'
              : selected === 'files.upload'
                ? 'file'
                : 'files';
        for (const file of uploads) lines.push(`  -F ${quote(field + '=@' + file.name)}`);
      }
      await navigator.clipboard.writeText(lines.join(' \\\n'));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="api-explorer">
      <div className="api-explorer-intro">
        <div>
          <h2>Open Harness API</h2>
          <p>
            Browse the API, edit a request, and inspect its response. Requests act on your real workspace.
          </p>
        </div>
        <a href={`${doc.servers[0].url}/openapi.json`} target="_blank" rel="noreferrer">
          <Download size={16} /> OpenAPI JSON
        </a>
      </div>
      <div className="api-explorer-auth">
        <Field label="Harness">
          <select value={harness} onChange={(e) => setHarness(e.target.value)}>
            <option value="">Choose a harness</option>
            {data.workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
            <option value={legacyHarness}>Legacy workspace alias</option>
          </select>
        </Field>
        <Field label="API key (optional)">
          <input
            type="password"
            autoComplete="off"
            placeholder="Use your signed-in session, or paste a key"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      </div>
      <div className="api-explorer-layout">
        <aside>
          <label className="api-search">
            <Search size={16} />
            <input
              aria-label="Search API endpoints"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search endpoints…"
            />
          </label>
          <select aria-label="API domain" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="all">All domains · {endpoints.length} operations</option>
            {groups.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
          <nav aria-label="API endpoints">
            {filtered.map((e) => (
              <button
                key={e.operation.operationId}
                className={selected === e.operation.operationId ? 'selected' : ''}
                onClick={() => setSelected(e.operation.operationId)}
              >
                <span className={`api-method ${e.method}`}>
                  {e.operation['x-websocket'] ? 'WS' : e.method.toUpperCase()}
                </span>
                <span>{e.operation.summary}</span>
              </button>
            ))}
          </nav>
        </aside>
        {endpoint && (
          <div className="api-operation">
            <div className="api-operation-heading">
              <span className={`api-method ${endpoint.method}`}>
                {endpoint.operation['x-websocket'] ? 'WS' : endpoint.method.toUpperCase()}
              </span>
              <code>{endpoint.path}</code>
            </div>
            <h3>{endpoint.operation.summary}</h3>
            <p>{endpoint.operation.description}</p>
            {!endpoint.operation['x-openharness-supported'] && (
              <div className="notice">This operation is not implemented.</div>
            )}
            {(doc['x-openharness-capabilities'][endpoint.operation.tags[0]]?.limitations ?? []).length >
              0 && (
              <details>
                <summary>Support details</summary>
                <ul>
                  {doc['x-openharness-capabilities'][endpoint.operation.tags[0]].limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="api-parameters">
              {(endpoint.operation.parameters ?? [])
                .filter((p: any) => p.name !== 'harnessId')
                .map((p: any) => (
                  <Field key={p.name} label={`${p.name}${p.required ? ' *' : ''} · ${p.in}`}>
                    <input
                      value={params[p.name] ?? ''}
                      onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
                    />
                  </Field>
                ))}
            </div>
            {mime && (
              <>
                <Field label={mime === 'multipart/form-data' ? 'Form fields (JSON)' : 'Request body'}>
                  <textarea
                    className="api-json"
                    rows={10}
                    spellCheck={false}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </Field>
                {mime === 'multipart/form-data' && (
                  <Field label="Files">
                    <input
                      type="file"
                      multiple
                      onChange={(e) => setUploads(Array.from(e.target.files ?? []))}
                    />
                  </Field>
                )}
                <details>
                  <summary>Request schema</summary>
                  <pre>{JSON.stringify(schema, null, 2)}</pre>
                </details>
              </>
            )}
            {endpoint.operation['x-websocket'] ? (
              <p>
                Connect a WebSocket client to this path using a bearer Authorization header. Browser clients
                can use their same-origin studio session. Send{' '}
                <code>{'{"type":"message","id":"1","content":"Hello"}'}</code>.
              </p>
            ) : (
              <div className="api-request-actions">
                <Button onClick={() => void execute()} disabled={running}>
                  <Play size={16} /> Send {endpoint.method.toUpperCase()}
                </Button>
                {running && (
                  <Button variant="secondary" onClick={() => controller.current?.abort()}>
                    <Square size={16} /> Stop
                  </Button>
                )}
                <Button variant="secondary" onClick={() => void copyCurl()}>
                  <Copy size={16} /> Copy cURL
                </Button>
              </div>
            )}
            {error && (
              <div role="alert" className="error-banner">
                {error}
              </div>
            )}
            <div className="api-response-heading">
              <h3>Response</h3>
              <span aria-live="polite">{status || 'Send a request to see the response'}</span>
            </div>
            {response && (
              <pre className="api-response" aria-label="API response">
                {response}
              </pre>
            )}
            <details>
              <summary>Response schema</summary>
              <pre>{JSON.stringify(endpoint.operation.responses, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>
    </section>
  );
}
