# ClientDesk MCP: plan and status

Read this at the start of every session. Update **Status** and **Next up** at the end of each day.

## Why this project exists

A public proof-of-work for Upwork. It must prove the three things high-paying clients keep asking for:
**real Claude/MCP integration, measured accuracy, and secure access control.** Target job types: connecting Claude to
business systems (MCP, CRM), document AI and RAG with accuracy, AI-first development with Claude Code, Claude setup and training.
Quality bar: a client should be able to read the repo, watch a 3-minute video and trust it with their firm's data.

## The demo (3-minute video, five moments)

1. **Cited answers.** A partner asks "What's still missing for Acme Ltd's FY2026 return?" and gets an answer that links each source document.
2. **Document intake.** An assistant uploads an invoice to the inbox and says "file the new invoice". Claude extracts the fields, matches the client with a confidence score, asks for confirmation, files it and adds a CRM note.
3. **Safe failure.** A blurry statement matches two clients, so it goes to the review queue with a reason instead of being guessed.
4. **Permissions.** An assistant asks about a client she isn't assigned to. The request is refused and logged.
5. **Proof.** The dashboard shows the audit log and the accuracy report.

## Tools (target)

| Tool               | Type  | Notes                                                                    |
| ------------------ | ----- | ------------------------------------------------------------------------ |
| `get_client`       | Read  | **Done.** Id or name; ambiguous → candidates                             |
| `search_documents` | Read  | Hybrid (pgvector + full-text) search; passages with title, page and link |
| `list_open_items`  | Read  | Missing items for a client and tax year                                  |
| `list_inbox`       | Read  | Unprocessed documents                                                    |
| `extract_document` | Read  | Fields per document type, confidence per field                           |
| `match_client`     | Read  | Candidate clients with confidence and reasons                            |
| `file_document`    | Write | Refuses below the confidence threshold                                   |
| `add_crm_note`     | Write | Note or open item on a client                                            |
| `send_to_review`   | Write | Human review queue with a reason                                         |

## Stack decisions (made)

- MCP: `@modelcontextprotocol/sdk` v1.x, stateless Streamable HTTP plus stdio. (v2 / the 2026-07-28 spec is still beta.)
- DB: Postgres + pgvector. PGlite locally and in tests, Neon in production.
- Embeddings: Voyage AI (1024 dims, matches `document_chunks.embedding`).
- Extraction: Claude API with a JSON schema per document type; a small model first, a larger one on low confidence.
- PDFs: text layer via pdf.js; scanned pages sent to Claude as PDF (no separate OCR).
- Sign-in: hosted OAuth provider with dynamic client registration. Try WorkOS AuthKit first, Auth0 as fallback.
- CRM: built-in mini-CRM behind an adapter interface; a HubSpot adapter only if Day 8 has time.
- Files: Cloudflare R2. Hosting: Render or Fly.io.
- Dashboard: React + Vite (SPA, TypeScript) with Tailwind CSS v4 and shadcn/ui; TanStack Query for data, TanStack
  Table for the audit log and review queue, Recharts for accuracy scores. Lives in `dashboard/`, built to static files
  and served by the existing server at `/dashboard`. It reads a small JSON API (`/api/*`) in the same process, so
  sign-in, `resolveActor()` and the access rules stay in one place. One deploy, one origin, no CORS.
  Why not Next.js: the dashboard is behind a login (no SEO or SSR benefit), and Next.js would add a second backend
  that also needs DB access and access checks, plus a second deploy.
- Budget: about $10–25 of Claude API usage in total. Keep a spending limit in the Anthropic console.

## Accuracy report (Day 6)

60 synthetic labelled documents (15 each: invoice, bank statement, engagement letter, tax form) with hard cases
(scans and photos, look-alike clients, missing fields, prior-year documents, multi-page), plus 30 questions with known
source documents. `npm run eval` writes Markdown + JSON; CI runs it on every push.

| Metric                  | Target |
| ----------------------- | ------ |
| Field accuracy          | ≥ 95%  |
| Wrong-client filings    | 0      |
| Review-queue rate       | ≤ 10%  |
| Search hit rate (top 5) | ≥ 90%  |
| Citation accuracy       | ≥ 95%  |

Publish real numbers even when they miss a target, plus what was changed to improve them.

## Build plan and gates

