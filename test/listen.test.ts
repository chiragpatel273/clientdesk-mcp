import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { listen } from '../src/listen.js';

describe('listen', () => {
  it('resolves once the server answers, and rejects when the port is taken', async () => {
    const app = express();
    app.get('/health', (_req, res) => void res.json({ ok: true }));
    const server = await listen(app, 0);
    const { port } = server.address() as AddressInfo;
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    await expect(listen(express(), port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise((resolve) => server.close(resolve));
  });
});
