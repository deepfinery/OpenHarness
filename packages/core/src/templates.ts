import type { WorkflowNode } from './schema.js';
export type Scope = {
  input: string;
  last: unknown;
  steps: Record<string, unknown>;
  payload?: Record<string, unknown>;
};
function pathValue(scope: Scope, path: string): unknown {
  const parts = path.trim().split('.');
  let current: unknown = scope;
  for (const p of parts) {
    if (['__proto__', 'prototype', 'constructor'].includes(p)) throw new Error('Unsafe template path');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, p))
      throw new Error(`Unknown template value: ${path}`);
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}
export function render(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(value);
    if (exact) return pathValue(scope, exact[1]);
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path: string) => asText(pathValue(scope, path)));
  }
  if (Array.isArray(value)) return value.map((v) => render(v, scope));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (['__proto__', 'prototype', 'constructor'].includes(k)) throw new Error('Unsafe argument key');
        return [k, render(v, scope)];
      }),
    );
  return value;
}
export const asText = (value: unknown) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));
export function evaluateCondition(node: Extract<WorkflowNode, { type: 'condition' }>, scope: Scope) {
  const value = render(node.value, scope);
  const other = render(node.compare, scope);
  switch (node.operator) {
    case 'equals':
      return asText(value) === asText(other);
    case 'notEquals':
      return asText(value) !== asText(other);
    case 'contains':
      return asText(value).includes(asText(other));
    case 'greaterThan':
      return Number(value) > Number(other);
    case 'truthy':
      return Boolean(value) && !['false', '0', 'null', ''].includes(asText(value));
  }
}
