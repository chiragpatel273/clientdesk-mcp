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
| 2   | Search and citation miss | Right page wins; Voyage documented as the production embedder        | Offline citation ≥ 95%, 0 wrong-client filings, no metric worse (or the best honest result, explained)                     | Done   |
| 3   | Batch intake + job queue | Upload many documents; a Postgres job queue processes them           | 10 uploads process in the background with visible progress; a forced failure retries, then dead-letters; worker tests      | Done   |
| 5   | Playwright E2E           | The main journeys tested in a real browser, in CI                    | `npx playwright test` passes locally in under ~3 minutes                                                                   | Done   |
| 6   | LLM usage and cost       | Every model call recorded (tokens, cost, latency); a Usage page      | An eval run and a batch upload both show on the Usage page; recording tested                                               | Done   |
| 4   | Multiple firms           | `firm_id` everywhere, isolation in the domain layer and Postgres RLS | All tests, E2E and eval pass; cross-firm reads, writes, search, links and filings denied and audited, even with forged ids | Done   |

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

**Phase 2: Better search and the citation miss.**

- Diagnosis (from `eval/report.md`): q_18 cites page 1 of a two-page statement whose closing balance is on page 2:
  every word that picks the document (client, bank, account 9950) is on page 1, and the exact-identifier list
  rewards it twice. q_27 has two right answers: Hana Kim has a 1098 and a 1099-DIV from Summit Savings Bank for
  2025, and the paraphrased question doesn't name the form (a dataset bug; the uniqueness check used the form type).
- Fixes, all general: (1) passage context repeats key identifiers and names the extracted fields a passage holds by
  description; (2) within a document, the page is chosen by question words its passages don't all share; (3)
  query-term coverage as a fourth RRF list. Dataset: paraphrases name the invoice number / kind of amount.
- Wider check: 72 questions (both variants for every searchable document) in every report. Not independent: it
  includes the 30 and was looked at while tuning.
- Schema: migration `004_passage_version.sql`; start-up rebuilds passages from an older format or another embedder,
  so the deploy and a later switch to Voyage need no manual step (`npm run reindex` exists for by hand).
- Offline runs write `eval/baseline.*` (CI artifact); model runs keep `eval/report.*`, so the published Groq report
  is never overwritten by the free run. The dashboard's Accuracy page switches between them.
- Risks: start-up reindexing blocks start for large databases (13 documents here: instant; Phase 3's job queue is
  the place to move it); the Groq numbers stay pre-v2 until the owner reruns it.

**Phase 3: Batch intake with a background job queue.**

- Schema: migration `005_jobs.sql`: `batches` (who uploaded how many) and `jobs` (one row per document: `step`,
  `status` queued/running/done/dead, `attempts`/`max_attempts`, `run_at` for backoff, `locked_at`/`locked_by`,
  `last_error`, unique `idempotency_key`). Documents get a `processing` status so a half-processed document is
  invisible to `list_inbox`/`file_document` (no race with Claude filing it by hand).
