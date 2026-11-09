import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express, Request, Response } from 'express';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { findActorByEmail } from './domain/staff.js';
import type { Actor } from './domain/types.js';
import { createMcpServer } from './mcp/server.js';

const DEV_USER_HEADER = 'x-clientdesk-user';

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Works out who is calling. Day 1: dev mode only (a header or DEV_USER).
 * Day 3 replaces this with OAuth bearer-token validation; nothing else in the app changes.
 */
async function resolveActor(req: Request, db: Db, config: Config): Promise<Actor | null> {
  if (config.authMode !== 'dev') return null;
  const header = req.header(DEV_USER_HEADER);
  return findActorByEmail(db, header ?? config.devUser);
}

export function createHttpApp(deps: { db: Db; config: Config }): Express {
  const { db, config } = deps;
  const app = createMcpExpressApp(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {});

  app.get('/health', (_req, res) => {
    res.json({ ok: true, name: 'clientdesk', authMode: config.authMode });
  });

  // Stateless Streamable HTTP: a fresh server per request, bound to that request's caller.
  app.post('/mcp', async (req, res) => {
    const actor = await resolveActor(req, db, config);
    if (!actor) {
      jsonRpcError(res, 401, -32001, 'Unknown or missing user.');
      return;
    }
    const server = createMcpServer({ db, actor });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed', error);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => jsonRpcError(res, 405, -32000, 'Method not allowed.');
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}
