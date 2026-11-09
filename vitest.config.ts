import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file boots its own in-memory Postgres (PGlite, WASM) and some render PDFs. Unbounded parallelism
    // ran an 8 GB WSL machine out of memory (workers SIGKILLed), and slow starts passed the 10s hook default.
    maxWorkers: 3,
    hookTimeout: 60_000,
  },
});