| Phase             | Days | Gate to pass before moving on                          | Status                                     |
| ----------------- | ---- | ------------------------------------------------------ | ------------------------------------------ |
| Foundation        | 1–2  | Claude calls `get_client` through the connector        | **Done** (pending the owner's local check) |
| Sign-in and audit | 3    | Sign-in works inside Claude (web) via custom connector | **Code done**, gate pending (WorkOS setup) |
| Documents         | 4–5  | Cited search + intake flow work end to end             | **Done** (verified over HTTP, offline)     |
| Accuracy          | 6    | First accuracy report published                        | **Done** (rules baseline); Claude run: owner |
| Dashboard         | 7    | Audit log, review queue, scores visible                | **Done** (verified against the live API)   |
| Ship              | 8    | Public launch: deployed, video, case study             | Files ready; deploy, video: owner          |

If a phase runs over, cut the HubSpot adapter and the demo login first, never the accuracy report.

## Status

- **Day 1 (done):** schema and migrations, PGlite/pg `Db`, demo firm, `get_client` with access check + audit, stateless
  HTTP (`AUTH_MODE=dev`) and stdio, Claude Code setup (CLAUDE.md, skills, hooks), 11 tests, CI.

- **Day 3 (code done, gate pending):** `AUTH_MODE=oauth`. `src/auth/oauth.ts` reads the provider's discovery document
  at start-up and verifies JWT access tokens with `jose` (signature via JWKS, issuer, audience, expiry; asymmetric
  algorithms only). `src/http.ts` serves `/.well-known/oauth-protected-resource/mcp`, protects `POST /mcp` with
  `requireBearerAuth` (401 carries the `resource_metadata` hint), maps the email claim to a staff member in
  `resolveActor()` (unknown → 403) and refuses unknown browser `Origin`s. Provider-agnostic: WorkOS or Auth0 is config
  only.
- **Days 4–5 (done):** migration 002; upload → pdf.js text (scans flagged for Claude vision) → chunks with a context
  line → embeddings (Voyage, or `local` offline) → pgvector. Hybrid search (vector + full-text + exact identifiers,
  RRF). Extraction: Claude Haiku 5.5 with structured outputs, Opus 5.5 when any required field is below 0.8 (server-side
  refusal fallback on the Opus call); `rules` extractor offline. Matching scores every client with reasons; file only at
  ≥ 0.85 and 0.15 clear of the runner-up (`FILE_THRESHOLD`, `FILE_MARGIN`); look-alikes need a second identifier.
  All 8 tools, signed expiring document links (`/files/:id`, re-checked + audited on open), R2/local storage, demo
  documents (3 inbox documents drive demo moments 2–4).
- **Day 6 (done, baseline):** `eval/dataset.ts` (60 docs, 30 questions, deterministic), `npm run eval`. Rules baseline:
  field accuracy 84.0%, wrong-client 0, review rate 25.0%, hit rate 100%, citation 96.7%. Changes and their effect in
  `eval/changes.json`. CI runs it on every push (`--check` fails on any wrong-client filing); the Claude run is a
  manual workflow (`workflow_dispatch`, needs the `ANTHROPIC_API_KEY` secret).
- **Day 7 (done):** dashboard in `dashboard/` (React 19 + Vite 7 + Tailwind 4 + shadcn-style components, TanStack
  Query/Table, Recharts) served at `/dashboard`. `/api` in `src/web/api.ts`; dev header or OAuth session cookie
  (`DASHBOARD_CLIENT_ID/SECRET`, code + PKCE, ID token checked). Partners resolve reviews; assistants see only their own
  audit rows, without details.
- **Day 8 (files ready):** `Dockerfile` (built and smoke-tested), `render.yaml`, `docs/DEMO-SCRIPT.md`,
  `docs/CASE-STUDY.md` (with `[[…]]` slots for the Claude numbers and URLs).
- Gotchas found: pdf.js needs `standardFontDataUrl` in Node; Recharts bar animation never finishes in headless Chrome
  (disabled); the review reason once leaked a hidden look-alike client's name to an assistant (now redacted, tested).
- Checks: typecheck, lint, 83 tests, eval, both builds and the container all pass locally. Vitest is capped at 3
  workers: unbounded, the parallel PGlite instances ran the 8 GB WSL machine out of memory.

## Next up: owner's list (in order)

1. **`.env.example`.** Claude Code's permission settings block it; add the new variables listed in `src/config.ts`
   (`PUBLIC_URL`, `OAUTH_*`, `DASHBOARD_CLIENT_*`, `SESSION_SECRET`, `LINK_SECRET`, `EXTRACTOR`, `ANTHROPIC_API_KEY`,
   `EMBEDDINGS`, `VOYAGE_API_KEY`, `STORAGE`, `FILES_DIR`, `R2_*`, `FILE_THRESHOLD`, `FILE_MARGIN`).
2. **Claude eval.** Set a spend limit in the Anthropic console, put `ANTHROPIC_API_KEY` in `.env`, run
   `npm run eval:claude` (about $0.10–0.30). With `VOYAGE_API_KEY` set too, search uses Voyage. Commit
   `eval/report.*`, add a line to `eval/changes.json` for anything you change, and fill the case study table.
3. **WorkOS (Day 3 gate).** AuthKit app, dynamic client registration on, redirect URI
   `https://claude.ai/api/mcp/auth_callback`, JWT template adding `email` to access tokens, email verification on,
   users Maya/Tom/Ana with passwords (`@northbridge.example` can't receive mail). For the dashboard, a second regular
   OAuth client with redirect `PUBLIC_URL/auth/callback` (`DASHBOARD_CLIENT_ID/SECRET`); if AuthKit can't issue one,
   skip it: the plan allows cutting the demo login.
4. **Local gate.** `ngrok http 3000`, run with `AUTH_MODE=oauth PUBLIC_URL=https://<ngrok> OAUTH_ISSUER=...`, add the
   connector in Claude, sign in as Tom then Maya. If requests 401 after sign-in, decode the token's `aud` and set
   `OAUTH_AUDIENCE` to it (never drop the check). Record the provider and gotchas here.
5. **Deploy.** Neon project (copy the connection string), R2 bucket + API token, Render → New → Blueprint →
   this repo; fill the `sync: false` values. Point the WorkOS redirect/allowed origins at the Render URL.
6. **Video and launch.** Follow `docs/DEMO-SCRIPT.md`, fill `docs/CASE-STUDY.md`, publish.

Run the `security-review` skill before each commit.
