# ClientDesk MCP

A remote MCP server (a Claude custom connector) for a small professional-services firm. Staff ask Claude about
clients and documents; the server answers through tools, enforcing who may see what and logging every call.
All data is fictional (Northbridge Advisory, `src/demo/firm.ts`).

**Start every session by reading [`docs/PLAN.md`](docs/PLAN.md)**: the goal, decisions already made, current status
and the exact next steps. Update its Status and Next up sections when a day's work is done.

## Commands

- `npm run dev` start the HTTP server on :3000 (`/mcp`, `/health`), reloads on change
- `npm run stdio` run over stdio (what Claude Code uses locally)
- `npm test` vitest, in-memory Postgres (PGlite), no setup needed
- `npm run check` typecheck + lint + tests. Run before saying a task is done.
- `npm run seed -- --reset` reload the demo firm and its documents into the local database
- `npm run eval` accuracy report (`eval/report.md`, `eval/report.json`); `npm run eval:claude` uses the Claude API (costs money: ask first)
- `npm run dashboard:dev` / `dashboard:build` the React dashboard in `dashboard/` (its own package.json)

## Architecture

- `src/mcp/server.ts` builds one `McpServer` per request, bound to the signed-in `Actor`.
- `src/mcp/tools/*` one file per tool. Each handler runs inside `runTool()` (`src/mcp/run-tool.ts`), which writes the audit row.
  `resolve-client.ts` (id or name → one visible client) and `document-access.ts` (who may see a document) are shared.
- `src/domain/*` plain functions over `Db`: access, clients, documents (ingest, chunk, reindex), intake (extract once,
  match), matching (scores + reasons + file/review decision), search (hybrid), open items, dashboard queries. No MCP types.
- `src/ai/` extraction (Claude: Haiku then Opus on low confidence; `rules` offline fallback) and embeddings (Voyage;
  `local` hashing fallback). `src/storage/` files (local, R2, memory). `src/documents/` pdf.js text, signed links.
- `src/services.ts` builds `AppServices` (files, embedder, extractor, links, filing thresholds) from config; tests use
  `testServices()` (offline, in-memory).
- `src/db/` `Db` interface with PGlite (local, tests) and `pg` (production). SQL is plain Postgres; migrations in `migrations/*.sql`.
- `src/http.ts` stateless Streamable HTTP, OAuth discovery + bearer check, signed `/files/:id` links, dashboard
  mount. `resolveActor()` is the only place MCP identity is decided. `src/web/` dashboard sign-in, session cookie
  and `/api` routes (CSRF header required on writes; assistants never see audit details).
- `eval/dataset.ts` the labelled set; `scripts/eval.ts` the runner; `eval/changes.json` what was changed and why.

## Rules that must not be broken

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
- Tests live in `test/`; use `demoDb()` / `demoDbWithDocuments()`, `testServices()` and `connectAs()` from `test/helpers.ts`. Every tool needs tests for: allowed,
  denied (and its audit row), and not found / ambiguous where relevant.

## Skills in this repo

- `add-mcp-tool` the checklist for adding a tool
- `add-migration` schema changes
- `security-review` review a change against the rules above
