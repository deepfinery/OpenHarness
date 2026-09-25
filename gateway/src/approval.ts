// Human approval before selected tools are forwarded. `noop` allows; `webhook` asks a URL and waits for a decision.
import type { Logger } from '@agentic/connector-core';

export type ApprovalRequest = { device_id: string; tool: string; arguments: unknown; identity: string };
export type Decision = 'approved' | 'denied';
export interface ApprovalProvider {
  decide(request: ApprovalRequest, signal?: AbortSignal): Promise<Decision>;
}
export const noopApproval: ApprovalProvider = { decide: async () => 'approved' };

/**
 * POSTs the pending call to `url` and expects `{ "approval_id": "…" }` (or an immediate `{ "status": "approved" }`).
 * Then polls `GET url/<approval_id>` every 2 s until `{ "status": "approved" | "denied" }` or the timeout, which denies.
 */
export function webhookApproval(
  url: string,
  timeoutMs: number,
  log: Logger,
  fetchFn: typeof fetch = fetch,
): ApprovalProvider {
  return {
    async decide(request, signal) {
      const deadline = Date.now() + timeoutMs;
      const started = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      if (!started.ok) {
        log.warn('approval webhook rejected the request', { status: started.status });
        return 'denied';
      }
      const body = (await started.json().catch(() => ({}))) as { approval_id?: string; status?: string };
      if (body.status === 'approved' || body.status === 'denied') return body.status;
      if (!body.approval_id) return 'denied';
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (signal?.aborted) return 'denied';
        const poll = await fetchFn(`${url.replace(/\/$/, '')}/${encodeURIComponent(body.approval_id)}`, {
          signal,
        }).catch(() => undefined);
        const state = (await poll?.json().catch(() => ({}))) as { status?: string } | undefined;
        if (state?.status === 'approved' || state?.status === 'denied') return state.status;
      }
      log.warn('approval timed out', { tool: request.tool, device_id: request.device_id });
      return 'denied';
    },
  };
}
