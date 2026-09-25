import { loadConfig } from './config.js';
import { startGateway } from './server.js';

const gateway = await startGateway(loadConfig());
const shutdown = async (signal: string) => {
  gateway.log.info('shutting down', { signal });
  await gateway.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
