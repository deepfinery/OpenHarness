import { dispatchHumanRequests, deliverHumanNotifications } from '../../../packages/core/src/human.js';
import { app } from './app.js';
import { config } from '../../../packages/core/src/config.js';
import { connectDatabase, mongo } from '../../../packages/core/src/db.js';
import { closeQueue } from '../../../packages/core/src/queue.js';
import { dispatchPending, dispatchSchedules, recoverStaleJobs } from '../../../packages/core/src/runs.js';
import { deliverWebhooks } from '../../../packages/core/src/harnessEvents.js';
import { dispatchReflections } from '../../../packages/core/src/experience.js';
import { safeError } from '../../../packages/core/src/security.js';

await connectDatabase();
const server = app.listen(config.PORT, '0.0.0.0', () =>
  console.log(`OpenHarness studio listening on port ${config.PORT}`),
);
let dispatching = false;
async function tick() {
  if (dispatching) return;
  dispatching = true;
  try {
    await recoverStaleJobs();
    await dispatchHumanRequests();
    await dispatchPending();
    await dispatchSchedules();
    await deliverWebhooks();
    await dispatchReflections();
  } catch (e) {
    console.error('Dispatcher will retry:', safeError(e));
  } finally {
    dispatching = false;
  }
}
let notifying = false;
const notifications = setInterval(async () => {
  if (notifying) return;
  notifying = true;
  try {
    await deliverHumanNotifications();
  } catch (error) {
    console.warn('Human notifications will retry:', safeError(error));
  } finally {
    notifying = false;
  }
}, 3000);
const timer = setInterval(() => void tick(), 3000);
void tick();
async function shutdown() {
  clearInterval(timer);
  clearInterval(notifications);
  server.close();
  await closeQueue();
  await mongo.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
