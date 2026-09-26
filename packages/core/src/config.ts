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
  DATA_DIR: z.string().default('./data'),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, 'ENCRYPTION_KEY must be 32 random bytes in hex'),
  SETUP_TOKEN: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  MAX_ACTIVE_RUNS: z.coerce.number().int().min(1).max(1000).default(20),
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
  MAX_RESUMES: z.coerce.number().int().min(0).max(10).default(3),
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
