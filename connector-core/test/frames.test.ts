import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloseCode, FrameError, parseFrame } from '../src/frames.js';
import { backoffDelay } from '../src/backoff.js';

const hello = {
  type: 'hello',
  protocol_version: 1,
  device_id: 'laptop-1',
  platform: 'linux',
  hostname: 'laptop-1.lan',
  token: 'dv_0123456789abcdef',
  connector_version: '0.1.0',
  capabilities: ['run_command'],
};
test('frames: hello, welcome, heartbeat and JSON-RPC are recognised; everything else is a protocol error', () => {
  assert.equal(parseFrame(JSON.stringify(hello)).kind, 'hello');
  assert.equal(parseFrame(JSON.stringify({ ...hello, resume: { session_id: 's1' } })).kind, 'hello');
  assert.equal(
    parseFrame(
      JSON.stringify({
        type: 'welcome',
        session_id: 's',
        heartbeat_seconds: 30,
        resumed: false,
        server_time: 'x',
      }),
    ).kind,
    'welcome',
  );
  assert.equal(parseFrame('{"type":"heartbeat"}').kind, 'heartbeat');
  const rpc = parseFrame('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
  assert.equal(rpc.kind, 'rpc');
  assert.throws(() => parseFrame('not json'), FrameError);
  assert.throws(() => parseFrame('[1,2]'), FrameError);
  assert.throws(() => parseFrame('{"type":"mystery"}'), FrameError);
  assert.throws(() => parseFrame('{"hello":"world"}'), FrameError);
  const bad = (frame: object, code: number) => {
    try {
      parseFrame(JSON.stringify(frame));
      assert.fail('should throw');
    } catch (e) {
      assert.equal((e as FrameError).code, code);
    }
  };
  bad({ ...hello, protocol_version: 2 }, CloseCode.UNSUPPORTED_VERSION);
  bad({ ...hello, device_id: 'Bad Id' }, CloseCode.UNAUTHENTICATED);
  bad({ ...hello, token: 'short' }, CloseCode.UNAUTHENTICATED);
  bad({ ...hello, platform: 'amiga' }, CloseCode.UNAUTHENTICATED);
});
test('backoff grows from ~1 s to a 60 s cap with jitter inside each step', () => {
  const low = (n: number) => backoffDelay(n, { random: () => 0 });
  const high = (n: number) => backoffDelay(n, { random: () => 0.999 });
  assert.equal(low(0), 500);
  assert.ok(high(0) < 1000);
  assert.equal(low(1), 1000);
  assert.equal(low(5), 16000);
  assert.equal(low(6), 30000, 'attempt 6 already hits the 60 s cap');
  assert.equal(low(10), 30000, 'capped at 60 s: lower bound 30 s');
  assert.ok(high(10) < 60000);
  assert.ok(high(100) < 60000, 'huge attempts do not overflow');
});
