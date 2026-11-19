# ClientDesk MCP

A remote MCP server (a Claude custom connector) for a small professional-services firm. Staff ask Claude about
clients and documents; the server answers through tools, enforcing who may see what and logging every call.
All data is fictional (Northbridge Advisory, `src/demo/firm.ts`; a second firm, Harbourline Tax Partners,
`src/demo/second-firm.ts`, proves isolation).

**Start every session by reading [`docs/PLAN.md`](docs/PLAN.md)**: the goal, decisions already made, current status
and the exact next steps. Update its Status and Next up sections when a day's work is done.

## Commands

- `npm run dev` start the HTTP server on :3000 (`/mcp`, `/health`), reloads on change
- `npm run stdio` run over stdio (what Claude Code uses locally)
- `npm test` vitest, in-memory Postgres (PGlite), no setup needed
- `npm run check` typecheck + lint + tests. Run before saying a task is done.
- `npm run seed -- --reset` reload the demo firm and its documents into the local database
- `npm run eval -- --extractor=rules` offline accuracy report (`eval/baseline.*`); model runs write `eval/report.*`; `npm run eval:claude` uses the Claude API (costs money: ask first)
- `npx playwright test` end-to-end tests (builds the dashboard, starts the server on :3399, offline)
- `npm run worker` batch-intake worker on its own (the web server runs one too, `WORKER=1`); `npm run reindex` rebuild passages
- `npm run dashboard:dev` / `dashboard:build` the React dashboard in `dashboard/` (its own package.json)

## Architecture

- `src/mcp/server.ts` builds one `McpServer` per request, bound to the signed-in `Actor`.
- `src/mcp/tools/*` one file per tool. Each handler runs inside `runTool()` (`src/mcp/run-tool.ts`), which writes the audit row.
  `resolve-client.ts` (id or name → one visible client) and `document-access.ts` (who may see a document) are shared.
- `src/domain/*` plain functions over `Db`: access, clients, documents (ingest, chunk, reindex), intake (extract once,
  match), matching (scores + reasons + file/review decision), search (hybrid), open items, dashboard queries. No MCP types.
- `src/ai/` extraction (Claude: Haiku then Opus on low confidence; Groq: gpt-oss-20b then 120b; `rules` offline fallback) and embeddings (Voyage;
  `local` hashing fallback). `src/storage/` files (local, S3/R2, memory). `src/documents/` pdf.js text, signed links.
- `src/services.ts` builds `AppServices` (files, embedder, extractor, links, filing thresholds) from config; tests use
  `testServices()` (offline, in-memory).
- `src/db/` `Db` interface with PGlite (local, tests) and `pg` (production); `forFirm()` gives a firm-scoped handle
  (per-query transaction as role `clientdesk_app` with `app.firm_id` set, so RLS applies). Migrations in `migrations/*.sql`.
- `src/jobs/` Postgres job queue (`FOR UPDATE SKIP LOCKED`), intake pipeline steps, worker. `src/ai/usage.ts` +
  `prices.ts`: every model call recorded to `llm_calls` (AsyncLocalStorage scope).
- `src/http.ts` stateless Streamable HTTP, OAuth discovery + bearer check, signed `/files/:id` links, dashboard
  mount. `resolveActor()` is the only place MCP identity is decided. `src/web/` dashboard sign-in, session cookie
  and `/api` routes (CSRF header required on writes; assistants never see audit details).
- `eval/dataset.ts` the labelled set; `scripts/eval.ts` the runner; `eval/changes.json` what was changed and why.

## Rules that must not be broken

0. **Firms are isolated twice.** Request code uses `db.forFirm(actor.firmId)` (never the unscoped handle); every
   query on firm data filters `firm_id = firmOf(db)`; Postgres RLS enforces the same on every scoped query. The
   unscoped (owner) handle is only for identity lookup, the job queue's claim/advance, migrations and start-up.
   An id of another firm answers like "not found" and is audited as `denied`.
1. **Access is enforced in code, never in prompts.** Any tool touching client data calls `canAccessClient` or
   `partitionByAccess` before reading it (cross-client queries filter by `accessibleClientIds`). A denied result
   returns `status: 'denied'` with no client data in it, not even another client's name in a reason.
2. **Every tool goes through `runTool()`**, so every call is audited. Never write a handler that bypasses it.
3. **Parameterised SQL only** (`$1`, `$2`). Never build SQL from user or model input.
4. **Tool annotations are honest**: read tools `readOnlyHint: true`; tools that change data `readOnlyHint: false`
   and `destructiveHint` set, so Claude asks the user first.
5. **Never guess identity**: when a lookup matches several clients, return the candidates and let the user choose.
6. **No real personal data** anywhere: fixtures, tests, docs or logs. Store at most the last 4 digits of a tax id.
7. Never edit an applied migration; add a new numbered file.

## Conventions

- TypeScript strict, ESM, Node 22. Zod 4 for schemas. Prettier (single quotes, 120 cols) runs automatically after edits.
- Tool output: a short `text` summary for the model plus `structuredContent` matching the tool's `outputSchema`.
- Tests live in `test/`; use `demoDb()` / `demoDbWithDocuments()` (both firms; returns the unscoped handle, so call
  domain functions with `nb(db)` / `db.forFirm(...)`), `testServices()` and `connectAs()` from `test/helpers.ts`.
  Every tool needs tests for: allowed, denied (and its audit row), not found / ambiguous where relevant, and an id
  from the other firm.

## Skills in this repo

- `add-mcp-tool` the checklist for adding a tool
- `add-migration` schema changes
- `security-review` review a change against the rules above