- Queue (`src/jobs/queue.ts`): claim with one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`,
  so several workers (or instances) never take the same job; attempts are counted at claim time, so a job whose
  worker died (`locked_at` older than the stuck timeout) is reclaimed and still runs out of attempts. Failure:
  exponential backoff (`run_at`), then `dead` after `max_attempts` (dead-letter), retryable by a partner.
- Pipeline (`src/jobs/intake.ts`), one step per claim, each step audited as `job:<step>` (filing and review: one statement with the job's state, since 2026-11-24) for the
  uploader: stored (at upload) → text_extracted → embedded → fields_extracted → matched → filed | review. Filing uses
  the same `matchClients` rule (0.85, 15 points clear, look-alikes need a second identifier) and re-checks the
  uploader's access to the client at the filing step. A dead job puts the document back in the inbox, so the manual
  path (Claude) still works.
- Worker (`src/jobs/worker.ts`) runs in the web process (`WORKER=1`, `WORKER_CONCURRENCY=2`): Render's free plan
  has no background workers; the same code runs as a separate process with `npm run worker`.
- API (partners only, read-only refused): `POST /api/batches`, `POST /api/batches/:id/files` (raw body,
  `Idempotency-Key`), `GET /api/batches/:id` (per-document progress), `GET /api/jobs?status=dead`,
  `POST /api/jobs/:id/retry`. Dashboard: a "Batch intake" card on the Inbox page with per-document progress.
- **Why Postgres and not BullMQ/Redis:** the queue lives in the database the app already has (Neon), so there is
  no second service to run, pay for, secure or back up; enqueueing can share a transaction-free single statement
  with the document insert; `SKIP LOCKED` gives the same at-most-one-worker-per-job guarantee; jobs are queryable
  with SQL for the dashboard and the audit trail; and tests run it in PGlite. Redis wins at thousands of jobs a
  second or with delayed-job fan-out; intake here is tens of documents an hour.
- Risks: polling (default every second) costs a cheap indexed query per worker; LISTEN/NOTIFY would cut it but
  doesn't exist in PGlite. A step that succeeds but crashes before recording it runs again: those before the decision only rebuild the same
  thing; the decision itself is atomic (the first version's wasn't).

**Phase 5: Playwright end-to-end tests.**

- `playwright.config.ts`: Chromium only; `webServer` builds the dashboard and starts the real server on :3399 with
  explicit offline settings (in-memory PGlite, rules extractor, local embeddings, local files, blank keys), so a
  developer's `.env` can't leak keys or S3 into a test run. One worker: the specs share one database and run in file
  order (`e2e/1-…` to `5-…`).
- Specs: partner sees all five pages; assistant refused an unassigned client (a real MCP `tools/call` over
  Streamable HTTP) and the refusal shows in the partner's audit log; assistant sees only their own rows, no details,
  no batch intake; partner resolves a review item Claude sent to review; demo visitor reads everything, an upload is
  refused and audited, Exit demo; batch upload shows progress until every document is filed or reviewed.
- CI job `e2e`: installs Chromium, runs the suite, uploads traces and screenshots on failure.
- Found and fixed by the suite: the audit log page showed a cached list for 15 s, so a refusal you had just caused
  wasn't there; it now always reloads when opened.

**Phase 6: LLM usage and cost panel.**

- Schema: migration `006_llm_calls.sql` (time, staff, source mcp/dashboard/job/startup/script, operation
  extract/embed/rerank, provider, model, input/output tokens, `tokens_estimated`, `cost_usd`, latency, escalated,
  success, a short error category, document and job ids). No prompts, document text or answers.
- Prices in one file, `src/ai/prices.ts` (Claude Haiku 5.5 $0.10/$0.50, Opus 5.5 $4/$20, Groq gpt-oss-20b
  $0.075/$0.30, 120b $0.15/$0.60, Voyage 3.5 $0.06 per million tokens; offline models 0).
- Recording without plumbing: each call site reports through `timedCall`/`reportCall`; who and why come from an
  `AsyncLocalStorage` scope set by `runTool()`, the dashboard API, the job worker and start-up. Recording never
  throws. Offline models record estimated tokens (characters / 4) at cost 0.
- The eval runs in its own process and database, so it totals its usage into its report (`usage`); the Usage page
  lists the latest model run's and the baseline's next to the live numbers.
- `GET /api/usage?days=` (partners): calls, tokens, cost, average latency, escalation rate, error rate, cost per
  filed document, per day, per model, per source. Dashboard "Usage" page (partners only in the nav).
- `rerank` is in the schema for a future model reranker; today's page rerank is lexical and makes no model call.

**Phase 4: Multiple firms (multi-tenancy).**

- Schema: migration `007_firms.sql`: `firms`; `firm_id` on every firm-owned table (staff, clients, assignments,
  contacts, open items, notes, documents, chunks, audit log, batches, jobs, llm_calls), backfilled to Northbridge.
  Afterwards the column defaults to the transaction's `app.firm_id` setting, so an insert outside a firm scope fails
  (NOT NULL) instead of landing in some firm. Composite foreign keys `(firm_id, client_id)` etc. make a cross-firm
  reference impossible even for a bug that bypasses both layers. Document dedupe becomes per firm
  (`unique (firm_id, content_sha256)`), so an upload can't reveal that another firm holds the same file.
- Layer 1, domain: `Db.forFirm(firmId)` returns a firm-scoped handle; every domain query on firm data calls
  `firmOf(db)` (throws on an unscoped handle: fail closed) and filters `firm_id = $n`. `resolveActor()` reads the
  staff member's firm; MCP servers, dashboard requests, signed links and job steps get the scoped handle.
- Layer 2, Postgres RLS: every query through a scoped handle runs in its own transaction as role `clientdesk_app`
  (no BYPASSRLS, not the table owner) with `set_config('app.firm_id', $1, true)`; policies `using` and
  `with check (firm_id = current_setting('app.firm_id', true))`. The owner connection (no RLS) is used only for
  migrations, identity lookup (email → staff and firm), the job queue's claim/advance and start-up.
- Cross-firm ids: a lookup by an id that belongs to another firm answers exactly like "not found" (no existence
  oracle) but is audited as `denied`, via a `security definer` SQL function that returns only which firm owns an id.
- Second fictional firm: Harbourline Tax Partners, with its own staff and a client also called "Acme Ltd".
- Risks: per-query transactions add round trips on Neon (begin+role, setting, query, commit); fine at this scale,
  a request-level transaction is the next step. On Neon the migration creates role `clientdesk_app` and grants it to
  the connecting user; if Neon refused that, start-up fails loudly at migration 007 (owner to check in staging).

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
6. **Reworded six eval questions** because two of them had two right answers: a question with two right answers
   measures nothing. The rewording lowers v1's score (96.7% → 93.3%), so the like-for-like gain is 96.7% → 100% on the
   original questions (corrected 2026-11-24; the first write-up compared against 93.3%).
7. **Did not replay the Groq run.** Its extractions could be reconstructed from the report, but the honest update
   is a real rerun (free tier), listed for the owner. The README labels the Groq column "before v2 search".
8. **Offline eval output moved to `eval/baseline.*`**, so the spec'd `npm run eval -- --extractor=rules --check`
   no longer overwrites the published model report.
9. **Startup reindexing instead of a manual step**: the owner can't reach Neon's port 5432 from their network.
10. **Batch intake files automatically** when the match rule says `file` (the rule `file_document` enforces), because
    the phase asks for "filed or sent to review". Through Claude a person still confirms each filing; in a batch the
    partner who uploads it has chosen automatic filing, and every filing gets a CRM note and audit rows.
11. **The single-file upload stays for every staff member** (Claude files those, with confirmation); batch intake is
    partners only, as specified.
12. **A dead job hands its document back to the inbox** rather than leaving it stuck in `processing`, so a person (or
    Claude) can still deal with it; a partner's retry takes it back only if nobody has handled it meanwhile.
13. **The worker runs inside the web process** on Render (no paid background worker needed); `npm run worker` exists
    for running it separately.
14. **Playwright pinned to 1.58.2**, the version whose Chromium is already cached on this machine (no 150 MB browser
    download); CI installs its own. Bump with `npm i -D @playwright/test@latest && npx playwright install chromium`.
15. **E2E specs share one server and run in order** rather than each seeding its own database: a fresh server per
    spec would cost ~15 s each (seeding renders 13 PDFs) and push the suite past the 3-minute budget.
16. **Usage recording uses AsyncLocalStorage**, not an extra parameter on every extractor and embedder: the call
    sites stay small and a new route only needs a scope. **Errors are stored as a category** ("Groq 400"), because
    provider error messages can echo the model's partial answer.
17. **Prices are third-party-checked estimates** for Groq and Voyage (their pricing pages weren't reachable directly);
    the file says so and is the one place to correct them.
18. **Per-query transactions for RLS**, not one transaction per request: no long transactions held open across model
    calls (seconds), no aborted-transaction cascades, and PGlite (one connection) stays safe under concurrent
    requests because each scoped query is atomic. Cost: three extra round trips per query on Neon.
19. **Every unknown id answers "not found" and is audited as `denied`, "unknown id"**, whether it belongs to another firm
    or to nobody: the first version logged the difference in the firm's own audit log, which is the oracle it meant to
    avoid. Cross-firm attempts go to `security_events` (owner only), through a function that returns nothing.
20. **The second firm is seeded everywhere the demo is**, including production, so isolation can be shown live; its
    staff have no WorkOS logins (dev mode only), so on the live site nobody can sign in as them.
21. **Dev mode's user picker lists every firm's staff**, so a developer can switch firms; it is unavailable in OAuth
    mode.

22. **Security review by a second agent** (2026-11-24), because the author's own passes had missed real problems. All high
    and medium findings and most low ones fixed in migration 008 and code; list in `docs/V2-REPORT.md`.
23. **An idle worker sleeps** until a retry is due or an upload wakes it, instead of polling Neon every second; a worker in
    its own process polls every 2 s.
24. **Limits on a document** (300 pages, 500,000 characters): larger ones are refused rather than cut short.

### Blocked / needs owner

Nothing was blocked in the build. These need the owner (details and commands in `docs/V2-REPORT.md`):

- **Neon: migrations 007 and 008** (007 creates role `clientdesk_app`). Run on PGlite, 007 also on a local Postgres 18 as a
  non-superuser; not on Neon. After 007 the v1 code can't write, so a rollback needs a database restore.
- **Render:** `DEMO_LOGIN=true` and `TRUST_PROXY=1` (in `render.yaml`; add by hand if the service isn't synced from
  the blueprint).
- **Measured runs with keys** (none were made): Groq eval (free), Claude eval (about $0.05–0.40), Voyage.
- **Re-record the demo video** for Try the demo, batch intake, the Usage page and firm isolation.

## Status

- **v2 (2026-11-19, branch `v2`, not merged or deployed):** all six phases built offline and committed one by one:
  1 Try the demo, 2 search (citation 96.7% → 100% offline, same questions), 3 batch intake on a Postgres job queue, 5 Playwright
  E2E, 6 LLM usage and cost, 4 multiple firms with RLS. 205 vitest tests + 15 Playwright tests, offline eval,
  both builds and the Docker image pass. Report: `docs/V2-REPORT.md`.

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
