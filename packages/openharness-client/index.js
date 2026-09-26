/** Dependency-free client for all operations advertised by the server's OpenAPI contract. */
export class OpenHarnessClient {
  constructor({ baseUrl, apiKey, fetch: fetcher = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetch = fetcher;
  }
  async contract() {
    if (!this.document) {
      const r = await this.fetch(this.baseUrl + '/openapi.json', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!r.ok) throw new Error(`OpenHarness contract: HTTP ${r.status}`);
      this.document = await r.json();
    }
    return this.document;
  }
  async request(operationId, { path = {}, query = {}, body, signal, headers = {} } = {}) {
    const doc = await this.contract();
    let route, method, operation;
    for (const [url, methods] of Object.entries(doc.paths))
      for (const [m, op] of Object.entries(methods))
        if (op.operationId === operationId) {
          route = url;
          method = m;
          operation = op;
        }
    if (!route) throw new Error(`Unknown operation ${operationId}`);
    if (operation['x-websocket'])
      throw new Error('Use a WebSocket client with the documented connect URL and Authorization header');
    route = route.replace(/\{(\w+)\}/g, (_, name) => {
      if (path[name] === undefined) throw new Error(`Missing path parameter ${name}`);
      return String(path[name])
        .split(name === 'path' ? '/' : '\0')
        .map(encodeURIComponent)
        .join('/');
    });
    const qs = new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    const raw =
      body instanceof FormData ||
      typeof body === 'string' ||
      body instanceof Uint8Array ||
      body instanceof Blob;
    const r = await this.fetch(`${this.baseUrl}${route}${qs.size ? '?' + qs : ''}`, {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal,
    });
    if (!r.ok) {
      const error = await r.json().catch(() => ({}));
      throw Object.assign(new Error(error.error?.message ?? `HTTP ${r.status}`), {
        status: r.status,
        code: error.error?.code,
        details: error.error?.details,
      });
    }
    if (r.status === 204) return undefined;
    if (operationId === 'files.read' || operationId === 'files.download') return r;
    if (r.headers.get('content-type')?.includes('application/json')) return r.json();
    return r; // SSE, ZIP and raw files retain the streaming Response body.
  }
}

/** Adapter methods match the upstream TypeScript HarnessAdapter contract. */
export class OpenHarnessAdapter extends OpenHarnessClient {
  id;
  name = 'OpenHarness';
  version = '0.2.0';
  capabilities = {
    agents: true,
    skills: true,
    execution: true,
    streaming: true,
    sessions: true,
    memory: true,
    subagents: true,
    mcp: true,
    files: true,
    hooks: true,
    planning: true,
    websocket: true,
    multipart: true,
    binaryDownload: true,
  };
  constructor(options) {
    super(options);
    this.id = options.harnessId;
  }
  call(id, options = {}) {
    return this.request(id, { ...options, path: { harnessId: this.id, ...options.path } });
  }
  async getCapabilityManifest() {
    return (await this.call('harnesses.capabilities')).capabilities;
  }
  async pages(id, options = {}) {
    const items = [];
    let offset = 0;
    while (true) {
      const p = await this.call(id, { ...options, query: { ...options.query, limit: 100, offset } });
      items.push(...p.data);
      if (!p.has_more) return items;
      offset += p.limit;
    }
  }
  listAgents() {
    return this.pages('agents.list');
  }
  async createAgent(request) {
    return (await this.call('agents.create', { body: request })).agent;
  }
  async getAgent(agentId) {
    return (await this.call('agents.get', { path: { agentId } })).agent;
  }
  async updateAgent(agentId, updates) {
    return (await this.call('agents.update', { path: { agentId }, body: updates })).agent;
  }
  deleteAgent(agentId) {
    return this.call('agents.delete', { path: { agentId } });
  }
  listSkills() {
    return this.pages('skills.list');
  }
  async installSkill(request) {
    return (await this.call('skills.register', { body: request })).skill;
  }
  async getSkill(skillId) {
    return (await this.call('skills.get', { path: { skillId } })).skill;
  }
  uninstallSkill(skillId) {
    return this.call('skills.uninstall', { path: { skillId } });
  }
  listSessions() {
    return this.pages('sessions.list');
  }
  async createSession(request) {
    return (await this.call('sessions.create', { body: request })).session;
  }
  async getSession(sessionId) {
    return (await this.call('sessions.get', { path: { sessionId } })).session;
  }
  endSession(sessionId) {
    return this.call('sessions.end', { path: { sessionId } });
  }
  async getMemory(agentId) {
    return (await this.call('memory.get', { path: { agentId } })).memory;
  }
  async getMemoryBlock(agentId, label) {
    return (await this.call('memory.getBlock', { path: { agentId, label } })).block;
  }
  async updateMemoryBlock(agentId, label, value) {
    return (await this.call('memory.updateBlock', { path: { agentId, label }, body: { value } })).block;
  }
  async createMemoryBlock(agentId, label, value) {
    return (await this.call('memory.createBlock', { path: { agentId }, body: { label, value } })).block;
  }
  deleteMemoryBlock(agentId, label) {
    return this.call('memory.deleteBlock', { path: { agentId, label } });
  }
  listTools() {
    return this.pages('tools.list');
  }
  invokeTool(toolId, input) {
    return this.call('tools.invoke', { path: { toolId }, body: { input } });
  }
  async listFiles(path = '') {
    return (await this.call('files.list', { query: { path } })).files;
  }
  async readFile(path) {
    const r = await this.call('files.read', { path: { path } });
    return r instanceof Response ? r.arrayBuffer() : JSON.stringify(r);
  }
  async writeFile(path, content) {
    await this.call('files.write', {
      path: { path },
      body: typeof content === 'string' ? content : new Uint8Array(content),
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }
  deleteFile(path) {
    return this.call('files.delete', { path: { path } });
  }
  async *executeStream(request) {
    const response = await this.call('execution.stream', { body: request });
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let at;
        while ((at = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, at);
          pending = pending.slice(at + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (data) yield JSON.parse(data);
        }
        if (done) break;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  async execute(request) {
    let output = '',
      usage;
    const calls = new Map(),
      started = Date.now();
    for await (const e of this.executeStream(request)) {
      if (e.type === 'text') output += e.content;
      else if (e.type === 'tool_call_start') calls.set(e.id, { id: e.id, name: e.name, input: e.input });
      else if (e.type === 'tool_result' && calls.has(e.id))
        Object.assign(calls.get(e.id), {
          output: e.output,
          ...(!e.success ? { error: JSON.stringify(e.output) } : {}),
        });
      else if (e.type === 'error') throw Object.assign(new Error(e.message), { code: e.code });
      else if (e.type === 'done' && e.usage)
        usage = {
          inputTokens: e.usage.input_tokens,
          outputTokens: e.usage.output_tokens,
          totalTokens: e.usage.total_tokens,
          durationMs: Date.now() - started,
        };
    }
    return { output, toolCalls: [...calls.values()], usage };
  }
}
