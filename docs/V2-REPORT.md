# ClientDesk v2 report

Built on branch `v2` (from `main` at `6bf57a9`), 2026-11-19, in one run. Nothing was pushed or deployed, no paid or
keyed API was called (every run used the offline extractor and embeddings), and no existing history was rewritten.
101 files changed, about 7,100 lines added.

## What was built

| #   | Phase                        | Commit    | In one line                                                                                                         |
| --- | ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Try the demo                 | `4421e64` | A "Try the demo" button: read-only, partner-level session, enforced on the server, audited, rate-limited            |
| 2   | Search and the citation miss | `6316918` | Three general ranking changes; offline citation accuracy 93.3% → 100%; Voyage documented as the production embedder |
| 3   | Batch intake + job queue     | `236b4a4` | Postgres job queue (`SKIP LOCKED`), retries, dead-letter, idempotency, stuck reclaim; per-document progress UI      |
| 5   | Playwright E2E               | `5e76a74` | Chromium tests against the real server, in CI with traces on failure                                                |
| 6   | LLM usage and cost           | `291d1d7` | Every model call recorded (tokens, cost, latency, escalations, errors); a Usage page                                |
| 4   | Multiple firms               | `940f46d` | `firm_id` everywhere, isolation in the domain layer and by Postgres RLS, a second firm, 21 cross-firm tests         |
|     | Docs, upgrade test, Docker   | final     | README, case study, demo script, this report; a v1 → v2 database upgrade test; baseline report in the image         |

### Phase 1: Try the demo

- Migration `003`: `staff.read_only`. The demo visitor (`st_demo`, "Demo Visitor") is a partner-level, read-only
  staff row, added to databases seeded before v2 at start-up.
- Read-only is enforced in two central places, so new routes and tools inherit it: the `/api` router refuses every
  non-GET request before reading its body (403 + `denied` audit row), and `runTool()` refuses tools declared as writes.
- `POST /auth/demo` (only with `DEMO_LOGIN=true`): CSRF header, per-IP limit (5 a minute, 30 an hour), audited,
  2-hour session with a `demo` claim that stops working as soon as `DEMO_LOGIN` is off. `GET /auth/options` tells the
  sign-in page whether to show the button; `TRUST_PROXY` lets the limit see the visitor's IP behind Render's proxy.
- Dashboard: the button, a "Demo mode: read-only, fictional data" banner, "Exit demo". Write controls stay visible:
  a visitor who tries one sees the server's refusal, then finds it in the audit log.

### Phase 2: Better search and the citation miss

- Diagnosis: q_18 cited page 1 of a two-page statement whose closing balance is on page 2 (every identifying word is
  on page 1). q_27 had two right answers (one bank sent Hana Kim a 1098 and a 1099-DIV for 2025; the paraphrase didn't
  name the form). A dataset bug, fixed and reported as such, along with two more of the same kind.
- General fixes: passages repeat their document's key identifiers and name the extracted fields they hold by
  description ("balance at the end of the period"); within a document the cited page is chosen by the question words
  its passages don't all share; query-term coverage is a fourth ranked list in the fusion.
- Guard against overfitting: a 72-question robustness set (both question variants for every searchable document) is
  in every report. Its one remaining miss is published.
- Migration `004` (`passage_version`): start-up rebuilds passages from an older format or another embedder, so this
  deploy and a later switch to Voyage need no manual step (`npm run reindex` exists).
- Offline runs now write `eval/baseline.*`; model runs keep `eval/report.*`, so the free run never overwrites the
  published Groq report. The Accuracy page switches between them.

### Phase 3: Batch intake with a Postgres job queue

- Migration `005`: `batches`, `jobs` (step, status queued/running/done/dead, attempts, `run_at` backoff,
  `locked_at`/`locked_by`, unique `idempotency_key`), and a `processing` document status that `list_inbox` and
  `file_document` skip, so Claude can't race the worker.
- Pipeline per document, one audited step per claim: stored → text_extracted → embedded → fields_extracted →
  matched → filed | review. Runs as the uploading partner, re-checking their role every step and `canAccessClient`
  before filing. Filing rules are unchanged. A dead job hands its document back to the inbox; partners can retry it.
