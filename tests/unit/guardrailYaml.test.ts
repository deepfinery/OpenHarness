import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stringify, parse } from 'yaml';
import { guardrailTemplates } from '../../packages/core/src/guardrailTemplates.js';
import {
  guardrailYaml,
  parseGuardrailYaml,
  guardrailYamlMaxBytes,
  guardrailYamlFilename,
} from '../../packages/core/src/guardrailYaml.js';

test('all six YAML source files round-trip every policy field without drift', async () => {
  for (const t of guardrailTemplates) {
    const source = await readFile(`guardrails/templates/${t.id}.yaml`, 'utf8');
    assert.deepEqual(parseGuardrailYaml(source), t.policy);
    assert.deepEqual(parseGuardrailYaml(guardrailYaml(t.policy)), t.policy);
    const changed = {
      ...t.policy,
      name: 'Edited: #policy',
      enabled: false,
      description: 'Multiline\nwith unicode 🌱',
      deniedTerms: ['false', 'yes', '2026-09-26'],
      deniedTools: ['gpu_reset'],
      argumentRules: [{ tool: 'run_command', path: 'argv', operator: 'contains' as const, value: '--reset' }],
    };
    assert.deepEqual(parseGuardrailYaml(guardrailYaml(changed)), changed);
  }
});

test('invalid or unsafe YAML fails instead of dropping policy settings', () => {
  const valid = guardrailYaml(guardrailTemplates[0].policy);
  for (const invalid of [
    valid + '\n---\nmodels: []',
    valid + '\nmodels: []',
    valid + '\nunknown_setting: true',
    valid + '\nactions_server_url: http://untrusted.example',
    valid + '\nimport_paths: [/etc]',
    valid.replace('models: []', 'models: &items []'),
    valid.replace('models: []', 'models: *items'),
    valid.replace('models: []', 'models: !!python/object {}'),
    valid.replace('version: 1', 'version: 2'),
    valid.replace('pii: false', 'pii: "false"'),
    valid.replace('pii: false', 'pii: false\n      pii_typo: true'),
    valid.replace('openharness policy', 'untrusted flow'),
    valid.replace('semanticChecks: true', 'semanticChecks: false'),
  ])
    assert.throws(() => parseGuardrailYaml(invalid));
  assert.throws(() => parseGuardrailYaml('#'.repeat(guardrailYamlMaxBytes + 1)), /256 KiB/);
  assert.throws(() => parseGuardrailYaml('['.repeat(50) + '0' + ']'.repeat(50)), /deeply nested/);
});

test('YAML rules reject unknown nested fields and defaults retain safety checks', () => {
  const doc = parse(guardrailYaml(guardrailTemplates[5].policy));
  doc.custom_data.openharness.policy.argumentRules = [
    { tool: 'run_command', path: 'argv', operator: 'contains', value: '--reset', ignore: true },
  ];
  assert.throws(() => parseGuardrailYaml(stringify(doc)), /Unrecognized key/);
  doc.custom_data.openharness.policy = { name: 'Minimal' };
  const policy = parseGuardrailYaml(stringify(doc));
  assert.equal(policy.failMode, 'closed');
  assert.equal(policy.pii, true);
  assert.equal(policy.jailbreak, true);
});

test('exports exclude database identity, ownership, and credentials', () => {
  const source = guardrailYaml({
    ...guardrailTemplates[0].policy,
    id: 'private-id',
    ownerId: 'private-owner',
    apiKey: 'private-key',
  } as any);
  assert.ok(!source.includes('private-'));
  assert.equal(guardrailYamlFilename('../../policy\r\nX-Header: yes'), 'policy-x-header-yes.yaml');
});
