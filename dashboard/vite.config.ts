import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard is served by the ClientDesk server at /dashboard, on the same origin as /api, /auth and /files.
// In development Vite proxies those paths to the server on :3000, so cookies and the CSRF header behave the same.
const backend = process.env.CLIENTDESK_API ?? 'http://localhost:3000';

export default defineConfig({
  base: '/dashboard/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/auth': { target: backend, changeOrigin: false },
      '/files': { target: backend, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