- Why Postgres, not BullMQ/Redis: no second service to run, pay for, secure or back up; `SKIP LOCKED` gives the same
  one-worker-per-job guarantee; jobs are queryable for the dashboard and audit trail; tests run it in PGlite.
  Redis earns its place at thousands of jobs a second; intake here is tens of documents an hour.
- Measured locally: 10 documents settled in about 1.5 s (offline extractor), 9 filed and 1 sent to review (the
  Petrova/Petrovic look-alike).

### Phase 5: Playwright end-to-end tests

9 tests, Chromium, about 60 s locally including the dashboard build and server start (budget: 3 minutes): partner
sees all pages; assistant refused an unassigned client (a real MCP call) and the refusal is in the audit log;
assistant sees only their own audit rows without details; partner resolves a review item; demo visitor reads
everything and an upload is refused and audited; batch upload shows progress; the Usage page shows the batch and the
eval run; a second firm's partner sees only their firm. The suite found one real bug: the audit log page showed a
15-second-old list, so a refusal you had just caused wasn't there (fixed).

### Phase 6: LLM usage and cost

- Migration `006`: `llm_calls`. No prompts, document text or answers; errors are stored as a category ("Groq 400")
  because provider messages can echo the model's partial output.
- Prices in one file, `src/ai/prices.ts` (USD per million tokens): Claude Haiku 5.5 $0.10/$0.50, Opus 5.5 $4/$20,
  Groq gpt-oss-20b $0.075/$0.30, gpt-oss-120b $0.15/$0.60, Voyage 3.5 $0.06; offline models 0 with estimated tokens.
- Recording without plumbing: call sites report through `timedCall`; who and why come from an `AsyncLocalStorage`
  scope set by `runTool()`, the dashboard API, the job worker and start-up. The eval totals its own usage into its
  report, which the Usage page lists.
- Usage page (partners): calls, tokens, cost, average latency, escalation rate, error rate, cost per filed document,
  per day (one measure at a time), per model, per source.

### Phase 4: Multiple firms

- Migration `007`: `firms`; `firm_id` on 12 tables, backfilled to Northbridge, then defaulting to the transaction's
  `app.firm_id` (an insert outside a firm fails instead of landing somewhere); composite same-firm foreign keys; per-firm
  duplicate detection (a global check would reveal that another firm holds the same file); RLS policies; role
  `clientdesk_app`; `clientdesk_owner_firm()` (security definer, returns only which firm owns an id).
- Layer 1: `Db.forFirm(firmId)` hands out a scoped handle; every domain query filters `firm_id = firmOf(db)`, which
  throws on an unscoped handle (fails closed). Layer 2: each scoped query runs in its own transaction as
  `clientdesk_app` with `app.firm_id` set, so RLS applies even to raw SQL. The owner connection is only for identity
  lookup, the job queue's claim/advance, migrations and start-up.
- Another firm's id answers exactly like "not found" (no way to probe) and is audited as `denied`.
- Second fictional firm: Harbourline Tax Partners (Lena Ortiz, partner; Sam Okafor, assistant) with its own
  "Acme Ltd", a filed invoice and an inbox invoice billed to "Acme Ltd".
- Tests: RLS alone (raw SQL, cross-firm insert/update/delete, insert outside a firm), the domain layer alone, the
  schema's foreign keys on the owner connection, MCP tools by name and forged id, search, matching, inbox, filing,
  signed links with a valid signature, dashboard routes, job retry, a second firm's batch job and its usage rows,
  per-firm dedupe; and an upgrade test from a v1 database with data.

## Accuracy, before and after

| Metric                   | Groq run (published, 2026-11-09, before v2) | Offline before v2 | Offline after v2 | Target |
| ------------------------ | ------------------------------------------- | ----------------- | ---------------- | ------ |
| Field accuracy           | 98.1%                                       | 84.0%             | 84.0%            | ≥ 95%  |
| Wrong-client filings     | 0                                           | 0                 | 0                | 0      |
| Review-queue rate        | 10.0%                                       | 25.0%             | 25.0%            | ≤ 10%  |
| Search hit rate (top 5)  | 100%                                        | 100%              | 100%             | ≥ 90%  |
| Citation accuracy        | 93.3% (miss)                                | 93.3% ¹           | **100%**         | ≥ 95%  |
| Robustness set, citation | not measured                                | 93.1% ¹           | **98.6%**        | none   |

