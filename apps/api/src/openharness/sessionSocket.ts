import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import { config } from '../../../../packages/core/src/config.js';
import { collection } from '../../../../packages/core/src/db.js';
import { requestCancel } from '../../../../packages/core/src/runs.js';
import type { Run } from '../../../../packages/core/src/schema.js';
import { authenticate } from '../auth.js';
import { resolveHarness } from './scope.js';
import { sessionFor, sessionMessage } from './sessions.js';
import { EventTranslator, closingEvents, isTerminal, unsentOutput } from './events.js';
import { executionOperations } from './execution.js';
import { OperationRegistry } from './operations.js';
export function attachSessionSockets(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', async (raw, socket, head) => {
    const url = new URL(raw.url ?? '/', 'http://localhost');
    const prefix = config.OPENHARNESS_BASE_PATH + '/harnesses/';
    const parts = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).split('/') : [];
    const reject = (status = 401) => {
      socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (parts.length !== 4 || parts[1] !== 'sessions' || parts[3] !== 'connect') return reject(404);
    const req = raw as Request;
    req.params = { harnessId: parts[0], sessionId: parts[2] };
    req.cookies = Object.fromEntries((raw.headers.cookie ?? '').split(';').map((s) => s.trim().split('=')));
    req.body = {};
    if (!raw.headers.authorization && raw.headers.origin !== new URL(config.PUBLIC_URL).origin)
      return reject(403);
    let accepted = false;
    const fake = {
      status() {
        return this;
      },
      json() {
        reject();
      },
      end() {
        reject();
      },
    } as unknown as Response;
    try {
      await authenticate(req, fake, (error) => {
        accepted = !error;
      });
      if (!accepted) return;
      await resolveHarness(req);
      const s = await sessionFor(req, 'execute');
      if (s.status !== 'active') return reject(409);
      wss.handleUpgrade(raw, socket, head, (ws) => {
        let busy = false,
          closed = false,
          alive = true;
        const send = (data: unknown) => {
          if (ws.readyState !== ws.OPEN) return;
          if (ws.bufferedAmount >= 1024 * 1024) {
            ws.close(1013, 'Consumer too slow; read execution result');
            return;
          }
          ws.send(JSON.stringify(data));
        };
        const refreshAuth = async () => {
          let valid = false;
          const response = {
            status() {
              return this;
            },
            json() {},
            end() {},
          } as unknown as Response;
          await authenticate(req, response, (error) => {
            valid = !error;
          });
          if (!valid) ws.close(1008, 'Authentication expired or revoked');
          return valid;
        };
        ws.on('pong', () => {
          alive = true;
        });
        const timer = setInterval(async () => {
          try {
            if (!(await refreshAuth())) return;
            if (!alive) {
              ws.terminate();
              return;
            }
            alive = false;
            const current = await sessionFor(req);
            if (current.status !== 'active') ws.close(1000, 'Session is not active');
            else ws.ping();
          } catch {
            ws.close(1008, 'Session unavailable');
          }
        }, 15000);
        ws.on('close', () => {
          closed = true;
          clearInterval(timer);
        });
        ws.on('error', () => ws.close());
        ws.on('message', async (bytes) => {
          let id = '';
          try {
            if (!(await refreshAuth())) return;
            const b = JSON.parse(bytes.toString());
            id = typeof b.id === 'string' ? b.id.slice(0, 200) : '';
            if (b.type === 'cancel') {
              const run = await collection<Run>('runs').findOne({
                _id: String(b.execution_id),
                ownerId: req.principal!.tenantId,
                conversationId: s._id,
              });
              if (!run) throw new Error('Execution does not belong to this session');
              await requestCancel({ _id: run._id, ownerId: run.ownerId });
              return;
            }
            if (b.type === 'stdin') {
              const current = await sessionFor(req, 'execute');
              if (!current.pending) throw new Error('No active execution');
              const inputReq = Object.assign(Object.create(req), {
                params: { ...req.params, executionId: current.pending.runId },
                body: { data: b.data },
              });
              const op = executionOperations(new OperationRegistry()).find(
                (o) => o.id === 'execution.sendInput',
              )!;
              await op.handler(inputReq, fake);
              return;
            }
            if (b.type !== 'message') throw new Error('Unknown session message type');
            if (busy) throw new Error('Wait for the current turn');
            busy = true;
            try {
              let run = await sessionMessage(req, b.content);
              const translator = new EventTranslator(run);
              let consumed = 0,
                sent = 0,
                segment = '';
              while (!closed) {
                const partial = run.partial ?? '';
                if (partial.length < sent || !partial.startsWith(segment)) {
                  sent = 0;
                  segment = '';
                }
                if (partial.length > sent) {
                  send({ type: 'text', id, content: partial.slice(sent) });
                  sent = partial.length;
                  segment = partial;
                }
                while (consumed < run.events.length) {
                  const at = consumed++;
                  for (const event of translator.translate(run.events[at], at)) {
                    if (event.type === 'tool_call_start')
                      send({ type: 'tool_call', id, tool: event.name, input: event.input });
                    else if (event.type === 'tool_result')
                      send({
                        type: event.success ? 'stdout' : 'stderr',
                        id,
                        data: JSON.stringify(event.output),
                      });
                    else if (event.type === 'progress' && run.events[at].type === 'human_requested')
                      send({ type: 'prompt', id, prompt: run.events[at].message });
                  }
                }
                if (isTerminal(run.status)) {
                  if (run.status === 'succeeded') {
                    const rest = unsentOutput(run.output ?? '', segment, sent);
                    if (rest) send({ type: 'text', id, content: rest });
                  }
                  for (const e of closingEvents(run, translator.usage))
                    send({ ...e, id, execution_id: run._id });
                  break;
                }
                await new Promise((r) => setTimeout(r, 300));
                const next = await collection<Run>('runs').findOne({ _id: run._id, ownerId: run.ownerId });
                if (!next) break;
                run = next;
              }
            } finally {
              busy = false;
            }
          } catch (e) {
            send({
              type: 'error',
              id,
              code: 'SESSION_ERROR',
              message: e instanceof Error ? e.message : 'Session request failed',
            });
          }
        });
      });
    } catch {
      reject(403);
    }
  });
  server.on('close', () => wss.close());
}
