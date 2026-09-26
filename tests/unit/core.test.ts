import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workflowSchema, agentSchema, connectionSchema } from '../../packages/core/src/schema.js';
import { render, evaluateCondition } from '../../packages/core/src/templates.js';
import { chunkText, sanitizeExtractedText } from '../../packages/core/src/chunking.js';
import { layoutWorkflow } from '../../apps/studio/src/workflowLayout.js';
import { validateToolArguments } from '../../packages/core/src/toolValidation.js';

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.SETUP_TOKEN = 'unit-test-setup-token'.repeat(3);
const {
  encrypt,
  decrypt,
  passwordHash,
  passwordMatches,
  privateAddress,
  validateRemoteUrl,
  hash,
  constantEqual,
} = await import('../../packages/core/src/security.js');
const { filePath } = await import('../../packages/core/src/storage.js');
const { toolAlias } = await import('../../packages/core/src/mcp.js');
const { resumeDecision } = await import('../../packages/core/src/runtime.js');

test('crashed runs resume only when the in-flight step cannot have acted externally', () => {
  const providerId = '11111111-1111-4111-8111-111111111111';
  const agent = (tools: string[]) =>
    agentSchema.parse({
      name: 'A',
      providerId,
      systemPrompt: 'x',
      connections: tools.length ? [{ connectionId: '22222222-2222-4222-8222-222222222222', tools }] : [],
    });
  const workflow = workflowSchema.parse({
    name: 'W',
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'plain' },
      { id: 'plain', name: 'Plain', type: 'agent', config: agent([]), next: 'tooled' },
      { id: 'tooled', name: 'Tooled', type: 'agent', config: agent(['lookup']), next: 'mail' },
      { id: 'mail', name: 'Mail', type: 'email', to: 'a@b.co', next: 'finish' },
      { id: 'finish', name: 'Finish', type: 'finish' },
    ],
  });
  const run = (cursor: string | undefined, extra: Record<string, unknown> = {}) =>
    ({
      snapshot: { workflow, agents: {}, nodeAgents: { plain: agent([]), tooled: agent(['lookup']) } },
      checkpoint: cursor ? { cursor, last: '', steps: 1, nodeAttempts: {} } : undefined,
      ...extra,
    }) as any;
  assert.equal(resumeDecision(run(undefined)).resume, true, 'nothing started yet');
  assert.equal(resumeDecision(run('plain')).resume, true, 'agent without tools');
  assert.equal(resumeDecision(run('tooled')).resume, false, 'agent with tools may have acted');
  assert.equal(resumeDecision(run('mail')).resume, false, 'email is an external action');
  assert.equal(resumeDecision(run('start')).resume, true);
  assert.equal(
    resumeDecision(
      run('tooled', {
        snapshot: { workflow: { ...workflow, resumePolicy: 'always' }, agents: {}, nodeAgents: {} },
      }),
    ).resume,
    true,
  );
  assert.equal(
    resumeDecision(
      run('plain', { snapshot: { workflow: { ...workflow, resumePolicy: 'never' }, agents: {} } }),
    ).resume,
    false,
  );
  assert.equal(resumeDecision(run('plain', { resumeCount: 3 })).resume, false, 'resume limit');
  const agentOnly = (tools: string[]) =>
    ({ agentId: 'a1', snapshot: { agents: { a1: agent(tools) } } }) as any;
  assert.equal(resumeDecision(agentOnly([])).resume, true);
  assert.equal(resumeDecision(agentOnly(['lookup'])).resume, false);
});

