import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection, db } from '../../../../packages/core/src/db.js';
import { config } from '../../../../packages/core/src/config.js';
import { harnessVersion } from './harness.js';
import { workspace } from './resources.js';
import { notFound, OhError } from './errors.js';
import { pageOf, pageQuery, type Operation, type OperationRegistry } from './operations.js';
import { specRoutes } from './spec.js';
import { harnessId } from './scope.js';
export function diagnosticOperations(registry: OperationRegistry): Operation[] {
  const scope = (req: any) => ({ ownerId: workspace(req), harnessId: harnessId(req) });
  const latest = async (req: any) => {
    const s = scope(req);
    const row = await collection('conformance_runs')
      .find({ ...s, ...(req.query.run_id ? { _id: String(req.query.run_id) } : {}) })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (!row) throw notFound('Conformance run');
    return row;
  };
  const logRows = async (req: any) => {
    const ownerId = workspace(req);
    const q = pageQuery
      .extend({
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        since: z.string().datetime().optional(),
      })
      .parse(req.query);
    const rows = await collection('runs')
      .find(
        {
          ownerId,
          ...(req.harness ? { workflowId: req.harness._id } : {}),
          ...(q.since ? { updatedAt: { $gte: new Date(q.since) } } : {}),
        },
        { projection: { status: 1, createdAt: 1, updatedAt: 1 } },
      )
      .sort({ updatedAt: -1 })
      .limit(1000)
      .toArray();
    return {
      q,
      rows: rows
        .map((r) => ({
          timestamp: r.updatedAt.toISOString(),
          level: r.status === 'failed' ? 'error' : 'info',
          message: `Execution ${r.status}`,
          context: { execution_id: r._id },
        }))
        .filter((r) => !q.level || r.level === q.level),
    };
  };
  return [
    {
      id: 'diagnostics.get',
      handler: async (req) => {
        const ownerId = workspace(req),
          filter = { ownerId, ...(req.harness ? { workflowId: req.harness._id } : {}) };
        return {
          harness_id: harnessId(req),
          version: harnessVersion,
          uptime_seconds: Math.floor(process.uptime()),
          memory_usage_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          active_sessions: await collection('conversations').countDocuments({ ...filter, status: 'active' }),
          active_executions: await collection('runs').countDocuments({
            ...filter,
            status: { $in: ['queued', 'running', 'waiting_for_human'] },
          }),
          connected_mcp_servers: await collection('connections').countDocuments({
            ownerId,
            enabled: true,
            lastCheckedAt: { $exists: true },
          }),
          installed_skills: await collection('skills').countDocuments({ ownerId, enabled: true }),
          config: { spec_version: '0.2.0', base_path: config.OPENHARNESS_BASE_PATH },
        };
      },
    },
    {
      id: 'diagnostics.logs',
      handler: async (req) => {
        const { q, rows } = await logRows(req);
        return pageOf(rows, q);
      },
    },
    {
      id: 'diagnostics.streamLogs',
      handler: async (req, res) => {
        await logRows(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        const sent = new Set<string>();
        let busy = false;
        const tick = async () => {
          if (busy) return;
          busy = true;
          try {
            for (const row of (await logRows(req)).rows.reverse()) {
              const id = `${row.context.execution_id}:${row.timestamp}`;
              if (!sent.has(id)) {
                sent.add(id);
                res.write(`id: ${id}\ndata: ${JSON.stringify(row)}\n\n`);
              }
            }
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(() => void tick().catch(() => {}), 1000),
          end = setTimeout(() => res.end(), 30 * 60000);
        res.on('close', () => {
          clearInterval(timer);
          clearTimeout(end);
        });
        await tick();
      },
    },
    {
      id: 'conformance.run',
      handler: async (req, res) => {
        const s = scope(req);
        const b = z
          .object({
            categories: z.array(z.enum(['routes', 'capabilities', 'storage'])).optional(),
            quick: z.boolean().default(true),
          })
          .parse(req.body ?? {});
        const started = Date.now(),
          events: any[] = [],
          categories = b.categories ?? ['routes', 'capabilities', 'storage'];
        let passed = 0,
          failed = 0,
          skipped = 0;
        const check = async (id: string, fn: () => unknown) => {
          events.push({ type: 'test.started', test_id: id, test_name: id });
          try {
            await fn();
            passed++;
            events.push({ type: 'test.passed', test_id: id });
          } catch {
            failed++;
            events.push({ type: 'test.failed', test_id: id, error: 'Protocol check failed' });
          }
          events.push({ type: 'progress', completed: passed + failed, total: passed + failed });
        };
        if (categories.includes('routes'))
          for (const route of specRoutes.filter(
            (r) => !['tools.register', 'tools.unregister'].includes(r.id),
          ))
            await check(route.id, () => {
              if (!registry.has(route.id) && route.method !== 'ws') throw new Error('Route unimplemented');
            });
        if (categories.includes('capabilities'))
          await check('capabilities.manifest', () => {
            const m = registry.manifest();
            if (
              !Object.values(m).every((d) => typeof d.supported === 'boolean' && Array.isArray(d.operations))
            )
              throw new Error('Invalid manifest');
          });
        if (categories.includes('storage')) await check('storage.ping', () => db.command({ ping: 1 }));
        skipped += categories.includes('routes') ? 2 : 0;
        const row = {
          _id: randomUUID(),
          ...s,
          createdAt: new Date(),
          harness_version: harnessVersion,
          result: failed ? 'fail' : 'partial',
          passed,
          failed,
          skipped,
          duration_ms: Date.now() - started,
          events,
          golden_rule_violations: 0,
          suite: 'runtime-protocol-checks',
          note: 'Read-only runtime checks. Full upstream behavioral conformance runs in isolated CI; this is not certification.',
        };
        await collection('conformance_runs').insertOne(row);
        res.status(202).json({
          run_id: row._id,
          status: 'completed',
          stream_url: `${config.OPENHARNESS_BASE_PATH}/harnesses/${s.harnessId}/conformance/run/stream?run_id=${row._id}`,
        });
      },
    },
    {
      id: 'conformance.stream',
      handler: async (req, res) => {
        const row = await latest(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of row.events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end(
          `event: done\ndata: ${JSON.stringify({ type: 'done', result: { passed: row.passed, failed: row.failed, skipped: row.skipped, duration_ms: row.duration_ms } })}\n\n`,
        );
      },
    },
    {
      id: 'conformance.results',
      handler: async (req) =>
        pageOf(
          (
            await collection('conformance_runs')
              .find(scope(req))
              .sort({ createdAt: -1 })
              .limit(1000)
              .toArray()
          ).map((r) => ({
            id: r._id,
            harness_version: r.harness_version,
            result: r.result,
            passed: r.passed,
            failed: r.failed,
            skipped: r.skipped,
            golden_rule_violations: r.golden_rule_violations,
            run_at: r.createdAt.toISOString(),
            'x-openharness': { suite: r.suite, note: r.note },
          })),
          pageQuery.parse(req.query),
        ),
    },
    {
      id: 'conformance.status',
      handler: async (req) => {
        const rows = await collection('conformance_runs')
          .find(scope(req))
          .sort({ createdAt: -1 })
          .limit(1)
          .toArray();
        const r = rows[0];
        return {
          status: !r ? 'not_tested' : r.failed ? 'failing' : 'partial',
          pass_rate: r ? r.passed / Math.max(1, r.passed + r.failed) : 0,
          ...(r ? { last_run_at: r.createdAt.toISOString() } : {}),
          skill_loading_method: 'api',
          supports_file_gen: true,
          golden_rule_compliant: false,
          'x-openharness': {
            note: 'Runtime protocol checks do not certify upstream behavioral conformance. See CI conformance results.',
          },
        };
      },
    },
  ];
}
