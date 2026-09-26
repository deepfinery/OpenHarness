import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  resolveNotebook,
  memorySettings,
  notebookTargets,
  runNotebookIds,
} from '../../packages/core/src/notebooks.js';
import { agentSchema, type Run } from '../../packages/core/src/schema.js';

const notebook = (knowledgeBaseId: string) => ({ knowledgeBaseId, offloadToolResults: true });
test('notebook resolution preserves explicit choices and makes a knowledge attachment writable', () => {
  const attached = randomUUID(),
    inherited = randomUUID(),
    dedicated = randomUUID();
  assert.equal(resolveNotebook({ knowledgeBaseIds: [attached] }).workspace?.knowledgeBaseId, attached);
  assert.equal(resolveNotebook({ knowledgeBaseIds: [attached] }).experience?.enabled, true);
  assert.equal(
    resolveNotebook({ knowledgeBaseIds: [attached] }, { workspace: notebook(inherited) }).workspace
      ?.knowledgeBaseId,
    inherited,
  );
  assert.equal(
    resolveNotebook(
      { workspace: notebook(dedicated), knowledgeBaseIds: [attached] },
      { workspace: notebook(inherited) },
    ).workspace?.knowledgeBaseId,
    dedicated,
  );
  assert.equal(
    resolveNotebook({
      knowledgeBaseIds: [attached],
      experience: { enabled: false, recallLimit: 3, learnFromFailures: false },
    }).experience?.enabled,
    false,
  );
  assert.equal(resolveNotebook().workspace, undefined);
});

test('standalone, compiled resource and legacy agent notebooks all participate in durable memory', () => {
  const knowledgeBaseId = randomUUID();
  const agent = agentSchema.parse({
    name: 'Notebook',
    providerId: randomUUID(),
    systemPrompt: 'Help',
    knowledgeBaseIds: [knowledgeBaseId],
  });
  const standalone = { agentId: 'a', snapshot: { agents: { a: agent } } } as unknown as Run;
  assert.equal(memorySettings(standalone).workspace?.knowledgeBaseId, knowledgeBaseId);
  assert.deepEqual(runNotebookIds(standalone), [knowledgeBaseId]);
  const flow = {
    snapshot: { workflow: {}, nodeAgents: { node: agent }, agents: { legacy: agent } },
  } as unknown as Run;
  assert.equal(notebookTargets(flow).length, 2);
  assert.deepEqual(runNotebookIds(flow), [knowledgeBaseId]);
});

test('an existing explicit workspace keeps feedback learning opt-in', () => {
  const inherited = resolveNotebook({ workspace: notebook(randomUUID()) });
  assert.equal(inherited.experience?.enabled, false);
  assert.equal(resolveNotebook({ knowledgeBaseIds: [randomUUID()] }, inherited).experience?.enabled, false);
});
