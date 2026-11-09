import { setupOAuth } from './auth/oauth.js';
import { openDatabase } from './bootstrap.js';
import { baseUrl, loadConfig } from './config.js';
import { createHttpApp } from './http.js';
import { createServices } from './services.js';

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
    void db.close().finally(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
