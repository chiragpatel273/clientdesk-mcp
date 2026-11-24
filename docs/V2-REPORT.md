# ClientDesk v2 report

Built on branch `v2` (from `main` at `6bf57a9`) on 2026-11-19; corrected and hardened on 2026-11-24 (see
"Corrections" and "Security review"). Nothing has been pushed or deployed, no paid or keyed API was called (every run used
the offline extractor and embeddings), and no existing history was rewritten.

## What was built

| #   | Phase                        | Commit    | In one line                                                                                                                       |
| --- | ---------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Try the demo                 | `4421e64` | A "Try the demo" button: read-only, partner-level session, enforced on the server, audited, rate-limited                          |
| 2   | Search and the citation miss | `6316918` | Three ranking changes; offline citation accuracy 96.7% → 100% on the same questions; Voyage documented as the production embedder |
| 3   | Batch intake + job queue     | `236b4a4` | Postgres job queue (`SKIP LOCKED`), retries, dead-letter, idempotency, stuck reclaim; per-document progress UI                    |
| 5   | Playwright E2E               | `5e76a74` | Chromium tests against the real server, in CI with traces on failure                                                              |
| 6   | LLM usage and cost           | `291d1d7` | Every model call recorded (tokens, cost, latency, escalations, errors); a Usage page                                              |
| 4   | Multiple firms               | `940f46d` | `firm_id` everywhere, isolation in the domain layer and by Postgres RLS, a second firm, 21 cross-firm tests                       |
|     | Docs, upgrade test, Docker   | final     | README, case study, demo script, this report; a v1 → v2 database upgrade test; baseline report in the image                       |

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
  on page 1): a real ranking miss, in both the Groq and offline runs. q_27 (a miss only in the Groq run) had two right
  answers: one bank sent Hana Kim a 1098 and a 1099-DIV for 2025, and the question didn't name the form. One more asked
  question (q_24) had the same problem. The fix reworded all six asked questions of those two kinds.
- General fixes: passages repeat their document's key identifiers and name the extracted fields they hold by
  description ("balance at the end of the period"); within a document the cited page is chosen by the question words
  its passages don't all share; query-term coverage is a fourth ranked list in the fusion.
- A wider check: 72 questions (both phrasings for every searchable document) in every report. It includes the 30 asked
  ones, and its misses were looked at while tuning, so it shows breadth but is not an independent test. The passage
  wording was also adjusted while looking at q_18.
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

15 tests, Chromium, about 60 s locally including the dashboard build and server start (budget: 3 minutes): partner
sees all pages; assistant refused an unassigned client (a real MCP call) and the refusal is in the audit log;
assistant sees only their own audit rows without details; partner resolves a review item; demo visitor reads
everything and an upload is refused and audited; batch upload shows progress; the Usage page shows the batch and the
eval run; a second firm's partner sees only their firm. Added on 2026-11-24: duplicate and refused files in a batch, and, against a
server with real sign-in switched on and a stand-in provider, the actual sign-in page: Try the demo, staff sign-in and
sign-out, and the dev header doing nothing. The suite found one real bug: the audit log page showed a
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
- Every unknown id is answered as "not found" and audited as `denied`, "unknown id", whether it belongs to another firm or
  to nobody, so neither the answer nor the firm's own log can be used to probe. Real cross-firm attempts are recorded in
  `security_events`, which only the database owner can read (migration 008 replaced `clientdesk_owner_firm()`).
- Second fictional firm: Harbourline Tax Partners (Lena Ortiz, partner; Sam Okafor, assistant) with its own
  "Acme Ltd", a filed invoice and an inbox invoice billed to "Acme Ltd".
- Tests: RLS alone (raw SQL, cross-firm insert/update/delete, insert outside a firm), the domain layer alone, the
  schema's foreign keys on the owner connection, MCP tools by name and forged id, search, matching, inbox, filing,
  signed links with a valid signature, dashboard routes, job retry, a second firm's batch job and its usage rows,
  per-firm dedupe; and an upgrade test from a v1 database with data.

## Accuracy, before and after

| Metric                  | Groq run (published, 2026-11-09, before v2) | Offline before v2 | Offline after v2 | Target |
| ----------------------- | ------------------------------------------- | ----------------- | ---------------- | ------ |
| Field accuracy          | 98.1%                                       | 84.0%             | 84.0%            | ≥ 95%  |
| Wrong-client filings    | 0                                           | 0                 | 0                | 0      |
| Review-queue rate       | 10.0%                                       | 25.0%             | 25.0%            | ≤ 10%  |
| Search hit rate (top 5) | 100%                                        | 100%              | 100%             | ≥ 90%  |
| Citation accuracy ¹     | 93.3% (miss)                                | 96.7%             | **100%**         | ≥ 95%  |
| Wider check, citation ¹ | not measured                                | 91.7%             | **95.8%**        | none   |

