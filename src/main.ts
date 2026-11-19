import { setupOAuth } from './auth/oauth.js';
import { openDatabase } from './bootstrap.js';
import { baseUrl, loadConfig, loadDotEnv } from './config.js';
import { createHttpApp } from './http.js';
import { createWorker } from './jobs/worker.js';
import { createServices } from './services.js';

loadDotEnv();
const config = loadConfig();
const oauth = config.authMode === 'oauth' ? await setupOAuth(config) : undefined;
if (oauth && !oauth.metadata.registration_endpoint) {
  console.warn(
    'The authorization server advertises no registration_endpoint: turn on dynamic client registration, ' +
      "or enter a client ID in Claude's connector settings.",
  );
}
const services = createServices(config);
const db = await openDatabase(config, console.log, services);
const app = createHttpApp({ db, config, services, oauth });
// Batch intake runs in this process (Render's free plan has no background workers); `WORKER=0` turns it off when a
// separate `npm run worker` process does the work.
const worker = config.jobs.worker ? createWorker({ db, services, config: config.jobs, log: console.log }) : null;
worker?.start();

const server = app.listen(config.port, () => {
  const base = baseUrl(config);
  console.log(`ClientDesk MCP listening on ${new URL('/mcp', base).href} (auth: ${config.authMode})`);
  console.log(`Dashboard: ${new URL('/dashboard/', base).href}`);
  console.log(
    `Extractor: ${services.extractor.name}; embeddings: ${services.embedder.model}; storage: ${config.storage.kind}`,
  );
});

const shutdown = () => {
  server.close(() => {
    // Let running steps finish; anything left is reclaimed as stuck by the next worker.
    void (worker?.stop() ?? Promise.resolve()).then(() => db.close()).finally(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