test('context compaction fits a dialog under budget without separating tool calls from their results', async () => {
  const { compactDialog, contextLimitFromError, dialogTokens, isContextLengthError, promptTokensFromError } =
    await import('../../packages/core/src/context.js');
  const big = 'x'.repeat(20000);
  const messages = [
    { role: 'system' as const, content: 'Be helpful.' },
    { role: 'user' as const, content: 'first question' },
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 't1', name: 'lookup', arguments: { q: 1 } }],
    },
    { role: 'tool' as const, content: big, toolCallId: 't1', name: 'lookup' },
    { role: 'assistant' as const, content: 'first answer' },
    { role: 'user' as const, content: 'second question' },
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 't2', name: 'lookup', arguments: { q: 2 } }],
    },
    { role: 'tool' as const, content: big, toolCallId: 't2', name: 'lookup' },
    { role: 'user' as const, content: 'current question' },
  ];
  const untouched = compactDialog(messages, 1_000_000);
  assert.equal(untouched.changed, false);
  const level1 = compactDialog(messages, 7000, 1);
  assert.equal(level1.changed, true);
  assert.match(level1.messages[3].content, /truncated/);
  assert.equal(level1.messages[7].content, big, 'the most recent tool result stays intact at level 1');
  const level2 = compactDialog(messages, 3000, 2);
  assert.equal(level2.messages[0].role, 'system');
  assert.equal(level2.messages.at(-1)!.content, 'current question');
  assert.ok(level2.messages.length < messages.length, 'older turns were dropped');
  for (const [i, m] of level2.messages.entries())
    if (m.role === 'tool')
      assert.equal(
        level2.messages[i - 1].toolCalls?.some((c) => c.id === m.toolCallId),
        true,
        'tool results follow their call',
      );
  assert.ok(dialogTokens(level2.messages) <= 3000);
  const level3 = compactDialog(
    [
      { role: 'system' as const, content: 'k'.repeat(50000) },
      { role: 'user' as const, content: 'q' },
    ],
    3000,
    3,
  );
  assert.ok(dialogTokens(level3.messages) <= 3000);
  assert.match(level3.messages[0].content, /trimmed/);
  assert.equal(isContextLengthError("This model's maximum context length is 32768 tokens."), true);
  assert.equal(isContextLengthError('Invalid API key'), false);
  assert.equal(contextLimitFromError("This model's maximum context length is 32768 tokens. However"), 32768);
  assert.equal(contextLimitFromError('prompt is too long'), undefined);
  assert.equal(
    promptTokensFromError(
      "This model's maximum context length is 32768 tokens. However, you requested 4096 output tokens and your prompt contains at least 28673 input tokens, for a total of at least 32769 tokens.",
    ),
    28673,
  );
  assert.equal(
    promptTokensFromError(
      'However, you requested 33000 tokens (28904 in the messages, 4096 in the completion).',
    ),
    28904,
  );
  assert.equal(promptTokensFromError('prompt is too long: 210000 tokens > 200000 maximum'), 210000);
  assert.equal(promptTokensFromError('context length exceeded'), undefined);
});
test('effort presets carry loop and token budgets, and auto resolves a level from the request', async () => {
  const { budgetedAgent, effortPresets, resolveEffort } = await import('../../packages/core/src/patterns.js');
  const { agentSchema } = await import('../../packages/core/src/schema.js');
  const base = agentSchema.parse({ name: 'A', providerId: randomUUID(), systemPrompt: 'Help.' });
  assert.equal(base.effort, 'medium');
  assert.equal(
    agentSchema.parse({ ...base, effort: 'low' }).effort,
    'light',
    'pre-release name maps to light',
  );
  assert.ok(effortPresets.light.tokenBudget < effortPresets.medium.tokenBudget);
  assert.ok(effortPresets.high.maxTurns < effortPresets['extra-high'].maxTurns);
  assert.ok(effortPresets['extra-high'].tokenBudget < effortPresets.max.tokenBudget);
  assert.equal(effortPresets.max.maxTurns, 120);
  assert.equal(agentSchema.safeParse({ ...base, maxTurns: 200, timeoutSeconds: 7200 }).success, true);
  assert.equal(agentSchema.safeParse({ ...base, maxTurns: 201 }).success, false);
  const tools = [{ connectionId: randomUUID(), tools: ['search'] }];
  assert.equal(resolveEffort({ effort: 'auto', pattern: 'react', connections: [] }, 'hi').level, 'light');
  assert.equal(resolveEffort({ effort: 'auto', pattern: 'react', connections: tools }, 'hi').level, 'medium');
  assert.equal(
    resolveEffort({ effort: 'auto', pattern: 'react', connections: tools }, 'x'.repeat(2000)).level,
    'high',
  );
  assert.equal(
    resolveEffort({ effort: 'auto', pattern: 'plan-execute', connections: [] }, 'hi').level,
    'medium',
  );
  assert.equal(resolveEffort({ effort: 'max', pattern: 'react', connections: [] }, 'hi').level, 'max');
  const fixed = budgetedAgent({ ...base, effort: 'high', maxTurns: 7 }, 'hi');
  assert.equal(fixed.maxTurns, 7, 'a fixed level keeps the stored (possibly overridden) limits');
  assert.equal(fixed.tokenBudget, effortPresets.high.tokenBudget);
  const auto = budgetedAgent({ ...base, effort: 'auto', connections: tools }, 'hi');
  assert.equal(auto.maxTurns, effortPresets.medium.maxTurns, 'auto applies the resolved preset');
  assert.equal(auto.resolvedEffort, 'medium');
});
test('schedules fire on fixed intervals or at a wall-clock time in the chosen time zone', async () => {
  const { nextScheduledAt, describeSchedule } = await import('../../packages/core/src/schedule.js');
  const from = new Date('2026-03-06T10:00:00Z'); // a Friday
  assert.equal(
    nextScheduledAt({ enabled: true, everyMinutes: 15, input: '' }, from).toISOString(),
    '2026-03-06T10:15:00.000Z',
  );
  // Daily at 09:00 in Berlin (UTC+1 in March): already past today, so tomorrow 08:00Z.
  const daily = nextScheduledAt(
    { enabled: true, everyMinutes: 1440, input: '', at: '09:00', timezone: 'Europe/Berlin' },
    from,
  );
  assert.equal(daily.toISOString(), '2026-03-07T08:00:00.000Z');
  // Daily at 18:30 UTC: still ahead today.
  assert.equal(
    nextScheduledAt(
      { enabled: true, everyMinutes: 1440, input: '', at: '18:30', timezone: 'UTC' },
      from,
    ).toISOString(),
    '2026-03-06T18:30:00.000Z',
  );
  // Weekly on Monday at 07:00 New York (UTC-5 before DST starts on March 8): Monday 9 March 11:00Z.
  const weekly = nextScheduledAt(
    { enabled: true, everyMinutes: 10080, input: '', at: '07:00', weekday: 1, timezone: 'America/New_York' },
    from,
  );
  assert.equal(weekly.toISOString(), '2026-03-09T11:00:00.000Z', 'DST change on the 8th is respected');
  assert.equal(describeSchedule({ enabled: true, everyMinutes: 1, input: '' }), 'Every minute');
  assert.equal(
    describeSchedule({ enabled: true, everyMinutes: 1440, input: '', at: '09:00' }),
    'Every day at 09:00',
  );
  assert.equal(describeSchedule(undefined), 'Off');
});
test('MCP tool argument validation catches enum and required-field mismatches before dispatch', () => {
  const schema = {
    type: 'object',
    properties: { topic: { type: 'string', enum: ['general'] }, query: { type: 'string' } },
    required: ['query'],
  };
  assert.equal(validateToolArguments(schema, { query: 'x', topic: 'general' }), null);
  assert.match(validateToolArguments(schema, { query: 'x', topic: 'news' })!, /topic/);
  assert.match(validateToolArguments(schema, { topic: 'general' })!, /query/);
  assert.equal(validateToolArguments(undefined, { anything: true }), null);
  assert.equal(validateToolArguments({}, { anything: true }), null);
});
test('credentials use authenticated encryption with fresh IVs and reject tampering', () => {
  const a = encrypt('private-token');
  const b = encrypt('private-token');
  assert.notEqual(a, b);
  assert.equal(decrypt(a), 'private-token');
  const parts = a.split('.');
  parts[2] = Buffer.from('wrong').toString('base64url');
  assert.throws(() => decrypt(parts.join('.')));
  assert.equal(a.includes('private-token'), false);
});
test('password hashes are salted and compare safely', async () => {
  const a = await passwordHash('a-long-test-password');
  const b = await passwordHash('a-long-test-password');
  assert.notEqual(a, b);
  assert.equal(await passwordMatches('a-long-test-password', a), true);
  assert.equal(await passwordMatches('wrong', a), false);
  assert.equal(await passwordMatches('bad', 'malformed'), false);
  assert.equal(constantEqual('token', 'token'), true);
  assert.equal(constantEqual('token', 'other'), false);
});
test('private endpoints and cloud metadata are blocked unless explicitly allowed', async () => {
  for (const address of [
    '127.0.0.1',
    '10.4.0.2',
    '172.16.1.4',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])
    assert.equal(privateAddress(address), true, address);
  assert.equal(privateAddress('8.8.8.8'), false);
  await assert.rejects(validateRemoteUrl('http://127.0.0.1/secrets'));
  await assert.rejects(validateRemoteUrl('http://169.254.169.254/latest/meta-data'));
  await assert.rejects(validateRemoteUrl('file:///etc/passwd'));
});
test('file keys cannot escape their owner directories', () => {
  assert.match(
    filePath('00000000-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111'),
    /files/,
  );
  assert.throws(() => filePath('../../etc/passwd'));
  assert.throws(() => filePath('/etc/passwd'));
});
test('workflow validation rejects missing targets, unreachable nodes, duplicates and cycles', () => {
  const valid = {
    name: 'Simple',
    startAt: 'answer',
    nodes: [{ id: 'answer', name: 'Answer', type: 'output', template: '{{input}}' }],
  };
  assert.equal(workflowSchema.safeParse(valid).success, true);
  assert.equal(workflowSchema.safeParse({ ...valid, startAt: 'missing' }).success, false);
  assert.equal(
    workflowSchema.safeParse({ ...valid, nodes: [...valid.nodes, ...valid.nodes] }).success,
    false,
  );
  assert.equal(
    workflowSchema.safeParse({ ...valid, nodes: [...valid.nodes, { ...valid.nodes[0], id: 'unused' }] })
      .success,
    false,
  );
  assert.equal(
    workflowSchema.safeParse({
      name: 'Loop',
      startAt: 'branch',
      nodes: [
        {
          id: 'branch',
          name: 'Branch',
          type: 'condition',
          value: '{{input}}',
          operator: 'truthy',
          compare: '',
          onTrue: 'branch',
          onFalse: 'branch',
        },
      ],
    }).success,
    false,
  );
});
test('templates preserve structured values and prohibit code execution and prototype access', () => {
  const scope = { input: 'hello', last: { count: 3 }, steps: { task: ['a', 'b'] } };
  assert.deepEqual(render('{{last}}', scope), { count: 3 });
  assert.deepEqual(render({ text: '{{input}}', list: '{{steps.task}}' }, scope), {
    text: 'hello',
    list: ['a', 'b'],
  });
  assert.equal(render('Result: {{last.count}}', scope), 'Result: 3');
  assert.throws(() => render('{{steps.constructor}}', scope));
  assert.throws(() => render('{{steps.missing}}', scope));
  assert.equal(render('{{process.exit()}}', scope), '{{process.exit()}}');
  assert.equal(
    evaluateCondition(
      {
        id: 'test',
        type: 'condition',
        name: 'Test',
        value: '{{last.count}}',
        compare: '2',
        operator: 'greaterThan',
        onTrue: 'yes',
        onFalse: 'no',
      },
      scope,
    ),
    true,
  );
});
test('MCP is the only connection kind; shell transports and credential URLs are rejected', () => {
  assert.equal(connectionSchema.safeParse({ name: 'Server', url: 'file:///etc/passwd' }).success, false);
  assert.equal(
    connectionSchema.safeParse({ name: 'Server', url: 'https://a:b@example.com/mcp' }).success,
    false,
  );
  assert.equal(
    connectionSchema.safeParse({ name: 'Server', url: 'https://example.com/mcp', transport: 'stdio' })
      .success,
    false,
  );
  assert.notEqual(toolAlias('one', 'do.work'), toolAlias('one', 'do_work'));
  assert.notEqual(toolAlias('one', 'echo'), toolAlias('two', 'echo'));
});
test('document chunking retains content, bounds chunks, and removes embedded base64', () => {
  const text = Array.from(
    { length: 600 },
    (_, i) => `Paragraph ${i} describes a unique project and its useful operational knowledge.\n\n`,
  ).join('');
  const chunks = chunkText(text);
  assert.ok(chunks.length > 20);
  assert.ok(chunks.every((c) => c.length <= 1200));
  assert.ok(chunks.join('\n').includes('Paragraph 599'));
  assert.equal(sanitizeExtractedText('Before ![photo](data:image/png;base64,AAAA) after'), 'Before after');
});
test('layout places graph cards without changing links or dropping nodes', () => {
  const nodes = [
    { id: 'start', x: 0, y: 0 },
    { id: 'agent', x: 0, y: 0 },
    { id: 'tool', x: 0, y: 0 },
    { id: 'end', x: 0, y: 0 },
  ];
  const result = layoutWorkflow(
    nodes,
    [
      { from: 'start', to: 'agent' },
      { from: 'agent', to: 'tool', label: 'tool' },
      { from: 'agent', to: 'end' },
    ],
    () => ({ width: 250, height: 150 }),
    'start',
  );
  assert.equal(result.length, 4);
  assert.equal(new Set(result.map((n) => `${n.x},${n.y}`)).size, 4);
  assert.ok(result.find((n) => n.id === 'end')!.x > result.find((n) => n.id === 'start')!.x);
});