¹ Original questions, re-measured on 2026-11-24 with the v1 and v2 code: 29 of 30, then 30 of 30. The offline run already
met the target; v2 fixed one question. On the reworded questions v1 scores 93.3% / 93.1% (the rewording made q_21 harder
for it) and v2 100% / 98.6%, which is what `eval/baseline.md` now shows. Ablation, reworded questions (30 / 72): context
lines alone 93.3% / 91.7%; page choice + coverage on the old context 96.7% / 97.2%; context + page choice 100% / 97.2%;
all three 100% / 98.6%. No asked question got worse; one wider question did (eng_03 paraphrased, a near-tie: 0.0487 vs
0.0484). Extraction is unchanged in v2, so field accuracy and review rate only move with a model run. The Groq column
needs a rerun to show v2's search changes.

Tests: 104 before v2; now 225 vitest tests and 15 Playwright tests.

## Decisions made on your behalf

All 21 are in `docs/PLAN.md` ("Decisions made on the owner's behalf") with their reasons. The ones most worth a
second look:

1. Every check, eval and local server ran with offline settings forced in the environment (`.env` may hold keys).
2. The demo visitor is a read-only partner-level staff row, not a new role; read-only is checked centrally.
3. `render.yaml` turns `DEMO_LOGIN` on (code default off), with `TRUST_PROXY=1`.
4. Demo sessions last 2 hours and stop working the moment `DEMO_LOGIN` is turned off.
5. The demo rate limit is in memory (one instance on Render free).
6. Six eval questions were reworded because two of them had two right answers, reported as a dataset fix. The first
   version of this report compared against the reworded score (93.3%) and said the gain wasn't inflated; it was. The
   like-for-like gain is 96.7% → 100%.
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
19. Every unknown id answers "not found" and is audited the same way; cross-firm attempts go to an owner-only table.
20. The second firm is seeded wherever the demo is, including production; its staff have no WorkOS logins.
21. Dev mode's user picker lists every firm's staff.

## Blocked or skipped

Nothing in the spec was skipped. Not verifiable from here:

- **Migrations 007 and 008 on Neon.** They run on PGlite and on a real Postgres 18 (2026-11-24, below), as a non-superuser owner
  that may create roles. They have not run on Neon, and whether Neon's owner role may create roles is not confirmed here. If it may
  not, 007 fails ("permission denied to create role") and changes nothing; 003 to 006 stay applied.
