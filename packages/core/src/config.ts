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
  DATA_DIR: z.string().default('./data'),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, 'ENCRYPTION_KEY must be 32 random bytes in hex'),
  SETUP_TOKEN: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  MAX_ACTIVE_RUNS: z.coerce.number().int().min(1).max(1000).default(20),
  EMBED_ORIGINS: z.string().default(''),
  ALLOW_PRIVATE_URLS: z.string().default('false'),
  ALLOWED_PRIVATE_HOSTS: z.string().default('host.docker.internal,ollama'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(20),
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
});
export const config = s.parse(process.env);
export const secureCookies = new URL(config.PUBLIC_URL).protocol === 'https:';
