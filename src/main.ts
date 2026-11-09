import { openDatabase } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createHttpApp } from './http.js';

const config = loadConfig();
const db = await openDatabase(config, console.log);
const app = createHttpApp({ db, config });

const server = app.listen(config.port, () => {
  console.log(`ClientDesk MCP listening on http://localhost:${config.port}/mcp (auth: ${config.authMode})`);
});

const shutdown = () => {
  server.close(() => {
    void db.close().finally(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
