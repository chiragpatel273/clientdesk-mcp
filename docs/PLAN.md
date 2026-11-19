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
- Files: Amazon S3 (any S3-compatible service, e.g. R2, by config). Hosting: Render or Fly.io.
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

| Phase             | Days | Gate to pass before moving on                          | Status                                   |
| ----------------- | ---- | ------------------------------------------------------ | ---------------------------------------- |
| Foundation        | 1–2  | Claude calls `get_client` through the connector        | **Done**                                 |
| Sign-in and audit | 3    | Sign-in works inside Claude (web) via custom connector | **Done** (WorkOS + ngrok, 2026-11-17)    |
| Documents         | 4–5  | Cited search + intake flow work end to end             | **Done** (verified over HTTP, offline)   |
| Accuracy          | 6    | First accuracy report published                        | **Done** (Groq run; Claude run optional) |
| Dashboard         | 7    | Audit log, review queue, scores visible                | **Done** (verified against the live API) |
| Ship              | 8    | Public launch: deployed, video, case study             | Files ready; deploy, video: owner        |

If a phase runs over, cut the HubSpot adapter and the demo login first, never the accuracy report.

## v2 (started 2026-11-19, branch `v2`)

Goal: make ClientDesk a proof-of-work for **senior full-stack / tech lead** roles: (a) a recruiter can try it with no
account, (b) it is measurably better, (c) it shows production engineering: background jobs, multi-tenancy, E2E
tests and LLM cost tracking. Everything is built and tested offline (rules extractor, `local-hash-v1`), with no
paid API calls and no deploys. The owner reviews at the end; decisions taken on the owner's behalf are logged below.

Build order: 1 → 2 → 3 → 5 → 6 → 4. Every phase must pass `npm run check` and `npm run eval -- --extractor=rules
--check`, get a security review, and be committed on its own.

| #   | Phase                    | Goal                                                                 | Gate                                                                                                                       | Status |
| --- | ------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Try the demo             | No login wall: a read-only demo session, enforced on the server      | Fresh browser → "Try the demo" → Overview, Inbox, Review, Audit, Accuracy; every write refused (403) and audited           | Done   |
| 2   | Search and citation miss | Right page wins; Voyage documented as the production embedder        | Offline citation ≥ 95%, 0 wrong-client filings, no metric worse (or the best honest result, explained)                     | Todo   |
| 3   | Batch intake + job queue | Upload many documents; a Postgres job queue processes them           | 10 uploads process in the background with visible progress; a forced failure retries, then dead-letters; worker tests      | Todo   |
| 5   | Playwright E2E           | The main journeys tested in a real browser, in CI                    | `npx playwright test` passes locally in under ~3 minutes                                                                   | Todo   |
| 6   | LLM usage and cost       | Every model call recorded (tokens, cost, latency); a Usage page      | An eval run and a batch upload both show on the Usage page; recording tested                                               | Todo   |
| 4   | Multiple firms           | `firm_id` everywhere, isolation in the domain layer and Postgres RLS | All tests, E2E and eval pass; cross-firm reads, writes, search, links and filings denied and audited, even with forged ids | Todo   |

### Phase plans

**Phase 1: Try the demo.**

- Schema: migration `003_demo_visitor.sql` adds `staff.read_only boolean not null default false`. The demo visitor
  (`st_demo`, `demo@northbridge.example`, role `partner`, read-only) is part of the seeded firm, and start-up adds
  it to an already-seeded database.
- `Actor.readOnly`. Enforced in two central places, so new routes and tools inherit it: the `/api` router refuses
  every non-GET request from a read-only actor (403 + `denied` audit row), and `runTool()` refuses tools declared
  as writes (`file_document`, `send_to_review`, `add_crm_note`) with `status: 'denied'` + audit row.
- `POST /auth/demo` (only when `DEMO_LOGIN=true`): issues a 2-hour session cookie marked `demo`, audited as
  `auth:demo_login`, rate-limited per IP (in memory: 5 a minute, 30 an hour). `GET /auth/options` tells the
  sign-in page whether to show the button. A demo cookie is refused once `DEMO_LOGIN` is turned off.
- The API reads a valid session cookie in both auth modes (dev mode falls back to the header), so the demo works
  locally too. Dashboard: "Try the demo" on the sign-in page (and in the dev user picker), a "Demo mode: read-only,
  fictional data" banner, "Exit demo" instead of the user switcher. Write controls stay visible: a visitor who tries
  one sees the server's refusal and then finds it in the audit log, which demonstrates the rule better than a
  hidden button.
