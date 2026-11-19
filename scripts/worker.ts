/**
 * `npm run worker`: runs batch-intake jobs in their own process, next to (or instead of) the web server's worker.
 * Several can run at once against the same database: jobs are claimed with FOR UPDATE SKIP LOCKED.
 */
import { openDatabase } from '../src/bootstrap.js';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { createWorker } from '../src/jobs/worker.js';
import { createServices } from '../src/services.js';

loadDotEnv();
const config = loadConfig();
const services = createServices(config);
const db = await openDatabase({ ...config, seedDemo: false }, console.log, services);
const worker = createWorker({ db, services, config: config.jobs, log: console.log });
worker.start();

const shutdown = () => {
  void worker
    .stop()
    .then(() => db.close())
    .finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
