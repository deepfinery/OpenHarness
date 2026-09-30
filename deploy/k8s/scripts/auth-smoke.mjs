// Run with Node 22+, PUBLIC_URL and NODE_EXTRA_CA_CERTS. Credentials stay in .local.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const base = process.env.PUBLIC_URL?.replace(/\/$/, '');
assert.ok(base?.startsWith('https://'), 'Set PUBLIC_URL to the HTTPS origin');
assert.ok(process.env.KUBE_CONTEXT, 'Set KUBE_CONTEXT explicitly');
const dir = new URL('../.local/', import.meta.url);
await mkdir(dir, { recursive: true, mode: 0o700 });
const credentialsFile = new URL('admin.json', dir);
let credentials;
let cookie = '';
async function request(path, body, method = body === undefined ? 'GET' : 'POST', auth = cookie) {
  const response = await fetch(base + '/api' + path, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: { Origin: base, 'Content-Type': 'application/json', ...(auth ? { Cookie: auth } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : undefined };
}
async function ok(path, body, method) {
  const result = await request(path, body, method);
  assert.ok(result.response.ok, `${method ?? 'request'} ${path}: ${result.response.status}`);
  return result.data;
}
const status = await ok('/auth/status');
if (status.needsSetup) {
  credentials = { email: 'admin@openharness.local', password: randomBytes(32).toString('base64url') };
  // Persist before setup so a network failure cannot lose the generated password.
  await writeFile(credentialsFile, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const setupToken = Buffer.from(
    execFileSync(
      'kubectl',
      [
        '--context',
        process.env.KUBE_CONTEXT,
        '-n',
        'openharness',
        'get',
        'secret',
        'openharness-secrets',
        '-o',
        'jsonpath={.data.SETUP_TOKEN}',
      ],
      { encoding: 'utf8' },
    ),
    'base64',
  ).toString();
  const setup = await request('/auth/setup', {
    ...credentials,
    name: 'OpenHarness Administrator',
    setupToken,
  });
  assert.equal(setup.response.status, 201, 'Initial administrator setup failed');
} else {
  credentials = JSON.parse(await readFile(process.env.ADMIN_CREDENTIALS_FILE ?? credentialsFile, 'utf8'));
}
const login = await request('/auth/login', credentials);
assert.equal(login.response.status, 200);
const session = login.response.headers.get('set-cookie');
assert.match(session, /; Secure/i);
assert.match(session, /; HttpOnly/i);
cookie = session.split(';')[0];
assert.equal((await ok('/auth/me')).email, credentials.email);
assert.equal((await request('/agents', undefined, 'GET', '')).response.status, 401);
console.log('HTTPS login, secure session and authentication boundary: OK');
const flow = await ok('/workflows', {
  name: 'Kubernetes smoke ' + randomUUID().slice(0, 8),
  startAt: 'answer',
  nodes: [
    { id: 'answer', name: 'Answer', type: 'output', template: 'Kubernetes runner completed: {{input}}' },
  ],
});
try {
  const input = randomUUID();
  const submitted = await ok('/runs', { workflowId: flow.id, input });
  let run;
  for (let attempt = 0; attempt < 90; attempt++) {
    run = await ok('/runs/' + submitted.id);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(run.output, 'Kubernetes runner completed: ' + input);
  console.log('API → RabbitMQ → runner → MongoDB workflow execution: OK (' + run.id + ')');
  assert.ok(Array.isArray((await ok('/devices')).machines));
  console.log('Authenticated gateway inventory: OK');
} finally {
  await ok('/workflows/' + flow.id, undefined, 'DELETE');
}
await new Promise((resolve, reject) => {
  const socket = new WebSocket(base.replace('https:', 'wss:') + '/connect', 'openharness-mcp.v1');
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error('WSS handshake timed out'));
  }, 15000);
  socket.addEventListener('open', () =>
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol_version: 1,
        device_id: 'k8s-smoke-unregistered',
        platform: 'linux',
        token: 'invalid-kubernetes-smoke-token',
      }),
    ),
  );
  socket.addEventListener('error', () => {
    clearTimeout(timeout);
    reject(new Error('WSS connection failed'));
  });
  socket.addEventListener('close', (event) => {
    clearTimeout(timeout);
    try {
      assert.equal(event.code, 4001, 'Gateway must accept proxy TLS and reject an invalid device token');
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
console.log('Public WSS routing, proxy TLS and device authentication: OK');
console.log('Administrator credentials: deploy/k8s/.local/admin.json (keep private)');