¹ On the corrected question set. On the original questions the offline run scored 96.7% (q_27's two right answers
happened to land the right way). Ablation (corrected questions, 30 / 72): context lines alone 93.3% / 91.7%; page
choice + coverage on the old context 96.7% / 97.2%; context + page choice 100% / 97.2%; all three 100% / 98.6%. No
asked question got worse; one robustness question flipped to a near-tie (eng_03 paraphrased, 0.0487 vs 0.0484:
"pay for the work" meaning "fee" needs semantic embeddings). Extraction is unchanged in v2, so field accuracy and
review rate only move with a model run. The Groq column needs a rerun to show v2's search changes.

Tests: 104 before v2; now 174 vitest tests and 9 Playwright tests.

## Decisions made on your behalf

All 21 are in `docs/PLAN.md` ("Decisions made on the owner's behalf") with their reasons. The ones most worth a
second look:

1. Every check, eval and local server ran with offline settings forced in the environment (`.env` may hold keys).
2. The demo visitor is a read-only partner-level staff row, not a new role; read-only is checked centrally.
3. `render.yaml` turns `DEMO_LOGIN` on (code default off), with `TRUST_PROXY=1`.
4. Demo sessions last 2 hours and stop working the moment `DEMO_LOGIN` is turned off.
5. The demo rate limit is in memory (one instance on Render free).
6. Three ambiguous eval questions were corrected, reported as a dataset fix with the old ranking's score on the new
   set, so the system gain isn't inflated.
7. The Groq run was not replayed or estimated: it needs a real rerun.
8. The offline eval writes `eval/baseline.*` so it never overwrites the published model report.
9. Start-up rebuilds stale passages automatically (you can't reach Neon's port 5432 from your network).
10. Batch intake files clear matches automatically (the phase asks for "filed or sent to review"); every filing gets
    a CRM note and audit rows. Filing through Claude still asks the user first.
11. Single-file upload stays for every staff member; batch intake is partners only.
12. A dead job hands its document back to the inbox.
13. The worker runs inside the web process (Render free has no background workers); `npm run worker` exists.
14. Playwright is pinned to 1.58.2, the version whose Chromium was already on this machine.
15. E2E specs share one server and run in order (fresh servers would blow the 3-minute budget).
16. Usage recording uses AsyncLocalStorage; errors are stored as a category only.
17. Groq and Voyage prices are third-party-checked estimates (the price file says so).
18. RLS uses a transaction per query, not per request (no transactions held across model calls).
19. Another firm's id answers "not found", audited as `denied`.
20. The second firm is seeded wherever the demo is, including production; its staff have no WorkOS logins.
21. Dev mode's user picker lists every firm's staff.

## Blocked or skipped

Nothing in the spec was skipped. Not verifiable from here:

- **Migration 007 on Neon.** It creates role `clientdesk_app` and grants it to the connecting user. Postgres 16+
  allows this for a role with `CREATEROLE` (Neon's owner role has it), and it works on PGlite, but it hasn't run on
  Neon. If it fails, start-up stops at the migration with the error in Render's logs, nothing is half-applied (each
  migration runs in one transaction), and `main` keeps working on the old schema.
- **Real-model numbers** for v2's search changes (Groq, Claude, Voyage): not run, by the no-keys rule.
- **Live demo:** the README and case study describe the deployed v2 (Try the demo, Usage page). Merge and deploy
  together so the live site matches.

## Your steps

1. **Review and merge.** `git log main..v2` is the six phase commits plus the docs commit. Push the branch and open a
   PR as usual; CI now has four jobs: check, eval (offline), e2e (Playwright) and the manual Claude eval.
2. **Render settings** (Environment):
   - `DEMO_LOGIN=true` and `TRUST_PROXY=1` (both in `render.yaml`; add them by hand if the service isn't synced from
     the blueprint).
   - Nothing else is required. Optional: `WORKER_CONCURRENCY` (default 2), `JOB_MAX_ATTEMPTS` (5),
     `JOB_BACKOFF_MS` (2000), `JOB_STUCK_SECONDS` (300). `WORKER=1` is the default.
