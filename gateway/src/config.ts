import { z } from 'zod';

const bool = z.preprocess((v) => (typeof v === 'string' ? /^(1|true|yes|on)$/i.test(v) : v), z.boolean());
export const gatewayConfigSchema = z
  .object({
    PORT: z.coerce.number().int().default(8090),
    HOST: z.string().default('0.0.0.0'),
    /** What devices and the studio show as the gateway address, e.g. wss://gateway.example.com. */
    GATEWAY_PUBLIC_URL: z.string().default('ws://localhost:8090'),
    /** MongoDB holding the device registry and the audit trail. */
    GATEWAY_MONGODB_URI: z.string().optional(),
    GATEWAY_MONGODB_DATABASE: z.string().default('agentic_gateway'),
    /** Audit entries older than this are removed by MongoDB; 0 keeps them forever. */
    GATEWAY_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),
    /** `name:token,name:token` — the name is the identity written to the audit log. */
    GATEWAY_API_TOKENS: z.string().default(''),
    GATEWAY_ADMIN_TOKEN: z.string().optional(),
    GATEWAY_TOOL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(3600).default(120),
    /** `tool=seconds,tool=seconds` overrides. */
    GATEWAY_TOOL_TIMEOUTS: z.string().default(''),
    GATEWAY_APPROVAL_TOOLS: z.string().default(''),
    GATEWAY_APPROVAL_PROVIDER: z.enum(['noop', 'webhook', 'studio']).default('noop'),
    GATEWAY_APPROVAL_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    GATEWAY_APPROVAL_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(86400).default(300),
    GATEWAY_AUDIT_FILE: z.string().optional(),
    /** Accept device sockets that did not arrive over TLS (no `X-Forwarded-Proto: https`). Development only. */
    GATEWAY_ALLOW_INSECURE_WS: bool.default(false),
    GATEWAY_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
    GATEWAY_SESSION_RETENTION_SECONDS: z.coerce.number().int().min(0).default(600),
    GATEWAY_HTTP_SESSION_IDLE_SECONDS: z.coerce.number().int().min(60).default(1800),
    /** JSON array of devices to enroll at startup when absent: [{device_id, platform, token, owner, name, allowed_tools}]. */
    GATEWAY_BOOTSTRAP_DEVICES: z.string().optional(),
    TRUST_PROXY: z.string().default('0'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((config, ctx) => {
    if (config.GATEWAY_APPROVAL_PROVIDER === 'webhook' && !config.GATEWAY_APPROVAL_URL)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GATEWAY_APPROVAL_URL'],
        message: 'Webhook approval requires a URL',
      });
    if (config.GATEWAY_APPROVAL_PROVIDER === 'studio' && !config.GATEWAY_ADMIN_TOKEN?.trim())
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GATEWAY_ADMIN_TOKEN'],
        message: 'Studio approval requires a shared administrator secret',
      });
  });
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env) => gatewayConfigSchema.parse(env);

const list = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
export function toolTimeouts(config: GatewayConfig) {
  const overrides = new Map<string, number>();
  for (const entry of list(config.GATEWAY_TOOL_TIMEOUTS)) {
    const [tool, seconds] = entry.split('=');
    if (tool && Number(seconds) > 0) overrides.set(tool.trim(), Number(seconds) * 1000);
  }
  return (tool: string) => overrides.get(tool) ?? config.GATEWAY_TOOL_TIMEOUT_SECONDS * 1000;
}
export const approvalTools = (config: GatewayConfig) => new Set(list(config.GATEWAY_APPROVAL_TOOLS));
