import type { Server } from 'node:http';
import type { Express } from 'express';

/**
 * Starts the server and resolves once it really is listening. Express 5 also calls `listen`'s callback when it fails
 * (port already in use), so a plain callback would announce a server that isn't there.
 */
export function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (error?: Error) => (error ? reject(error) : resolve(server)));
  });
}
