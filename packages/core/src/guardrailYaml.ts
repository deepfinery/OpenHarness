import { isAlias, isCollection, isScalar, parseDocument, stringify, visit } from 'yaml';
import { z } from 'zod';
import {
  guardrailPolicyObjectSchema,
  guardrailPolicySchema,
  type GuardrailPolicy,
} from './guardrailPolicy.js';

export const guardrailYamlMaxBytes = 256 * 1024;
// This is the supported NeMo configuration for our installed, trusted Colang flow.
// Policy settings are data, never Python/Colang, model credentials, or import paths.
const configurationSchema = z
  .object({
    models: z.array(z.never()).length(0),
    colang_version: z.literal('1.0'),
    rails: z
      .object({
        input: z.object({ flows: z.tuple([z.literal('openharness policy')]) }).strict(),
        dialog: z.object({ user_messages: z.object({ embeddings_only: z.literal(true) }).strict() }).strict(),
      })
      .strict(),
    custom_data: z
      .object({
        openharness: z
          .object({ version: z.literal(1), policy: guardrailPolicyObjectSchema.strict() })
          .strict(),
      })
      .strict(),
  })
  .strict();

export function guardrailYaml(policy: GuardrailPolicy): string {
  const parsed = guardrailPolicySchema.parse(policy);
  return (
    '# NeMo Guardrails configuration for the OpenHarness policy adapter.\n' +
    '# Requires the bundled openharness rails.co and actions.py.\n' +
    '# Edit custom_data.openharness.policy; model credentials stay on the service.\n' +
    stringify(
      {
        models: [],
        colang_version: '1.0',
        rails: {
          input: { flows: ['openharness policy'] },
          dialog: { user_messages: { embeddings_only: true } },
        },
        custom_data: { openharness: { version: 1, policy: parsed } },
      },
      { lineWidth: 100 },
    )
  );
}

export function parseGuardrailYaml(source: string): GuardrailPolicy {
  if (new TextEncoder().encode(source).length > guardrailYamlMaxBytes)
    throw new Error('Policy YAML must be 256 KiB or smaller.');
  const document = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false });
  if (document.errors.length || document.warnings.length)
    throw new Error((document.errors[0] ?? document.warnings[0]).message);
  let count = 0;
  visit(document, (_key, node, path) => {
    if (++count > 10000 || path.length > 24) throw new Error('Policy YAML is too deeply nested or complex.');
    if (isAlias(node) || ((isScalar(node) || isCollection(node)) && (node.anchor || node.tag)))
      throw new Error('Policy YAML must contain plain data without anchors, aliases, or custom tags.');
  });
  const config = configurationSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!config.success)
    throw new Error(
      config.error.issues.map((i) => `${i.path.join('.') || 'configuration'}: ${i.message}`).join('\n'),
    );
  const result = guardrailPolicySchema.safeParse(config.data.custom_data.openharness.policy);
  if (!result.success)
    throw new Error(result.error.issues.map((i) => `policy.${i.path.join('.')}: ${i.message}`).join('\n'));
  return result.data;
}

export function guardrailYamlFilename(name: string) {
  return (
    (name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'guardrail-policy') + '.yaml'
  );
}