3. **What happens on deploy** (automatic, in Render's logs): migrations `003_demo_visitor` through `007_firms` apply
   in order; existing rows are backfilled to Northbridge; "Added the read-only demo visitor."; "Seeded the Harbourline
   Tax Partners demo firm." and "Loaded 2 Harbourline Tax Partners demo documents."; "Rebuilt search passages for
   N firm_northbridge documents". Before deploying, Neon's point-in-time restore (or a branch) is your rollback.
4. **Check the live site:** open `/dashboard` in a private window → **Try the demo** → every page loads; try an upload
   and see the refusal, then the `dashboard:upload` / Denied row in the audit log. Sign in as Maya → Inbox → Batch
   intake with two or three demo PDFs → Usage page.
5. **Measured runs with your keys** (each writes `eval/report.*`; commit it to publish):
   - Groq (free tier, about 10 minutes because of rate limits): `npm run eval -- --extractor=groq`. Updates the
     published citation number for v2's search and adds the run's usage to the Usage page.
   - Claude (costs money; about $0.05–0.40: 60 documents on Haiku 5.5 at $0.10/$0.50 per million tokens, plus Opus
     5.5 at $4/$20 for the unsure ones): `npm run eval:claude`, or Actions → CI → Run workflow with the
     `ANTHROPIC_API_KEY` secret.
   - Voyage (`voyage-3.5`, about $0.002 per run, likely inside the free allowance): add `VOYAGE_API_KEY` and run
     `npm run eval -- --extractor=groq --out=eval/voyage` to compare with the keyword embedder before switching
     production. To switch production, add `VOYAGE_API_KEY` on Render: the next start re-embeds every passage.

## Try each feature locally

```bash
npm install && npm run dashboard:install && npm run dashboard:build
DEMO_LOGIN=true npm run dev            # http://localhost:3000/dashboard/
```

- **Try the demo:** user picker (top right) → "Try the demo (read-only)"; the banner appears; try an upload or a
  review filing and find the refusal in the audit log; "Exit demo" returns.
- **Search:** `npm run eval -- --extractor=rules` → `eval/baseline.md` (citation 100%, robustness section). Accuracy
  page → "Offline baseline (CI)".
- **Batch intake:** as Maya → Inbox → "Choose files for a batch" → pick several PDFs or .txt files; watch each step;
  the failed-jobs card appears if any job dead-letters. `npm run worker` runs the worker on its own (`WORKER=0`).
- **Usage:** after a batch, the Usage page (partners only) shows calls per day, per model and per source.
- **Multiple firms:** user picker → "Lena Ortiz · Partner · Harbourline Tax Partners": the header, inbox, audit log and
  usage all switch to Harbourline; Northbridge's documents are invisible, even by id.
- **Tests:** `npm run check` (174 tests), `npx playwright test` (9 tests, about a minute).

## Resume bullets (v2, real numbers)

Accurate for the branch as built; claim "live" for the v2 features only once it is deployed, and the CI runs only once
the branch is pushed.

- Re-architected a live Claude/MCP document-intake app (TypeScript, Postgres) for multi-tenancy: `firm_id`
  isolation enforced twice, in the domain layer and with Postgres row-level security plus same-firm foreign keys,
  proven by 21 cross-firm tests with forged ids, with a tested upgrade path for existing data.
- Built batch document intake on a Postgres job queue (`FOR UPDATE SKIP LOCKED`) with retries, exponential backoff,
  dead-lettering, idempotency keys and stuck-job recovery, plus per-model LLM cost tracking (tokens, cost, latency,
  escalations) behind a usage dashboard.
- Raised RAG citation accuracy from 93.3% to 100% with general ranking fixes validated against a 72-question
  robustness set (93.1% → 98.6%); grew the suite from 104 to 174 tests plus 9 Playwright end-to-end tests with a CI
  job, and built a server-enforced, rate-limited read-only demo mode.

## What to re-record in the demo video

The current video (1:56) still holds for Claude. Add, or replace the dashboard part with:

1. A private window on the live dashboard → **Try the demo** → the banner; try an upload → refused → the Denied row
   in the audit log (about 15 s).
2. Maya → Inbox → **Batch intake** with 5–10 demo files: the per-document progress, mostly "Filed to …", one look-alike
   "Sent to review" (about 20 s).
3. **Usage** page right after the batch: calls, tokens, cost per filed document (about 10 s).
4. Accuracy page: citation 100% offline and the robustness check (about 10 s), once the Groq rerun is published.
5. Optional, recorded locally in dev mode: switch to Lena (Harbourline): same "Acme Ltd" name, different firm, none of
   Northbridge's documents (about 10 s).