- **Going back.** After 007, v1's code can't write (its inserts don't name a firm), so rolling back the code means restoring
  the database too (Neon point-in-time restore). During the deploy itself, the old instance may log errors for the moment
  both run.
- **Real-model numbers** for v2's search changes (Groq, Claude, Voyage): not run, by the no-keys rule.
- **Live demo:** the README and case study describe the deployed v2 (Try the demo, Usage page). Merge and deploy
  together so the live site matches.

## Corrections (2026-11-24)

The first version of this report got these wrong:

- The search gain was overstated (see "Accuracy"): like for like it is 96.7% → 100%, one question.
- "Three ambiguous questions" were two; six were reworded. Only one of the two original misses was a faulty question.
- The 72-question check was presented as a guard against overfitting. It was looked at while tuning.
- It said each phase had a security review. Only phase 1 had one; the rest got an informal pass and phase 5 none.
- It said every job step was safe to repeat. Filing, dead-lettering, retrying and storing were not.
- The "Try the demo" button on the real sign-in page had never been clicked by a test.
- The local run command would have picked up keys and S3 settings from `.env`.

## Security review (2026-11-24)

An independent reviewer (a second agent, given the code and not the conclusions) reviewed all phases and proved most findings
by running them. Fixed; each has a test except the ones marked, the heartbeat and request timeouts:

| Finding                                                                                                        | Fix                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A demo visitor opening a document mid-batch spoiled its extraction                                             | Nobody can open, extract or match a document being processed; late results are discarded           |
| Demo visitors could cause unlimited model calls by opening a file                                              | Viewing never extracts for partners or the demo; one extraction at a time per document             |
| After a job died before reading the text, an assistant could read another team's document                      | Unread text is read before any access decision; until then only partners see it                    |
| One 100 KB line of digits froze the server for 22 s                                                            | Bounded patterns, cut lines, limits on pages and text (completed in the second review)             |
| A crash or failing embedding service left filed documents with no note, no audit row or a dead job             | Document, note, audit row and job state in one statement; passages rebuilt separately and repaired |
| Two loops of one worker could both record the same job                                                         | Locks per claim, heartbeat, request timeouts                                                       |
| Documents stuck in `processing` (storing, dead-lettering, retrying); batch limit and keys raced                | One statement each; batch places taken atomically                                                  |
| A crash while re-indexing left a document with no passages                                                     | Passages replaced in place in one statement; stale ones found on start-up                          |
| A firm's own audit log showed whether an id exists in another firm                                             | Every unknown id logged the same; owner-only `security_events`                                     |
| The demo could fill the audit log                                                                              | Rate limits on reads and writes; IPv6 counted per network                                          |
| Other firms' batch and open-item ids weren't audited                                                           | Audited as unknown ids                                                                             |
| The server crashed when Postgres dropped an idle connection                                                    | Error listeners: idle here, in use in the Postgres run below                                       |
| References to other firms' rows in a few columns; new tables open by default; shared idempotency keys          | Same-firm foreign keys, default grants removed, keys per firm (migration 008)                      |
| Typing a fragment listed other teams' clients; wildcards; a duplicate upload showed a hidden title             | Names only when typed exactly; literal matching; title withheld                                    |
| Raw provider errors shown to partners and the demo; odd numbers gave 500; 15 MB buffered before the role check | Error categories only; numbers and ids checked; role check first                                   |
| The worker polled every second, keeping Neon awake                                                             | It sleeps until something is due and is woken by uploads                                           |

Not changed: `/api/accuracy` shows the (synthetic, public) eval report to any signed-in user; injected SQL could leave the app
role (there is none: all SQL is parameterised); usage counts a model's refusal as a success; Render's proxy hop count for
`TRUST_PROXY=1` is unconfirmed.

## Second security review (2026-11-24)

Another agent, new to the code, tried to break the fixes above. On in-memory PGlite, which runs one query at a time, the job queue (103 injected faults,
no duplicate or orphan), the migration on two kinds of existing database, and the protection of hidden clients held. On a real Postgres server, see below. These did not, and are now fixed, each
with a test that failed first unless marked:

- The freeze was only half fixed: a 98 KB PDF with 40,000 lines still took 22 s, and an unclosed bracket after "tax (" 36 s.
- The first person allowed to open an unread document was refused; a failing storage or model gave a 500 with no audit row
  (now 503, audited); a model provider's 404 was shown as "not found".
- A job could wait up to 10 minutes if it arrived as the worker went to sleep, or was queued by another server.
- A slow rebuild of search passages could overwrite a newer one.
- A full batch still stored the refused file; the same upload sent twice for a batch's last place got one refusal.
- Filing through Claude could be logged as an error after it had succeeded.
- A filed document's last step failed if the uploader had lost their role.
- An extraction finishing after the document was filed to a hidden client showed its contents.
- A single upload was answered "could not read that file" when only the embedding service was down.
- Amounts after a comma were no longer recognised; an assistant's own client could be cut off by the 10-result limit.
- Start-up waited for the embedding service; retries all came at once (no test). The batch summary left out failed jobs, and a lost
  answer counted a file twice (no test).

Still open: two uploads racing for a batch's last place can leave an unused stored file (the storage key may not delete). A hung
file-storage request has no timeout of its own (the job gives up after 30 minutes). Nobody has reviewed this second round of fixes
independently. If `TRUST_PROXY=1` is the wrong number of hops on Render, all demo visitors share one rate limit: check it first.

## Run on a real Postgres (2026-11-24)

A temporary local Postgres 18, owned by a role without superuser rights, deleted afterwards. The vector column was a text stand-in
(pgvector isn't installed there), so search ranking was not part of it, and it is not Neon.

- **Migrations:** 001 to 008 on an empty database and on one made by v1's own code with its data; both start, and a second start
  changes nothing. v1's code can't write afterwards, as expected.
- **Uploads:** 25 files at once into a batch of 5 took 5; the same key four times at once on a batch's last place gave one job in
  20 of 20 rounds; the same file under ten keys at once gave one document.
- **Queue:** two worker processes with slow, failing steps, a stuck timeout shorter than a step, database connections killed
  throughout, and in the second run one worker killed outright. 176 of 176 jobs finished, each with exactly one result, note and
  audit row; none filed to a client not named on it; no orphans, no stale passages, no deadlocks (143 retries and 3 dead letters in
  the harder run).
- **Firms:** 400 overlapping scoped queries, none saw another firm's rows.
- **Found and fixed:** a connection dropped in the middle of a scoped query ended the server process. The first fix covered only idle
  connections.

## Your steps

1. **Review and merge.** `git log main..v2` is the six phase commits, the docs commit and the corrections. Push the branch and open a
   PR as usual; CI now has four jobs: check, eval (offline), e2e (Playwright) and the manual Claude eval.
2. **Render settings** (Environment):
   - `DEMO_LOGIN=true` and `TRUST_PROXY=1` (both in `render.yaml`; add them by hand if the service isn't synced from
     the blueprint).
   - Nothing else is required. Optional: `WORKER_CONCURRENCY` (default 2), `JOB_MAX_ATTEMPTS` (5),
     `JOB_BACKOFF_MS` (2000), `JOB_STUCK_SECONDS` (300). `WORKER=1` is the default.
3. **What happens on deploy** (automatic, in Render's logs): migrations `003_demo_visitor` through `008_hardening` apply
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
# Every setting is spelled out so nothing is taken from .env (real keys, S3, sign-in). The database is in memory.
PORT=3320 NODE_ENV=development DATABASE_URL=pglite://memory AUTH_MODE=dev PUBLIC_URL= ALLOWED_HOSTS= \
DEMO_LOGIN=true EXTRACTOR=rules EMBEDDINGS=local STORAGE=local FILES_DIR=.data/try-files \
ANTHROPIC_API_KEY= GROQ_API_KEY= VOYAGE_API_KEY= npx tsx src/main.ts     # http://localhost:3320/dashboard/
```

- **Try the demo:** user picker (top right) → "Try the demo (read-only)"; the banner appears; try an upload or a
  review filing and find the refusal in the audit log; "Exit demo" returns.
- **Search:** `npm run eval -- --extractor=rules` → `eval/baseline.md` (citation 100%, wider check). Accuracy
  page → "Offline baseline (CI)".
- **Batch intake:** as Maya → Inbox → "Choose files for a batch" → pick several PDFs or .txt files; watch each step;
  the failed-jobs card appears if any job dead-letters. `npm run worker` runs the worker on its own (`WORKER=0`).
- **Usage:** after a batch, the Usage page (partners only) shows calls per day, per model and per source.
- **Multiple firms:** user picker → "Lena Ortiz · Partner · Harbourline Tax Partners": the header, inbox, audit log and
  usage all switch to Harbourline; Northbridge's documents are invisible, even by id.
- **Tests:** `npm run check` (225 tests), `npx playwright test` (15 tests, about a minute).

## Resume bullets (v2, real numbers)

Accurate for the branch as built; claim "live" for the v2 features only once it is deployed, and the CI runs only once
the branch is pushed.

- Re-architected a live Claude/MCP document-intake app (TypeScript, Postgres) for multi-tenancy: `firm_id`
  isolation enforced twice, in the domain layer and with Postgres row-level security plus same-firm foreign keys,
  proven by 21 cross-firm tests with forged ids, with a tested upgrade path for existing data.
- Built batch document intake on a Postgres job queue (`FOR UPDATE SKIP LOCKED`) with retries, exponential backoff,
  dead-lettering, idempotency keys and stuck-job recovery, plus per-model LLM cost tracking (tokens, cost, latency,
  escalations) behind a usage dashboard.
- Hardened it through an independent security review: closed a public-visitor path that could disturb background jobs and
  trigger paid model calls, made job state transitions atomic, and removed a denial-of-service in text processing; grew
  the suite from 104 to 225 tests plus 15 Playwright end-to-end tests.
- Improved RAG citation ranking (offline eval: 29 → 30 of 30 questions cited to the right page) and published the method,
  the misses and an ablation of each change.

## What to re-record in the demo video

The current video (1:56) still holds for Claude. Add, or replace the dashboard part with:

1. A private window on the live dashboard → **Try the demo** → the banner; try an upload → refused → the Denied row
   in the audit log (about 15 s).
2. Maya → Inbox → **Batch intake** with 5–10 demo files: the per-document progress, mostly "Filed to …", one look-alike
   "Sent to review" (about 20 s).
3. **Usage** page right after the batch: calls, tokens, cost per filed document (about 10 s).
4. Accuracy page: citation 100% offline and the wider check (about 10 s), once the Groq rerun is published.
5. Optional, recorded locally in dev mode: switch to Lena (Harbourline): same "Acme Ltd" name, different firm, none of
   Northbridge's documents (about 10 s).
