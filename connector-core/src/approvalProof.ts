import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export type ApprovalCall = { deviceId: string; tool: string; arguments: unknown; callId: string };
function callDigest(call: ApprovalCall) {
  return createHash('sha256').update(canonical(call)).digest('hex');
}
/** Short-lived, single-call proof. The gateway must atomically consume the call id before forwarding it. */
export function signApprovalCall(secret: string, call: ApprovalCall, now = Date.now()) {
  if (!secret) throw new Error('Gateway approval signing is unavailable');
  const payload = Buffer.from(JSON.stringify({ digest: callDigest(call), expires: now + 30000 })).toString(
    'base64url',
  );
  return `${payload}.${createHmac('sha256', secret).update(`studio-approval:${payload}`).digest('hex')}`;
}
export function verifyApprovalCall(
  secret: string,
  call: ApprovalCall,
  proof: unknown,
  now = Date.now(),
): number | undefined {
  if (!secret || typeof proof !== 'string' || proof.length > 1000) return;
  const [payload, signature, extra] = proof.split('.');
  if (extra || !payload || !/^[a-f0-9]{64}$/.test(signature ?? '')) return;
  const expected = createHmac('sha256', secret).update(`studio-approval:${payload}`).digest('hex');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (
      typeof value.expires !== 'number' ||
      value.expires <= now ||
      value.expires > now + 30000 ||
      value.digest !== callDigest(call)
    )
      return;
    return value.expires;
  } catch {
    return;
  }
}
