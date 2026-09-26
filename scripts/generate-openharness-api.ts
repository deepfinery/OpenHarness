import { format } from 'prettier';
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
const text = readFileSync('docs/spec/openharness.mapi.md', 'utf8');
const blocks = [...text.matchAll(/```typescript\n([\s\S]*?)```/g)].map((m) => m[1]);
const source = ts.createSourceFile('contract.ts', blocks.join('\n'), ts.ScriptTarget.Latest, true);
const schemas: Record<string, any> = {};
function schema(type: ts.TypeNode | undefined): any {
  if (!type) return {};
  if (type.kind === ts.SyntaxKind.StringKeyword) return { type: 'string' };
  if (type.kind === ts.SyntaxKind.NumberKeyword) return { type: 'number' };
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return { type: 'boolean' };
  if (
    type.kind === ts.SyntaxKind.ObjectKeyword ||
    type.kind === ts.SyntaxKind.UnknownKeyword ||
    type.kind === ts.SyntaxKind.AnyKeyword
  )
    return { type: 'object', additionalProperties: true };
  if (ts.isArrayTypeNode(type)) return { type: 'array', items: schema(type.elementType) };
  if (ts.isLiteralTypeNode(type)) {
    if (ts.isStringLiteral(type.literal)) return { type: 'string', enum: [type.literal.text] };
    return { type: 'boolean', enum: [type.literal.kind === ts.SyntaxKind.TrueKeyword] };
  }
  if (ts.isUnionTypeNode(type)) return { oneOf: type.types.map(schema) };
  if (ts.isTypeLiteralNode(type)) return members(type.members);
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText(source);
    if (name === 'Record') return { type: 'object', additionalProperties: true };
    if (name === 'File') return { type: 'string', format: 'binary' };
    if (name === 'Partial') {
      const ref = type.typeArguments?.[0]?.getText(source);
      return ref ? { $ref: `#/components/schemas/${ref}` } : { type: 'object' };
    }
    return { $ref: `#/components/schemas/${name}` };
  }
  return {};
}
function members(list: ts.NodeArray<ts.TypeElement>): any {
  const properties: Record<string, any> = {},
    required: string[] = [];
  for (const m of list)
    if (ts.isPropertySignature(m) && m.name) {
      const name = m.name.getText(source).replace(/^['"]|['"]$/g, '');
      properties[name] = schema(m.type);
      if (!m.questionToken) required.push(name);
    }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
for (const n of source.statements) {
  if (ts.isInterfaceDeclaration(n)) {
    const own = members(n.members);
    const inherited =
      n.heritageClauses?.flatMap((h) => h.types.map((t) => t.expression.getText(source))) ?? [];
    schemas[n.name.text] = { ...own, 'x-extends': inherited };
  } else if (ts.isTypeAliasDeclaration(n)) schemas[n.name.text] = schema(n.type);
}
for (const name of ['HarnessId', 'AgentId', 'SkillId', 'ExecutionId', 'SessionId', 'ISO8601'])
  schemas[name] = { type: 'string', ...(name === 'ISO8601' ? { format: 'date-time' } : {}) };
for (const [name, s] of Object.entries(schemas)) {
  for (const parent of s['x-extends'] ?? []) {
    const base = schemas[parent];
    if (base?.properties) s.properties = { ...base.properties, ...s.properties };
  }
  delete s['x-extends'];
}
// Generic envelopes contain type parameter references, resolved to unconstrained values.
function fixRefs(value: any) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref && !schemas[value.$ref.split('/').at(-1)!]) {
    delete value.$ref;
  }
  Object.values(value).forEach(fixRefs);
}
Object.values(schemas).forEach(fixRefs);
const operations: Record<string, any> = {};
for (const section of text.split(/(?=^## (?:Capability|Channel):)/m)) {
  const id = /^id: (.+)$/m.exec(section)?.[1];
  if (!id) continue;
  const title = /^## (?:Capability|Channel): (.+)$/m.exec(section)?.[1];
  const description = /### Intention\n+([\s\S]*?)(?=\n###|\n---|$)/.exec(section)?.[1]?.trim();
  const input = /### Input\n+```typescript\ninterface (\w+)/.exec(section)?.[1];
  const output = /### Output\n+```typescript\ninterface (\w+)/.exec(section)?.[1];
  operations[id] = {
    summary: title,
    description,
    input,
    output,
    multipart: /content_type: multipart/.test(section),
    binary: /Returns (raw ZIP|ZIP bytes|file bytes|file contents)/.test(section),
  };
}
writeFileSync(
  'apps/api/src/openharness/contract.json',
  await format(JSON.stringify({ schemas, operations }), { parser: 'json' }),
);
