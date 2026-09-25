import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketClientTransport, type WebSocketLike } from '../src/wsClientTransport.js';
import { WebSocketServerTransport } from '../src/wsServerTransport.js';
import { CloseCode } from '../src/frames.js';

/** An in-memory WebSocket that the test drives by hand. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  closedWith?: number;
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
    this.emit('close', { code, reason: '' });
  }
  addEventListener(type: string, listener: (e: any) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, event: any = {}) {
    for (const l of this.listeners[type] ?? []) l(event);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  receive(frame: object | string) {
    this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
}
const welcome = {
  type: 'welcome',
  session_id: 'sess-1',
  heartbeat_seconds: 30,
  resumed: false,
  server_time: 'now',
};
const identity = {
  device_id: 'dev-1',
  platform: 'linux' as const,
  hostname: 'h',
  connector_version: '0.1.0',
  capabilities: ['x'],
};

test('client transport: hello on open, MCP after welcome, resume and backoff on reconnect', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeSocket.instances = [];
  const states: string[] = [];
  const received: unknown[] = [];
  const t = new WebSocketClientTransport({
    url: 'wss://gateway.test/connect',
    identity,
    token: 'dv_0123456789abcdef',
    WebSocketImpl: FakeSocket as any,
    random: () => 0,
    onStateChange: (s) => states.push(s),
  });
  t.onmessage = (m) => received.push(m);
  await t.start();
  const s1 = FakeSocket.instances[0];
  assert.deepEqual(s1.protocols, ['agentic-mcp.v1']);
  await assert.rejects(t.send({ jsonrpc: '2.0', method: 'x' } as any), /not connected/);
  s1.open();
  const hello = JSON.parse(s1.sent[0]);
  assert.equal(hello.type, 'hello');
  assert.equal(hello.token, 'dv_0123456789abcdef');
  assert.equal(hello.resume, undefined);
  // RPC before welcome is a protocol error.
  s1.receive({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(s1.closedWith, CloseCode.PROTOCOL_ERROR);
  // Reconnect is scheduled with backoff (attempt 0 → 500 ms with random=0).
  assert.equal(FakeSocket.instances.length, 1);
  mock.timers.tick(499);
  assert.equal(FakeSocket.instances.length, 1);
  mock.timers.tick(1);
  assert.equal(FakeSocket.instances.length, 2);
  const s2 = FakeSocket.instances[1];
  s2.open();
  s2.receive(welcome);
  assert.equal(t.sessionId, 'sess-1');
  assert.equal(t.state, 'connected');
  s2.receive({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
  assert.equal((received[0] as any).id, 7);
  await t.send({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
  assert.equal(JSON.parse(s2.sent.at(-1)!).id, 7);
  // Heartbeats go out every 30 s while connected.
  mock.timers.tick(30_000);
  assert.ok(s2.sent.some((f) => f === '{"type":"heartbeat"}'));
  // Server drops the socket: the next hello carries the session id for resume.
  s2.close(1001);
  assert.equal(t.state, 'disconnected');
  mock.timers.tick(60_000);
  const s3 = FakeSocket.instances[2];
  s3.open();
  assert.deepEqual(JSON.parse(s3.sent[0]).resume, { session_id: 'sess-1' });
  // A forbidden close is fatal: no further sockets.
  s3.close(CloseCode.FORBIDDEN);
  mock.timers.tick(120_000);
  assert.equal(FakeSocket.instances.length, 3);
  assert.equal(t.state, 'stopped');
  assert.deepEqual(states.at(-1), 'stopped');
  mock.timers.reset();
});
test('client transport refuses insecure URLs and credentials in the URL', () => {
  assert.throws(
    () =>
      new WebSocketClientTransport({
        url: 'ws://gw/connect',
        identity,
        token: 't'.repeat(20),
        WebSocketImpl: FakeSocket as any,
      }),
    /wss/,
  );
  assert.throws(
    () =>
      new WebSocketClientTransport({
        url: 'wss://gw/connect?token=x',
        identity,
        token: 't'.repeat(20),
        WebSocketImpl: FakeSocket as any,
      }),
    /Credentials/,
  );
  assert.ok(
    new WebSocketClientTransport({
      url: 'ws://localhost:8090/connect',
      identity,
      token: 't'.repeat(20),
      allowInsecure: true,
      WebSocketImpl: FakeSocket as any,
    }),
  );
});
test('server transport answers heartbeats, forwards JSON-RPC and closes on protocol errors', async () => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const sent: string[] = [];
  let closed: number | undefined;
  const socket = {
    readyState: 1,
    send: (data: string, cb?: (e?: Error) => void) => {
      sent.push(data);
      cb?.();
    },
    close: (code?: number) => {
      closed = code;
      for (const h of handlers.close ?? []) h(code, '');
    },
    on: (event: string, listener: (...a: any[]) => void) => (handlers[event] ??= []).push(listener),
  };
  const t = new WebSocketServerTransport(socket as any, 'sess-1');
  const messages: unknown[] = [];
  let activity = 0;
  t.onmessage = (m) => messages.push(m);
  t.onactivity = () => activity++;
  await t.start();
  handlers.message[0]('{"type":"heartbeat"}', false);
  assert.match(sent[0], /heartbeat_ack/);
  handlers.message[0](Buffer.from('{"jsonrpc":"2.0","id":3,"result":{}}'), false);
  assert.equal((messages[0] as any).id, 3);
  assert.equal(activity, 2);
  await t.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
  assert.equal(JSON.parse(sent[1]).method, 'ping');
  let closeEvents = 0;
  t.onclose = () => closeEvents++;
  handlers.message[0]('{"type":"hello"}', false);
  assert.equal(closed, CloseCode.PROTOCOL_ERROR);
  assert.equal(closeEvents, 1, 'onclose fires exactly once');
});
