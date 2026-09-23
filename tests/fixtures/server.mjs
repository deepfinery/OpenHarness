// Deterministic test-only MCP/OAuth/model server. Never included in the default Compose stack.
import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const stats = { tools: 0, models: 0, embeddings: 0, refreshes: 0, oauthTokens: 0 };
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/stats', (_req, res) => res.json(stats));
const sessions = new Map();
const codes = new Map();
let tokenVersion = 1;
let currentAccess = 'test-oauth-access-1';
function mcpServer() {
  const server = new McpServer({ name: 'agentic-test-tools', version: '1.0.0' });
  server.registerTool(
    'lookup',
    {
      description: 'Look up deterministic test data',
      inputSchema: { query: z.string() },
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
  server.registerTool('fail', { description: 'Return a tool error', inputSchema: {} }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'Intentional fixture failure' }],
  }));
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
  next();
}
app.all(['/mcp', '/token-mcp', '/oauth-mcp'], guard, async (req, res) => {
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
app.post('/register', (req, res) => res.status(201).json({ ...req.body, client_id: 'agentic-test-client' }));
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
  if (last?.role === 'tool') return { content: `Tool completed: ${last.content}` };
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
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  return {
    content: system.includes('<knowledge>')
      ? `Grounded answer: ${system.split('<knowledge>')[1].split('</knowledge>')[0].slice(0, 1000)}`
      : `Completed: ${input}`,
  };
}
app.post('/v1/chat/completions', async (req, res) => {
  stats.models++;
  if (JSON.stringify(req.body).includes('delay-model')) await new Promise((r) => setTimeout(r, 15000));
  const message = answer(req.body.messages, req.body.tools);
  res.json({
    choices: [
      {
        message: { role: 'assistant', ...message },
        finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
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
