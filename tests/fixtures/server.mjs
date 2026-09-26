// Deterministic test-only MCP/OAuth/model server. Never included in the default Compose stack.
import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import multer from 'multer';
const app = express();
// Hook and webhook receivers keep the raw body so tests can verify signatures byte for byte.
const received = [];
app.post('/receiver/:mode', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
  const body = JSON.parse(req.body || '{}');
  received.push({ mode: req.params.mode, headers: req.headers, raw: req.body, body });
  if (received.length > 500) received.shift();
  switch (req.params.mode) {
    case 'deny':
      return res.json({ decision: 'deny', reason: 'fixture policy says no' });
    case 'modify':
      return res.json({
        decision: 'modify',
        input: { ...(body.tool?.input ?? {}), query: 'modified by hook' },
      });
    case 'redact':
      return res.json({ decision: 'modify', output: 'REDACTED by hook' });
    case 'fail':
      return res.status(500).json({ error: 'fixture hook failure' });
    default:
      return res.json({ decision: 'allow' });
  }
});
app.get('/receiver', (req, res) =>
  res.json(received.filter((r) => !req.query.mode || r.mode === req.query.mode)),
);
app.delete('/receiver', (_req, res) => {
  received.length = 0;
  res.json({ ok: true });
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// A minimal OpenAI-compatible Vector Stores API (stores, files, attach, status, search), kept in memory.
const vectorStores = new Map();
const vectorFiles = new Map();
const vectorAuth = (req, res, next) =>
  req.headers.authorization === 'Bearer test-vector-stores-key'
    ? next()
    : res.status(401).json({ error: { message: 'Invalid API key' } });
const vsId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
app.get('/openai/v1/vector_stores', vectorAuth, (_req, res) =>
  res.json({
    object: 'list',
    data: [...vectorStores.values()].map(({ id, name }) => ({ id, name, object: 'vector_store' })),
  }),
);
app.post('/openai/v1/vector_stores', vectorAuth, (req, res) => {
  const store = { id: vsId('vs'), name: req.body.name, metadata: req.body.metadata ?? {}, files: new Map() };
  vectorStores.set(store.id, store);
  stats.vectorStores = (stats.vectorStores ?? 0) + 1;
  res.json({ id: store.id, name: store.name, object: 'vector_store' });
});
app.delete('/openai/v1/vector_stores/:id', vectorAuth, (req, res) => {
  if (!vectorStores.delete(req.params.id)) return res.status(404).json({ error: { message: 'Not found' } });
  res.json({ id: req.params.id, deleted: true });
});
app.post(
  '/openai/v1/files',
  vectorAuth,
  multer({ storage: multer.memoryStorage() }).single('file'),
  (req, res) => {
    if (req.body.purpose !== 'assistants' || !req.file)
      return res.status(400).json({ error: { message: 'Bad upload' } });
    const file = {
      id: vsId('file'),
      filename: req.file.originalname,
      text: req.file.buffer.toString('utf8'),
    };
    vectorFiles.set(file.id, file);
    res.json({ id: file.id, object: 'file', filename: file.filename, bytes: req.file.size });
  },
);
app.delete('/openai/v1/files/:id', vectorAuth, (req, res) => {
  if (!vectorFiles.delete(req.params.id)) return res.status(404).json({ error: { message: 'Not found' } });
  res.json({ id: req.params.id, deleted: true });
});
app.post('/openai/v1/vector_stores/:id/files', vectorAuth, (req, res) => {
  const store = vectorStores.get(req.params.id);
  if (!store || !vectorFiles.has(req.body.file_id))
    return res.status(404).json({ error: { message: 'Not found' } });
  store.files.set(req.body.file_id, {
    id: req.body.file_id,
    attributes: req.body.attributes ?? {},
    since: Date.now(),
  });
  res.json({ id: req.body.file_id, object: 'vector_store.file', status: 'in_progress' });
});
app.get('/openai/v1/vector_stores/:id/files/:fileId', vectorAuth, (req, res) => {
  const entry = vectorStores.get(req.params.id)?.files.get(req.params.fileId);
  if (!entry) return res.status(404).json({ error: { message: 'Not found' } });
  // Processing is asynchronous, as on real servers.
  res.json({
    id: entry.id,
    status: Date.now() - entry.since > 300 ? 'completed' : 'in_progress',
    last_error: null,
  });
});
app.delete('/openai/v1/vector_stores/:id/files/:fileId', vectorAuth, (req, res) => {
  if (!vectorStores.get(req.params.id)?.files.delete(req.params.fileId))
    return res.status(404).json({ error: { message: 'Not found' } });
  res.json({ id: req.params.fileId, deleted: true });
});
app.post('/openai/v1/vector_stores/:id/search', vectorAuth, (req, res) => {
  const store = vectorStores.get(req.params.id);
  if (!store) return res.status(404).json({ error: { message: 'Not found' } });
  const terms = String(req.body.query ?? '')
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  const filter = req.body.filters;
  const hits = [];
  for (const entry of store.files.values()) {
    if (filter?.type === 'eq' && entry.attributes[filter.key] !== filter.value) continue;
    const file = vectorFiles.get(entry.id);
    if (!file) continue;
    for (const chunk of file.text.split(/\n{2,}/).filter((c) => c.trim())) {
      const lower = chunk.toLowerCase();
      const score = terms.length ? terms.filter((t) => lower.includes(t)).length / terms.length : 0;
      if (score > 0)
        hits.push({
          file_id: entry.id,
          filename: file.filename,
          score,
          attributes: entry.attributes,
          content: [{ type: 'text', text: chunk }],
        });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  res.json({
    object: 'vector_store.search_results.page',
    search_query: req.body.query,
    data: hits.slice(0, req.body.max_num_results ?? 10),
  });
});
const stats = { tools: 0, models: 0, embeddings: 0, refreshes: 0, oauthTokens: 0 };
let humanToolChanged = false;
app.post('/human-tool-schema', (req, res) => {
  humanToolChanged = req.body.changed === true;
  res.json({ ok: true });
});
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/stats', (_req, res) => res.json(stats));
const sessions = new Map();
const codes = new Map();
let tokenVersion = 1;
let currentAccess = 'test-oauth-access-1';
function mcpServer() {
  const server = new McpServer({ name: 'openharness-test-tools', version: '1.0.0' });
  server.registerTool(
    'lookup',
    {
      description: 'Look up deterministic test data',
      inputSchema: { query: humanToolChanged ? z.string().max(30) : z.string() },
      annotations: { readOnlyHint: humanToolChanged },
      outputSchema: { answer: z.string() },
    },
    async ({ query }) => {
      stats.tools++;
      if (query.includes('slow')) await new Promise((r) => setTimeout(r, 12000));
      return {
        content: [{ type: 'text', text: `MCP lookup: ${query}` }],
        structuredContent: { answer: `MCP lookup: ${query}` },
      };
    },
  );
  server.registerTool(
    'calculate',
    { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => {
      stats.tools++;
      return { content: [{ type: 'text', text: String(a + b) }], structuredContent: { sum: a + b } };
    },
  );
  server.registerTool(
    'file_resource',
    { description: 'Return embedded file data', inputSchema: {} },
    async () => ({
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'file:///reports/result.txt',
            mimeType: 'text/plain',
            text: 'Artifact test bytes\n',
          },
        },
        { type: 'resource_link', uri: 'http://127.0.0.1/private', name: 'must-not-fetch' },
      ],
    }),
  );
  server.registerTool('bigdata', { description: 'Return a very large result', inputSchema: {} }, async () => {
    stats.tools++;
    const rows = Array.from({ length: 400 }, (_, i) => `row ${i}: telemetry value ${i * 7} within limits`);
    return { content: [{ type: 'text', text: `BIGDATA START\n${rows.join('\n')}\nBIGDATA END` }] };
  });
  server.registerTool('fail', { description: 'Return a tool error', inputSchema: {} }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'Intentional fixture failure' }],
  }));
  server.registerTool(
    'strict',
    { description: 'Only accepts mode=fast', inputSchema: { mode: z.enum(['fast']) } },
    async ({ mode }) => {
      stats.tools++;
      return { content: [{ type: 'text', text: `strict ok: ${mode}` }] };
    },
  );
  return server;
}
function guard(req, res, next) {
  if (req.path.includes('oauth-mcp') && req.headers.authorization !== `Bearer ${currentAccess}`)
    return res
      .status(401)
      .set(
        'WWW-Authenticate',
        'Bearer resource_metadata="http://fixtures:9090/.well-known/oauth-protected-resource"',
      )
      .json({ error: 'unauthorized' });
  if (req.path.includes('token-mcp') && req.headers.authorization !== 'Bearer test-mcp-secret')
    return res.status(401).json({ error: 'unauthorized' });
  if (req.path.includes('custom-mcp') && req.headers['x-custom-token'] !== 'test-custom-mcp-value')
    return res.status(401).json({ error: 'unauthorized' });
  next();
}
app.all(['/mcp', '/token-mcp', '/oauth-mcp', '/custom-mcp'], guard, async (req, res) => {
  try {
    const id = req.headers['mcp-session-id'];
    let transport = id ? sessions.get(id) : null;
    if (!transport && req.method === 'POST' && req.body.method === 'initialize') {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => sessions.set(sessionId, transport),
        enableJsonResponse: true,
      });
      transport.onclose = () => sessions.delete(transport.sessionId);
      await mcpServer().connect(transport);
    }
    if (!transport) return res.status(404).json({ error: 'session not found' });
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/sse-message', res);
  sessions.set(transport.sessionId, transport);
  res.on('close', () => sessions.delete(transport.sessionId));
  await mcpServer().connect(transport);
});
app.post('/sse-message', async (req, res) => {
  const t = sessions.get(String(req.query.sessionId));
  if (!t) return res.sendStatus(404);
  await t.handlePostMessage(req, res, req.body);
});
app.get('/.well-known/oauth-protected-resource', (_req, res) =>
  res.json({
    resource: 'http://fixtures:9090/oauth-mcp',
    authorization_servers: ['http://fixtures:9090'],
    scopes_supported: ['tools'],
  }),
);
app.get('/.well-known/oauth-protected-resource/oauth-mcp', (_req, res) =>
  res.json({
    resource: 'http://fixtures:9090/oauth-mcp',
    authorization_servers: ['http://fixtures:9090'],
    scopes_supported: ['tools'],
  }),
);
app.get('/.well-known/oauth-authorization-server', (_req, res) =>
  res.json({
    issuer: 'http://fixtures:9090',
    authorization_endpoint: 'http://fixtures:9090/authorize',
    token_endpoint: 'http://fixtures:9090/token',
    registration_endpoint: 'http://fixtures:9090/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  }),
);
app.post('/register', (req, res) =>
  res.status(201).json({ ...req.body, client_id: 'openharness-test-client' }),
);
app.get('/authorize', (req, res) => {
  const code = randomUUID();
  codes.set(code, { challenge: req.query.code_challenge, redirect: req.query.redirect_uri });
  const url = new URL(String(req.query.redirect_uri));
  url.searchParams.set('state', String(req.query.state));
  url.searchParams.set('code', code);
  res.redirect(url.toString());
});
app.post('/token', (req, res) => {
  if (req.body.grant_type === 'refresh_token') {
    if (req.body.refresh_token !== 'test-refresh-token') return res.sendStatus(400);
    stats.refreshes++;
  } else {
    const code = codes.get(req.body.code);
    codes.delete(req.body.code);
    if (
      !code ||
      createHash('sha256')
        .update(req.body.code_verifier ?? '')
        .digest('base64url') !== code.challenge ||
      req.body.redirect_uri !== code.redirect
    )
      return res.status(400).json({ error: 'invalid_grant' });
  }
  stats.oauthTokens++;
  res.json({
    access_token: currentAccess,
    token_type: 'Bearer',
    refresh_token: 'test-refresh-token',
    expires_in: 3600,
    scope: 'tools',
  });
});
app.post('/expire-token', (_req, res) => {
  currentAccess = `test-oauth-access-${++tokenVersion}`;
  res.json({ ok: true });
});
function answer(messages, tools) {
  const last = messages.at(-1);
  const input = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const lastToolName =
    last?.name ??
    messages.flatMap((m) => m.tool_calls ?? []).find((call) => call.id === last?.tool_call_id)?.function
      ?.name;
  const memoryCall = (name, args) => ({
    content: '',
    tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  if (String(input).includes('parallel human checkpoint')) {
    if (last?.role === 'tool') return { content: `Parallel result: ${last.content}` };
    if (messages.some((m) => m.role === 'system' && String(m.content).includes('human-question-member')))
      return memoryCall('ask_human', { question: 'Parallel region?' });
    return memoryCall('memory_write', {
      title: 'Completed parallel sibling',
      content: 'This sibling must not rerun.',
      kind: 'finding',
    });
  }
  if (String(input).includes('human repeated checkpoint')) {
    const calls = messages.flatMap((m) => m.tool_calls ?? []).filter((c) => c.function.name === 'ask_human');
    if (calls.length >= 2 && last?.role === 'tool')
      return { content: `Repeated questions complete: ${last.content}` };
    if (calls.length) return memoryCall('ask_human', { question: 'Second question?' });
    return {
      content: '',
      tool_calls: [
        ...memoryCall('memory_write', {
          title: 'Repeated pause evidence',
          content: 'Only once.',
          kind: 'finding',
        }).tool_calls,
        ...memoryCall('ask_human', { question: 'First question?' }).tool_calls,
      ],
    };
  }
  if (String(input).includes('human delegate test')) {
    if (last?.role === 'tool') return { content: `Delegate finished: ${last.content}` };
    return memoryCall('spawn_agents', {
      agents: [{ task: 'human checkpoint test child', effort: 'light' }, { task: 'A normal sibling task' }],
    });
  }
  if (String(input).includes('human checkpoint test')) {
    if (last?.role === 'tool') return { content: `Human resumed: ${last.content}` };
    const first = memoryCall('memory_write', {
      title: 'Before human pause',
      content: 'This note must be written exactly once.',
      kind: 'finding',
    });
    const ask = memoryCall('ask_human', { question: 'Which region should I use?' });
    return { content: '', tool_calls: [...first.tool_calls, ...ask.tool_calls] };
  }
  if (String(input).includes('human approval test')) {
    if (last?.role === 'tool') return { content: `Approval result: ${last.content}` };
    const tool = tools.find((t) => t.function.description.includes('/ lookup:'));
    const first = memoryCall('memory_write', {
      title: 'Before tool approval',
      content: 'One prior effect.',
      kind: 'finding',
    });
    return {
      content: '',
      tool_calls: [
        ...first.tool_calls,
        ...memoryCall(tool.function.name, { query: 'original approved query' }).tool_calls,
      ],
    };
  }
  if (String(input).includes('artifact resource test')) {
    if (last?.role === 'tool') return { content: 'File captured.' };
    return memoryCall(
      tools.find((t) => t.function.description.includes('/ file_resource:')).function.name,
      {},
    );
  }
  const notebookTarget = /write notebook ([0-9a-f-]{36})/.exec(String(input));
  if (notebookTarget) {
    if (last?.role === 'tool') return { content: `Notebook write: ${last.content}` };
    return memoryCall('kb_write', {
      knowledge_base_id: notebookTarget[1],
      title: 'Cedar environment',
      kind: 'environment',
      content: 'cedar notebook: deployment requires three health checks.',
      sources: ['fixture://cedar'],
    });
  }
  if (String(input).includes('notebook skill record')) {
    if (lastToolName === 'kb_write') return { content: `Skill note saved: ${last.content}` };
    if (lastToolName === 'load_skill')
      return memoryCall('kb_write', {
        title: 'Cedar conversation preference',
        kind: 'conversation',
        content: String(last.content).includes('NOTEBOOK_RULE')
          ? 'cedar user preference: include confidence and evidence sources.'
          : 'SKILL MISSING',
      });
    return memoryCall('load_skill', {
      name: tools?.find((t) => t.function.name === 'load_skill')?.function.parameters.properties.name.enum[0],
    });
  }
  if (String(input).includes('notebook environment roundtrip')) {
    if (lastToolName === 'kb_write')
      return memoryCall('kb_read', { note_id: JSON.parse(last.content).note_id });
    if (lastToolName === 'kb_read')
      return memoryCall('kb_search', { query: 'cedar notebook', folder: 'environment' });
    if (lastToolName === 'kb_search') return { content: `Notebook verified: ${last.content}` };
    return memoryCall('kb_write', {
      title: 'Cedar environment',
      kind: 'environment',
      content: 'cedar notebook: deployment requires three health checks.',
      sources: ['fixture://cedar'],
    });
  }
  if (String(input).includes('context research checkpoint')) {
    if (!tools?.length)
      return {
        content:
          'Research synthesis: saved source-backed observations; remaining outlook checks are incomplete.',
      };
    return memoryCall('memory_write', {
      title: 'Research finding',
      kind: 'finding',
      content: 'Verified source https://evidence.example/NVDA and risk uncertainty. '.repeat(60),
    });
  }
  if (String(input).includes('exhaust tool evidence')) {
    if (!tools?.length && String(input).includes('summarize')) {
      const clean =
        messages.length === 2 &&
        !messages.some((m) => m.role === 'tool' || m.tool_calls?.length) &&
        String(input).includes('MCP lookup: recorded evidence');
      return {
        content: clean
          ? 'The lookup returned recorded evidence. Further checks remain incomplete.'
          : 'SYNTHESIS CONTEXT INVALID',
      };
    }
    if (!tools?.length && String(input).includes('malformed'))
      return {
        content: '',
        tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'lookup', arguments: '{' } }],
      };
    return memoryCall(
      tools?.find((t) => t.function.description.includes('/ lookup:'))?.function.name ?? 'lookup',
      { query: 'recorded evidence' },
    );
  }
  if (String(input).includes('exhaust analysis turns')) {
    if (!tools?.length && !String(input).includes('ignore synthesis'))
      return {
        content:
          'Partial assessment: verified the recorded findings. More checks remain; the audit is incomplete.',
      };
    return memoryCall('memory_write', {
      title: 'Inspection finding',
      content: 'Verified fixture finding with remaining checks.',
      kind: 'finding',
    });
  }
  if (String(input).includes('inspect past forty')) {
    const count = messages.filter((m) => m.role === 'tool').length;
    return count < 41 ? memoryCall('memory_search', {}) : { content: 'Completed 41 inspection turns.' };
  }
  if (String(input).includes('task notebook roundtrip')) {
    if (lastToolName === 'memory_write') return memoryCall('memory_search', { query: 'immediate evidence' });
    if (lastToolName === 'memory_search')
      return memoryCall('memory_read', { note_id: JSON.parse(last.content).notes[0].note_id });
    if (lastToolName === 'memory_read')
      return { content: `Read task evidence: ${JSON.parse(last.content).content}` };
    return memoryCall('memory_write', {
      title: 'Immediate finding',
      content: 'immediate evidence: verified fixture fact.',
      kind: 'finding',
      sources: ['fixture://evidence'],
    });
  }
  if (String(input).includes('delegate task notebook')) {
    if (lastToolName === 'spawn_agents') {
      const report = JSON.parse(last.content)[0];
      return memoryCall('memory_read', {
        note_id: report.notes.find((n) => n.path.includes('/reports/')).note_id,
        offset: 1800,
      });
    }
    if (lastToolName === 'memory_read')
      return { content: `Parent read full report: ${JSON.parse(last.content).content}` };
    return memoryCall('spawn_agents', {
      agents: [
        { task: 'Sub-task: produce long notebook report', effort: 'light' },
        { task: 'Sub-task: task notebook roundtrip', effort: 'medium' },
      ],
    });
  }
  if (String(input).includes('produce long notebook report'))
    return { content: 'Report start. ' + 'Evidence. '.repeat(200) + 'REPORT TAIL VERIFIED' };
  const readTask = /read task note ([0-9a-f-]{36})/.exec(String(input));
  if (readTask && last?.role !== 'tool') return memoryCall('memory_read', { note_id: readTask[1] });
  const promoteTask = /promote task note ([0-9a-f-]{36})/.exec(String(input));
  if (promoteTask && last?.role !== 'tool') return memoryCall('memory_promote', { note_id: promoteTask[1] });
  if (String(input).includes('recall conversation'))
    return {
      content: `Earlier messages: ${messages
        .filter((m) => m.role === 'user')
        .slice(0, -1)
        .map((m) => m.content)
        .join(' | ')}`,
    };
  if (last?.role === 'tool') {
    if (String(last.content).includes('Invalid arguments') && tools?.length) {
      const strict = tools.find((t) => t.function.description.includes('/ strict:'));
      if (strict)
        return {
          content: '',
          tool_calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: { name: strict.function.name, arguments: JSON.stringify({ mode: 'fast' }) },
            },
          ],
        };
    }
    return { content: `Tool completed: ${last.content}` };
  }
  if (String(input).includes('use strict tool') && tools?.length) {
    const strict = tools.find((t) => t.function.description.includes('/ strict:')) ?? tools[0];
    return {
      content: '',
      tool_calls: [
        {
          id: randomUUID(),
          type: 'function',
          function: { name: strict.function.name, arguments: JSON.stringify({ mode: 'slow' }) },
        },
      ],
    };
  }
  // Skills: load the skill named in the request (or the first one), then answer from its instructions.
  if (
    String(input).includes('use your skill') &&
    tools?.some((t) => t.function.name === 'load_skill') &&
    last?.role !== 'tool'
  ) {
    const skill = tools.find((t) => t.function.name === 'load_skill');
    const names = skill.function.parameters.properties.name.enum;
    const wanted = names.find((n) => String(input).toLowerCase().includes(n.toLowerCase())) ?? names[0];
    return {
      content: '',
      tool_calls: [
        {
          id: randomUUID(),
          type: 'function',
          function: { name: 'load_skill', arguments: JSON.stringify({ name: wanted }) },
        },
      ],
    };
  }
  // Machine control: call the device's run_command with argv, then report what it returned.
  const machineCommand = String(input).includes('run uname on the machine')
    ? ['uname', '-a']
    : String(input).includes('run ls on the machine')
      ? ['ls', '-la']
      : undefined;
  if (machineCommand && tools?.length) {
    const cmd = tools.find((t) => t.function.description.includes('/ run_command:'));
    if (cmd)
      return {
        content: '',
        tool_calls: [
          {
            id: randomUUID(),
            type: 'function',
            function: { name: cmd.function.name, arguments: JSON.stringify({ argv: machineCommand }) },
          },
        ],
      };
  }
  // Open Harness conformance prompts (tests/conformance): deterministic stand-ins for what a real model would do.
  const toolNamed = (suffix) => tools?.find((t) => t.function.description.includes(`/ ${suffix}:`));
  const callTool = (tool, args) => ({
    content: '',
    tool_calls: [
      {
        id: randomUUID(),
        type: 'function',
        function: { name: tool.function.name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const prompt = String(input);
  if (/Use a tool to tell me what (\d+) \+ (\d+)/.test(prompt) && toolNamed('calculate')) {
    const [, a, b] = /what (\d+) \+ (\d+)/.exec(prompt);
    return callTool(toolNamed('calculate'), { a: Number(a), b: Number(b) });
  }
  if (/Read the file at \/nonexistent/.test(prompt) && toolNamed('fail'))
    return callTool(toolNamed('fail'), {});
  if (/shell|directory|environment|filesystem tools/i.test(prompt) && toolNamed('lookup'))
    return callTool(toolNamed('lookup'), { query: prompt.slice(0, 80) });
  const math = /What is (\d+) ?([*x+\-/]) ?(\d+)\?/.exec(prompt);
  if (math) {
    const [a, op, b] = [Number(math[1]), math[2], Number(math[3])];
    const value = op === '+' ? a + b : op === '-' ? a - b : op === '/' ? a / b : a * b;
    return { content: /just the number/i.test(prompt) ? String(value) : `${a} ${op} ${b} = ${value}` };
  }
  if (/Count from 1 to 3/.test(prompt)) return { content: '1, 2, 3' };
  if (/pirate/i.test(messages.find((m) => m.role === 'system')?.content ?? ''))
    return { content: 'Arr, ahoy matey! Ye be welcome aboard.' };
  // Knowledge workspace tools are built in, so they keep their plain names.
  const builtin = (name, args) =>
    tools?.some((t) => t.function.name === name)
      ? {
          content: '',
          tool_calls: [
            { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        }
      : undefined;
  // Delegation: the spawn_agents tool is built in, so it keeps its plain name.
  const spawnTool = tools?.find((t) => t.function.name === 'spawn_agents');
  const spawn = (agents) => ({
    content: '',
    tool_calls: [
      {
        id: randomUUID(),
        type: 'function',
        function: { name: 'spawn_agents', arguments: JSON.stringify({ agents }) },
      },
    ],
  });
  if (spawnTool && String(input).includes('research with sub-agents'))
    return spawn([
      { task: 'Sub-task: record a finding about the sky', effort: 'light' },
      { task: 'Sub-task: check the widget price list' },
    ]);
  if (spawnTool && String(input).includes('delegate with a skill')) {
    const skill = spawnTool.function.parameters.properties.agents.items.properties.skill?.enum?.[0];
    return spawn([{ task: 'Sub-task: follow the skill for this report', ...(skill ? { skill } : {}) }]);
  }
  if (spawnTool && String(input).includes('delegate recursively'))
    return spawn([{ task: 'Sub-task: research with sub-agents one level deeper' }]);
  if (spawnTool && String(input).includes('delegate a crowd'))
    return spawn([1, 2, 3].map((n) => ({ task: `Sub-task: crowd member ${n}` })));
  const system = messages
    .filter((m) => m.role === 'system' || String(m.content).startsWith('[Saved notebook references]'))
    .map((m) => m.content)
    .join('\n');
  // Reflection: turn a run into a deterministic lesson that names what the feedback asked for.
  if (system.startsWith('You turn one run of an AI agent into a lesson')) {
    const task = /Task: (.*)/.exec(String(input))?.[1]?.slice(0, 60) ?? 'this task';
    const comment = /Comment: (.*)/.exec(String(input))?.[1];
    const verdict = String(input).includes('the user rejected')
      ? `avoid what the user rejected${comment ? ` (${comment})` : ''}`
      : String(input).includes('the user approved')
        ? 'repeat the approach the user approved'
        : 'check the failing step before relying on it';
    return { content: `Lesson: for requests like "${task}", ${verdict}.` };
  }
  if (String(input).includes('what did we learn'))
    return {
      content: system.includes('<lessons>')
        ? `Recalled: ${system.split('<lessons>')[1].split('</lessons>')[0].trim()}`
        : 'Recalled: nothing yet',
    };
  if (String(input).includes('follow the skill') && system.includes('<skill>'))
    return { content: `Following skill: ${system.split('<skill>')[1].split('</skill>')[0].trim()}` };
  if (String(input).includes('record a finding')) {
    const call = builtin('kb_write', {
      title: 'Sky colour',
      kind: 'finding',
      content: 'The sky looks blue because of Rayleigh scattering of sunlight.',
      sources: ['fixture://physics'],
      confidence: 0.9,
    });
    if (call) return call;
  }
  if (String(input).includes('record a decision')) {
    const call = builtin('kb_write', {
      title: 'Use the blue palette',
      kind: 'decision',
      content: 'We use the blue palette for the report.',
      reasons: 'It matches the sky finding and the brand.',
    });
    if (call) return call;
  }
  if (String(input).includes('search the workspace')) {
    const call = builtin('kb_search', { query: 'why is the sky blue rayleigh scattering' });
    if (call) return call;
  }
  const readRequest = /read note ([0-9a-f-]{36})/.exec(String(input));
  if (readRequest) {
    const call = builtin('kb_read', { note_id: readRequest[1], limit: 500 });
    if (call) return call;
  }
  if (String(input).includes('use big tool') && tools?.length) {
    const big = tools.find((t) => t.function.description.includes('/ bigdata:'));
    if (big)
      return {
        content: '',
        tool_calls: [
          { id: randomUUID(), type: 'function', function: { name: big.function.name, arguments: '{}' } },
        ],
      };
  }
  if (String(input).includes('use tool') && tools?.length)
    return {
      content: '',
      tool_calls: [
        {
          id: randomUUID(),
          type: 'function',
          function: {
            name:
              tools.find((t) => t.function.description.includes('/ lookup:'))?.function.name ??
              tools[0].function.name,
            arguments: JSON.stringify({ query: 'orchestration test' }),
          },
        },
      ],
    };
  // Deterministic replies for the agentic patterns exercised by the integration tests.
  if (String(input).includes('write a numbered plan'))
    return { content: '1. Gather the facts about the request\n2. Summarize the findings' };
  if (String(input).includes('Now carry out step'))
    return {
      content: `Step result for: ${String(input).split('Now carry out step')[1].split('\n')[0].trim()}`,
    };
  if (String(input).includes('Write the final answer to the original request'))
    return {
      content: `Planned answer: ${String(input).split('Original request:')[1].split('\n')[0].trim()}`,
    };
  if (String(input).startsWith('Critique the answer above')) return { content: 'Critique: add a source.' };
  if (String(input).startsWith('Revise your answer using this critique'))
    return { content: 'Revised answer with a source.' };
  if (String(input).includes('Work on this in iterations')) {
    const iterations = String(input).match(/Iteration \d+:/g)?.length ?? 0;
    return { content: iterations >= 1 ? 'Finished the task.\nDONE' : 'Did the first half.' };
  }
  return {
    content: system.includes('<knowledge>')
      ? `Grounded answer: ${system.split('<knowledge>')[1].split('</knowledge>')[0].slice(0, 1000)}`
      : `Completed: ${input}`,
  };
}
// Contract tests observe the actual prompt delivered over HTTP; they do not claim to evaluate a real model.
function clockAnswer(messages, tools) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const clock = system.match(/\[Runtime clock\][\s\S]*?(?=\n\n|$)/)?.[0] ?? 'MISSING CLOCK';
  const input = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  stats.clockRequests ??= [];
  stats.clockRequests.push({ system, input, tools: tools?.length ?? 0 });
  stats.clockRequests = stats.clockRequests.slice(-100);
  const call = (name, args) => ({
    content: '',
    tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  if (
    input.includes('delegate-clock') &&
    tools?.some((t) => t.function.name === 'spawn_agents') &&
    messages.at(-1)?.role !== 'tool'
  )
    return call('spawn_agents', { agents: [{ task: 'child-clock', effort: 'light' }] });
  const lookup = tools?.find((t) => t.function.description?.includes('Look up deterministic test data'));
  if (lookup && input.includes('research-clock')) {
    const range = /inclusive\): (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(clock);
    return call(lookup.function.name, { query: `Stock market news ${range?.[1]} through ${range?.[2]}` });
  }
  return { content: `${tools?.length ? 'Analysis' : 'Final synthesis'}: ${clock}` };
}
function selectionAnswer(model, messages, tools) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const input = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  const call = (name, args) => ({
    id: randomUUID(),
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  const reply = (...calls) => ({ content: '', tool_calls: calls });
  const corrected = system.includes('the entire tool batch was rejected');
  if (system.includes('Analysis has ended.'))
    return {
      content: `Assessment incomplete: tool selection blocked further checks. ${input.includes('prior evidence retained') ? 'Prior evidence retained.' : 'No prior evidence.'}`,
    };
  if (model === 'test-selection-plan') {
    if (input.includes('Before doing anything'))
      return corrected
        ? { content: '1. Summarize the available evidence.' }
        : reply(
            call('memory_write', { title: 'Unapproved planning write', content: 'should never be stored' }),
          );
    return { content: 'Plan completed without unauthorized writes.' };
  }
  const last = messages.at(-1);
  if (last?.role !== 'tool')
    return reply(
      call('memory_write', { title: 'Prior evidence', content: 'prior evidence retained', kind: 'finding' }),
    );
  const previous = messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.id === last.tool_call_id)
    ?.function.name;
  if (previous !== 'memory_write') return { content: `Recovered using the allowed tool: ${last.content}` };
  const allowed = tools?.find((t) => t.function.description?.includes('Look up deterministic test data'))
    ?.function.name;
  if (corrected && model !== 'test-selection-persistent')
    return reply(call(allowed, { query: 'corrected request' }));
  if (model === 'test-selection-batch')
    return reply(...Array.from({ length: 21 }, () => call(allowed, { query: 'must not execute' })));
  const unavailable =
    model === 'test-selection-disabled'
      ? 'memory_promote'
      : model === 'test-selection-unselected'
        ? 'calculate'
        : 'functions.lookup';
  return reply(
    call(allowed, { query: 'must not execute' }),
    call(unavailable, { secret: 'private rejected argument' }),
  );
}
app.post('/v1/chat/completions', async (req, res) => {
  if (req.body.model === 'test-safety-classifier')
    return res.json({
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              allowed: !JSON.stringify(req.body.messages).includes('unsafe semantic fixture'),
            }),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    });
  stats.models++;
  if (JSON.stringify(req.body).includes('delay-model')) await new Promise((r) => setTimeout(r, 15000));
  if (req.body.model.startsWith('test-context-')) {
    const window = req.body.model === 'test-context-32k' ? 32768 : 8192;
    const counted = Math.ceil(
      (JSON.stringify(req.body.messages).length + JSON.stringify(req.body.tools ?? []).length) / 2,
    );
    const requested = req.body.max_tokens ?? req.body.max_completion_tokens ?? 4096;
    stats.contextRequests ??= [];
    stats.contextRequests.push({
      model: req.body.model,
      counted,
      requested,
      tools: req.body.tools?.length ?? 0,
    });
    stats.contextRequests = stats.contextRequests.slice(-200);
    if (req.body.model === 'test-context-auth')
      return res.status(401).json({ error: { message: 'Invalid API key' } });
    if (req.body.model === 'test-context-reject' || counted + requested > window) {
      return res.status(400).json({
        error: {
          message: `This model's maximum context length is ${window} tokens. However, you requested ${requested} output tokens and your prompt contains at least ${counted} input tokens, for a total of at least ${counted + requested} tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=${counted}).`,
        },
      });
    }
  }
  // Behave like a 32k-class model that rejects oversized prompts, so context compaction can be tested.
  const promptChars = req.body.messages.reduce((n, m) => n + String(m.content ?? '').length, 0);
  // test-dense counts about 2.5 characters per token and includes the tool definitions, as vLLM does with URL- and
  // JSON-heavy search results, so the studio's character-based estimate undershoots it.
  if (req.body.model === 'test-dense') {
    const counted = Math.ceil(
      (JSON.stringify(req.body.messages).length + JSON.stringify(req.body.tools ?? []).length) / 2.5,
    );
    const requested = req.body.max_tokens ?? 4096;
    if (counted + requested > 12000) {
      stats.denseRejections = (stats.denseRejections ?? 0) + 1;
      return res.status(400).json({
        error: {
          message: `This model's maximum context length is 12000 tokens. However, you requested ${requested} output tokens and your prompt contains at least ${counted} input tokens, for a total of at least ${counted + requested} tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=${counted})`,
          type: 'BadRequestError',
        },
      });
    }
  } else if (!req.body.model.startsWith('test-context-') && promptChars > 24000) {
    stats.contextRejections = (stats.contextRejections ?? 0) + 1;
    return res.status(400).json({
      error: {
        message: `This model's maximum context length is 6000 tokens. However, you requested ${req.body.max_tokens ?? 4096} output tokens and your prompt contains at least ${Math.ceil(promptChars / 4)} input tokens. Please reduce the length of the input prompt or the number of requested output tokens.`,
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    });
  }
  let message = req.body.model.startsWith('test-selection-')
    ? selectionAnswer(req.body.model, req.body.messages, req.body.tools)
    : req.body.model === 'test-clock'
      ? clockAnswer(req.body.messages, req.body.tools)
      : answer(req.body.messages, req.body.tools);
  // Fail only after a real MCP result, so recovery must preserve already completed tool calls.
  if (
    req.body.model.startsWith('test-response-') &&
    req.body.messages.filter((m) => m.role === 'tool').length === 1
  ) {
    const name = req.body.tools[0].function.name;
    const valid = {
      id: randomUUID(),
      type: 'function',
      function: { name, arguments: JSON.stringify({ query: 'recovered call' }) },
    };
    const invalid = {
      id: randomUUID(),
      type: 'function',
      function: { name, arguments: '{"query":"' + 'x'.repeat(11655) },
    };
    const corrupt = req.body.stream || req.body.model === 'test-response-persistent';
    message = { content: '', tool_calls: corrupt ? [valid, invalid] : [valid] };
    if (req.body.stream && req.body.model === 'test-response-incomplete') {
      res.set('Content-Type', 'text/event-stream');
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...valid }] } }] })}\n\n`,
      );
      return res.end(); // Syntactically valid arguments, but no finish reason: nothing may execute.
    }
  }
  if (req.body.model === 'test-guardrail') {
    const input = req.body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    if (input.includes('guarded private output'))
      message = { content: 'Contact alice@example.com. SSN 123-45-6789.' };
    else if (input.includes('guarded command') && !req.body.messages.some((m) => m.role === 'tool')) {
      const name = req.body.tools.find((t) =>
        t.function.description?.includes('Look up deterministic test data'),
      )?.function.name;
      if (name)
        message = {
          content: 'Inspect the machine',
          tool_calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: { name, arguments: JSON.stringify({ query: 'blocked-machine-command' }) },
            },
          ],
        };
    } else if (input.includes('guarded retrieval'))
      message = {
        content: req.body.messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
          .join('\n'),
      };
    else if (input.includes('guarded tool result') && !req.body.messages.some((m) => m.role === 'tool')) {
      const name = req.body.tools.find((t) =>
        t.function.description?.includes('Look up deterministic test data'),
      )?.function.name;
      if (name)
        message = {
          content: 'Look up a contact',
          tool_calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: { name, arguments: JSON.stringify({ query: 'Contact alice@example.com' }) },
            },
          ],
        };
    }
  }
  const finish = message.tool_calls ? 'tool_calls' : 'stop';
  // Report usage the way a real provider would, so token budgets can be exercised end to end.
  const usage = {
    prompt_tokens: Math.ceil(promptChars / 4),
    completion_tokens: Math.ceil(JSON.stringify(message).length / 4),
  };
  if (req.body.stream) {
    stats.streams = (stats.streams ?? 0) + 1;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const send = (chunk) => res.write(`data: ${JSON.stringify({ choices: [chunk] })}\n\n`);
    const words = (message.content ?? '').split(/(?<= )/);
    for (const word of words) if (word) send({ index: 0, delta: { content: word } });
    for (const [index, call] of (message.tool_calls ?? []).entries()) {
      // Real providers split arguments across several deltas; do the same here.
      const args = call.function.arguments;
      send({
        index: 0,
        delta: {
          tool_calls: [
            { index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } },
          ],
        },
      });
      send({ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(0, 5) } }] } });
      send({ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(5) } }] } });
    }
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.json({
    choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage,
  });
});
app.post('/api/chat', (req, res) => {
  stats.models++;
  const message = answer(req.body.messages, req.body.tools);
  if (message.tool_calls)
    message.tool_calls.forEach((t) => {
      t.function.arguments = JSON.parse(t.function.arguments);
    });
  res.json({ message: { role: 'assistant', ...message }, done: true });
});
app.post('/v1/messages', (req, res) => {
  stats.models++;
  const last = req.body.messages.at(-1);
  const toolResult = last?.content?.find((c) => c.type === 'tool_result');
  if (toolResult)
    return res.json({
      content: [{ type: 'text', text: `Tool completed: ${toolResult.content}` }],
      stop_reason: 'end_turn',
    });
  if (JSON.stringify(last).includes('use tool') && req.body.tools?.length)
    return res.json({
      content: [
        {
          type: 'tool_use',
          id: randomUUID(),
          name: req.body.tools[0].name,
          input: { query: 'anthropic test' },
        },
      ],
      stop_reason: 'tool_use',
    });
  res.json({
    content: [{ type: 'text', text: `Completed: ${JSON.stringify(last.content)}` }],
    stop_reason: 'end_turn',
  });
});
app.post('/v1beta/models/:model', (req, res) => {
  const embedding = req.params.model.includes('embedContent');
  if (embedding) {
    stats.embeddings++;
    return res.json({ embedding: { values: [1, 0.5, 0.2, 0.1] } });
  }
  stats.models++;
  const last = req.body.contents.at(-1);
  const response = last.parts.find((p) => p.functionResponse);
  const parts = response
    ? [{ text: `Tool completed: ${JSON.stringify(response.functionResponse.response)}` }]
    : JSON.stringify(last).includes('use tool') && req.body.tools?.length
      ? [
          {
            functionCall: {
              name: req.body.tools[0].functionDeclarations[0].name,
              args: { query: 'gemini test' },
            },
            thoughtSignature: 'fixture-signature',
          },
        ]
      : [{ text: `Completed: ${JSON.stringify(last.parts)}` }];
  res.json({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
});
app.post('/v1/embeddings', (_req, res) => {
  stats.embeddings++;
  res.json({ data: [{ embedding: [1, 0.5, 0.2, 0.1] }] });
});
app.post('/api/embed', (_req, res) => {
  stats.embeddings++;
  res.json({ embeddings: [[1, 0.5, 0.2, 0.1]] });
});
app.get('/embed-parent', (_req, res) =>
  res.type('html').send('<!doctype html><html><body>Embed host</body></html>'),
);
app.listen(9090, '0.0.0.0', () => console.log('Test fixtures ready'));
