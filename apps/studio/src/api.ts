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
export const collections = ['agents', 'workflows', 'providers', 'connections', 'knowledge'] as const;
export type Data = Record<(typeof collections)[number], Entity[]> & {
  /** Workspace defaults, such as the model provider new agents start with. */
  defaults: { providerId: string };
};
export const emptyData: Data = {
  agents: [],
  workflows: [],
  providers: [],
  connections: [],
  knowledge: [],
  defaults: { providerId: '' },
};
/** The provider new agents use: the workspace default when it exists, otherwise the first provider. */
export const defaultProviderId = (data: Data) =>
  (data.providers.some((p) => p.id === data.defaults.providerId) ? data.defaults.providerId : '') ||
  data.providers[0]?.id ||
  '';
export const timestamp = (date?: string) =>
  date ? new Date(date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong';
