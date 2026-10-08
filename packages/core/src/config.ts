import { z } from 'zod';
const s = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(8088),
  PUBLIC_URL: z.string().url().default('http://localhost:8088'),
  MONGODB_URI: z.string().default('mongodb://localhost:27017/agentic'),
  MONGODB_DATABASE: z.string().default('agentic'),
  RABBITMQ_URL: z.string().default('amqp://localhost'),
  WEAVIATE_URL: z.string().url().default('http://localhost:8080'),
  WEAVIATE_API_KEY: z.string().default(''),
  // Vector store for new knowledge bases. Existing bases keep the store they were created on.
  VECTOR_STORE: z.enum(['weaviate', 'qdrant', 'opensearch', 'elasticsearch', 'openai']).default('weaviate'),
  QDRANT_URL: z.string().default(''),
  QDRANT_API_KEY: z.string().default(''),
  OPENSEARCH_URL: z.string().default(''),
  OPENSEARCH_USERNAME: z.string().default(''),
  OPENSEARCH_PASSWORD: z.string().default(''),
  ELASTICSEARCH_URL: z.string().default(''),
  ELASTICSEARCH_API_KEY: z.string().default(''),
  // Any OpenAI-compatible Vector Stores API: OpenAI, Llama Stack, or a managed service. It embeds text itself.
  OPENAI_VECTOR_STORES_URL: z.string().default(''),
  OPENAI_VECTOR_STORES_API_KEY: z.string().default(''),
  // The MongoDB MCP server of this installation (mongodb-mcp service). Workspaces reach their own database in the
  // stack MongoDB through it; OpenHarness holds the bearer token and provisions the server's least-privilege user.
  MONGODB_MCP_URL: z.string().default(''),
  MONGODB_MCP_TOKEN: z.string().default(''),
  MONGODB_MCP_USER: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .default('openharness_mcp'),
  MONGODB_MCP_PASSWORD: z.string().default(''),
  // Python executor: agent-written code runs in containers of the python-executor image. `kubernetes` creates a
  // Job per run through the pod's service account; `service` posts to the python-executor HTTP service (Compose).
  EXECUTOR_BACKEND: z.enum(['', 'kubernetes', 'service']).default(''),
  EXECUTOR_URL: z.string().default(''),
  EXECUTOR_TOKEN: z.string().default(''),
  /** How a job container reaches this API to fetch its code and report back. */
  EXECUTOR_CALLBACK_URL: z.string().default('http://api:8088'),
  /** Kubernetes only. The image defaults to the app pod's digest-pinned `executor-image` init container. */
  EXECUTOR_IMAGE: z.string().default(''),
  EXECUTOR_NAMESPACE: z.string().default(''),
  EXECUTOR_JOB_CPU: z.string().default('1'),
  EXECUTOR_JOB_MEMORY: z.string().default('2Gi'),
  EXECUTOR_JOB_DISK: z.string().default('10Gi'),
  EXECUTOR_JOB_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(3600),
  /** Jobs a workspace may have in flight at once; 0 means no limit. */
  EXECUTOR_MAX_PARALLEL: z.coerce.number().int().min(0).max(100000).default(16),
  EXECUTOR_DEFAULT_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(2_592_000).default(600),
  /** The longest a job may ask to run; 0 means no maximum. */
  EXECUTOR_MAX_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(31_536_000).default(86_400),
  DATA_DIR: z.string().default('./data'),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, 'ENCRYPTION_KEY must be 32 random bytes in hex'),
  SETUP_TOKEN: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(1024).default(2),
  /** Queued + running runs a workspace may have; 0 means no limit. */
  MAX_ACTIVE_RUNS: z.coerce.number().int().min(0).max(1_000_000_000).default(20),
  /** Wall-clock cap on one run inside a runner; 0 means no cap (agents keep their own time limits). */
  RUN_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(31_536_000).default(0),
  /** How long one model request (including a streamed reply) may take before it is retried. */
  MODEL_REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(86_400).default(600),
  EMBED_ORIGINS: z.string().default(''),
  ALLOW_PRIVATE_URLS: z.string().default('false'),
  ALLOWED_PRIVATE_HOSTS: z.string().default('host.docker.internal,ollama'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(20),
  /** Sign-in attempts allowed per client address in ten minutes. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(10000).default(20),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  // Installation-wide SMTP defaults (for example AWS SES). Workspace settings in the studio override them.
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.string().default('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default(''),
  // 'json' swaps the network transport for nodemailer's JSON transport; only the test stack uses it.
  SMTP_TRANSPORT: z.enum(['smtp', 'json']).default('smtp'),
  MAX_RESUMES: z.coerce.number().int().min(0).max(1000).default(3),
  // Device gateway (optional). When set, the studio can enroll machines and agents can operate them.
  GARAK_PROBES_URL: z.string().url().default('http://guardrail-evaluation:8001'),
  NEMO_GUARDRAILS_URL: z.string().url().default('http://guardrails:8000'),
  GATEWAY_URL: z.string().default(''),
  GATEWAY_PUBLIC_URL: z.string().default(''),
  GATEWAY_API_TOKEN: z.string().default(''),
  GATEWAY_ADMIN_TOKEN: z.string().default(''),
  // Open Harness API adapter (https://github.com/jeffrschneider/OpenHarness). This install is one harness.
  OPENHARNESS_BASE_PATH: z
    .string()
    .regex(/^(\/[a-z0-9-]+)+$/, 'OPENHARNESS_BASE_PATH must look like /openharness/v1')
    .default('/openharness/v1'),
  OPENHARNESS_HARNESS_ID: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'OPENHARNESS_HARNESS_ID must be kebab-case')
    .default('openharness'),
});
export const config = s.parse(process.env);
export const secureCookies = new URL(config.PUBLIC_URL).protocol === 'https:';