const workspaceModule = await import('../../packages/core/src/workspace.js');
test('workspace notes carry provenance and live in clean folders', () => {
  const note = workspaceModule.agentNote({
    title: 'Pricing',
    kind: 'decision',
    content: 'Use tiered pricing.',
    runId: 'run-1',
    agent: 'Planner',
    sources: ['https://example.com'],
    confidence: 0.7,
    reasons: 'Customers asked for it.',
  });
  assert.equal(note.meta.kind, 'decision');
  assert.equal(note.meta.run_id, 'run-1');
  assert.match(note.text, /^---\nkind: decision\n/);
  assert.match(
    note.text,
    /# Pricing\n\nUse tiered pricing\.\n\n\*\*Reasons:\*\* Customers asked for it\.\n$/,
  );
  assert.equal(workspaceModule.cleanFolder('/Research//Q3 Notes/'), 'research/q3-notes');
  assert.equal(workspaceModule.cleanFolder('../../etc'), 'etc');
  assert.equal(workspaceModule.notePath({ folder: 'research', filename: 'A.md' }), 'research/A.md');
  assert.equal(workspaceModule.notePath({ filename: 'A.md' }), 'A.md');
  assert.equal(workspaceModule.folderFor.finding, 'research');
});

const subagents = await import('../../packages/core/src/subagents.js');
test('sub-agent budgets split 80% of what is left, capped by each effort preset', () => {
  assert.deepEqual(subagents.childBudgets(100_000, [{ task: 'a' }, { task: 'b' }]), [30_000, 30_000]);
  assert.deepEqual(
    subagents.childBudgets(50_000, [{ task: 'a' }, { task: 'b', effort: 'high' }]),
    [20_000, 20_000],
  );
  assert.deepEqual(subagents.childBudgets(1_000_000, [{ task: 'a', effort: 'high' }]), [400_000]);
  assert.deepEqual(subagents.childBudgets(-5, [{ task: 'a' }]), [0]);
});
test('a sub-agent gets a fresh prompt, the chosen skill and only the requested tools', () => {
  const parent = agentSchema.parse({
    name: 'Lead',
    systemPrompt: 'Lead the work.',
    providerId: randomUUID(),
    connections: [{ connectionId: randomUUID(), tools: ['lookup', 'calculate'] }],
  });
  parent.skills = [
    {
      id: randomUUID(),
      name: 'Checklist',
      description: 'd',
      instructions: 'Use the checklist.',
      enabled: true,
    },
  ];
  const child = subagents.childAgent(
    parent,
    { task: 'Find prices', skill: 'Checklist', tools: ['lookup'], effort: 'medium' },
    12_000,
    true,
  );
  assert.equal(child.connections[0].tools.join(), 'lookup');
  assert.equal(child.tokenBudget, 12_000);
  assert.equal(child.effort, 'medium');
  assert.equal(child.delegation, undefined, 'sub-agents are never delegators');
  assert.match(child.systemPrompt, /sub-agent working for "Lead"/);
  assert.match(child.systemPrompt, /<skill>\nUse the checklist\.\n<\/skill>/);
  assert.match(child.systemPrompt, /kb_write/);
  assert.match(child.systemPrompt, /Lead the work/, 'the parent operating instructions remain in force');
  assert.throws(
    () => subagents.childAgent(parent, { task: 'x', skill: 'Missing' }, 5000, false),
    /Unknown skill/,
  );
  const all = subagents.childAgent(parent, { task: 'x' }, 5000, false);
  assert.deepEqual(all.connections[0].tools, ['lookup', 'calculate']);
});
