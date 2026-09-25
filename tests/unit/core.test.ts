import { test } from 'node:test';
import assert from 'node:assert/strict';
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
