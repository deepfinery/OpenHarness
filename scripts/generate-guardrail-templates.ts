import { readFile, writeFile } from 'node:fs/promises';
import { parseGuardrailYaml } from '../packages/core/src/guardrailYaml.js';
const ids = ['bias', 'toxicity', 'hallucinations', 'opacity', 'pii', 'vulnerability'];
const policies: Record<string, unknown> = {};
for (const id of ids) {
  const policy = parseGuardrailYaml(
    await readFile(new URL(`../guardrails/templates/${id}.yaml`, import.meta.url), 'utf8'),
  );
  if (policy.templateId !== id) throw new Error(`Template ${id} must declare its matching templateId`);
  policies[id] = policy;
}
const target = new URL('../packages/core/src/guardrailTemplatePolicies.json', import.meta.url);
const content = JSON.stringify(policies, null, 2) + '\n';
if ((await readFile(target, 'utf8').catch(() => '')) !== content) await writeFile(target, content);
