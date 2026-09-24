export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}
export const send = <T = any>(path: string, body?: unknown, method = 'POST') =>
  api<T>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
export type Entity = { id: string; name: string; [key: string]: any };
export type User = {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  enabled: boolean;
  tenantId: string;
};
export type Data = {
  agents: Entity[];
  workflows: Entity[];
  providers: Entity[];
  connections: Entity[];
  knowledge: Entity[];
};
export const emptyData: Data = { agents: [], workflows: [], providers: [], connections: [], knowledge: [] };
export const timestamp = (date?: string) =>
  date ? new Date(date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong';