- `TRUST_PROXY` (hops, default 0; `1` on Render) so the rate limiter sees the visitor's IP, not the proxy's.
- Risks: viewing an inbox document nobody has matched yet runs its extraction once (cached), as for staff; with a
  paid extractor a visitor can cause at most one extraction per inbox document.
- Risks: a public partner-level view shows every audit row, including inputs typed by the owner's own test
  sessions. All data is fictional; the owner should still avoid typing anything real into the live connector.

### Decisions made on the owner's behalf

(Each with its reason. Newest last.)

1. **Offline runs force offline settings.** Every check, eval and local server in v2 runs with
   `EXTRACTOR=rules EMBEDDINGS=local STORAGE=local` (and a throwaway database) plus blank API keys in the command's
   environment, because `.env` may hold real keys and S3 settings and `loadDotEnv()` would pick them up (real
   environment variables win over `.env`).
2. **The demo visitor is a partner-level, read-only staff row** (`st_demo`), not a role. Read-only is a property of
   the actor checked centrally (the `/api` router and `runTool()`), so it composes with roles and needs no second
   copy of the partner permissions. It is kept out of `STAFF` so `npm run workos:users` never creates a real login.
3. **`render.yaml` turns `DEMO_LOGIN` on** (and `TRUST_PROXY=1`), because the live dashboard exists to be tried by
   recruiters; the code default stays off. Nothing is deployed until the owner merges and syncs.
4. **Demo sessions last 2 hours** (staff sessions 8) and carry a `demo` claim, so turning `DEMO_LOGIN` off ends
   them at once even though the cookie is still validly signed.
5. **The demo rate limit is in memory** (5 a minute, 30 an hour per IP). Render's free plan runs one instance;
   with several instances each would count separately, which only loosens the limit. Redis would be the next step.

### Blocked / needs owner

(Nothing yet.)

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
  All 8 tools, signed expiring document links (`/files/:id`, re-checked + audited on open), S3/local storage, demo
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
  `docs/CASE-STUDY.md` (slots filled 2026-11-17 with the Groq numbers, video and live URLs).
- **2026-11-09 to 11-17 (owner steps 1–5):** `.env` is now loaded by every entry point (`loadDotEnv()`; real env
  wins). Groq extractor (`src/ai/groq-extractor.ts`: `openai/gpt-oss-20b`, escalating to `gpt-oss-120b`, strict JSON
  schema, waits out 429s; text only, so scans go to review); the prompt is shared with Claude in
  `src/ai/extraction-prompt.ts`. Groq eval: field accuracy 98.1%, wrong-client 0, review rate 10.0%, hit rate 100%,
  citation 93.3% (miss). `npm run workos:users` creates Maya/Tom/Ana as verified users. Sign-in gate passed in
  claude.ai through WorkOS AuthKit (staging) and a static ngrok domain: Tom refused Lakeside, intake flow works.
- WorkOS setup that worked: Connect → Configuration with Dynamic Client Registration (and CIMD) on; a Resource
  Indicator `PUBLIC_URL/mcp` set as default (that makes the token's `aud` equal our resource URL, so no
  `OAUTH_AUDIENCE` needed); JWT template `{"email": {{ user.email }}}`; Email + Password on. Email verification is
  always on in AuthKit, so the users are created via the API with `email_verified: true`. No redirect URI setup was
  needed for Claude (it registers its own).
- Gotchas found: pdf.js needs `standardFontDataUrl` in Node; Recharts bar animation never finishes in headless Chrome
  (disabled); the review reason once leaked a hidden look-alike client's name to an assistant (now redacted, tested).
- Checks: typecheck, lint, 83 tests, eval, both builds and the container all pass locally. Vitest is capped at 3
  workers: unbounded, the parallel PGlite instances ran the 8 GB WSL machine out of memory.

## Next up: owner's list (in order)

Done: 1 `.env.example`, 2 local run, 3 eval (Groq), 4 WorkOS, 5 Claude connector gate, 6 deploy (2026-11-17:
https://clientdesk-mcp.onrender.com on Render free, Neon in us-west-2, S3 bucket in ap-southeast-2, Groq extractor;
verified in claude.ai as Tom). First deploy lesson: a pasted leading space in `S3_REGION` broke the first start
half-way through seeding; settings are now trimmed and start-up finishes a partial demo load.

7. **Dashboard sign-in** (optional; the plan allows cutting it). A WorkOS OAuth app with redirect
   `PUBLIC_URL/auth/callback` → `DASHBOARD_CLIENT_ID/SECRET`. Without it the dashboard only works with `AUTH_MODE=dev`.
8. **Video and launch.** Follow `docs/DEMO-SCRIPT.md`, fill `docs/CASE-STUDY.md` (Groq numbers, or rerun with Claude),
   update README numbers, publish.

Run the `security-review` skill before each commit.
