# ClientDesk MCP

**A Claude connector for professional-services firms.** Staff ask Claude about clients and documents in plain
English. ClientDesk answers through MCP tools with cited sources, files incoming documents only when it is sure,
enforces who may see which client, and logs every call. A dashboard shows the audit log, the review queue and a
measured accuracy report, batch intake through a background job queue, and the cost of every model call. Several
firms can share one deployment, isolated in code and by Postgres row-level security.

All data is fictional: the demo firm is _Northbridge Advisory_ with 3 staff, 12 clients and 13 documents, and a
second firm, _Harbourline Tax Partners_, exists only to prove that nothing crosses between firms.

## Demo

- **Video:** [2-minute walkthrough](https://youtu.be/hFSXsezX2ac): Claude, signed in as an assistant, answers with
  citations, files an invoice, sends a blurry scan to review and is refused a client it isn't assigned to; then the
  partner's dashboard shows the audit trail, the review queue and the accuracy report.
- **Live dashboard:** https://clientdesk-mcp.onrender.com/dashboard: press **Try the demo** for a read-only,
  partner-level look at the fictional firm, with no account needed. Every change is refused by the server and shows
  up in the audit log. The MCP endpoint is `https://clientdesk-mcp.onrender.com/mcp`. Hosted on Render's free plan,
  so the first request after a quiet spell takes about a minute to wake the server.

## What it proves

| Concern                   | How ClientDesk handles it                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Claude integration   | A remote MCP server (Streamable HTTP + stdio) that Claude web, Desktop and Code connect to, with OAuth sign-in (dynamic client registration).                                                                                                                                                                                                                                                      |
| Access control            | Partners see every client; assistants only assigned ones. Enforced in code before any query, in search filters, on document links and on the dashboard, never in a prompt.                                                                                                                                                                                                                         |
| Cited answers             | Hybrid search (pgvector + Postgres full-text + exact identifiers) returns passages with document, client, page and a signed, expiring link.                                                                                                                                                                                                                                                        |
| Safe automation           | Extraction gives a confidence per field; matching scores every client with reasons. A document is filed only above 85% and 15 points clear of the runner-up; look-alike clients need a second identifier. Else: review.                                                                                                                                                                            |
| Measured accuracy         | 60 labelled documents, 30 questions and a wider 72-question check; `npm run eval` publishes field accuracy, wrong-client filings, review rate, search hit rate and citation accuracy, even when they miss.                                                                                                                                                                                         |
| Multi-tenancy             | `firm_id` on every firm-owned table. Isolated twice: every domain query filters on the caller's firm, and Postgres row-level security (role `clientdesk_app`, per-transaction `app.firm_id`) enforces it again; same-firm foreign keys make cross-firm references impossible. An id from another firm is answered and logged exactly like one that doesn't exist; only the owner sees the attempt. |
| Background jobs           | Batch intake runs on a job queue in Postgres (`FOR UPDATE SKIP LOCKED`): retries with exponential backoff, dead-letter state, idempotency keys, stuck-job reclaim with per-claim locks. Filing, its note, its audit row and the job's state are one statement; filing keeps the same rules.                                                                                                        |
| LLM cost tracking         | Every model call (extraction, embeddings) is recorded with tokens, estimated cost, latency, escalation and errors, never document text; a Usage page shows cost per day, per model and per filed document.                                                                                                                                                                                         |
| Tested end to end         | 202 unit and integration tests (vitest, in-memory Postgres) plus 14 Playwright tests in Chromium against the real server (including real sign-in against a stand-in provider), run by CI.                                                                                                                                                                                                          |
| Try it without an account | "Try the demo": a read-only, partner-level session, enforced on the server (every write is refused with a 403 and audited) and rate-limited per IP.                                                                                                                                                                                                                                                |
| Auditability              | Every tool call, download and dashboard action writes an audit row: who, what, inputs (sensitive fields masked), outcome, duration.                                                                                                                                                                                                                                                                |
| AI-first development      | Built with Claude Code: `CLAUDE.md`, skills (`add-mcp-tool`, `add-migration`, `security-review`) and hooks that block a turn while typecheck or lint fails.                                                                                                                                                                                                                                        |

## Tools

| Tool               | What it does                                                                                             | Type  |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ----- |
| `get_client`       | Profile, team, contacts, open items, notes and recent documents for one client; ambiguous → candidates   | Read  |
| `search_documents` | Hybrid search over filed documents the user may see; passages with title, client, page and signed link   | Read  |
| `list_open_items`  | What a client still owes for a tax year; received items link to the document that closed them            | Read  |
| `list_inbox`       | Documents uploaded but not yet filed                                                                     | Read  |
| `extract_document` | Document type and fields per type, each with a confidence; withheld if it likely belongs to another team | Read  |
| `match_client`     | Candidate clients with confidence and reasons, and a recommendation: file or review                      | Read  |
| `file_document`    | Files to the confirmed client; re-checks the match itself and refuses below the threshold                | Write |
| `add_crm_note`     | Adds a signed note or an open item to a client                                                           | Write |
| `send_to_review`   | Puts a document in the human review queue with a reason                                                  | Write |

Read tools are annotated `readOnlyHint: true`; write tools `readOnlyHint: false` with `destructiveHint` set, so
Claude asks before running them.

## Accuracy

Two reports, both on the dashboard's Accuracy page: [`eval/report.md`](eval/report.md), the latest model run (extraction by
**Groq `openai/gpt-oss-20b`, escalating to `openai/gpt-oss-120b`** below 0.8 confidence), and
[`eval/baseline.md`](eval/baseline.md), the free offline run (regex extractor) that CI repeats on every push. Both use
**`local-hash-v1`** embeddings, on 60 labelled documents and 30 questions with a known source page.

| Metric                  | Groq gpt-oss (2026-11-09, before v2 search) | Offline baseline (v2) | Target |
| ----------------------- | ------------------------------------------- | --------------------- | ------ |
| Field accuracy          | **98.1%**                                   | 84.0%                 | ≥ 95%  |
| Wrong-client filings    | **0**                                       | 0                     | 0      |
| Review-queue rate       | **10.0%**                                   | 25.0%                 | ≤ 10%  |
| Search hit rate (top 5) | **100%**                                    | 100%                  | ≥ 90%  |
| Citation accuracy       | **93.3%: missed the target**                | **100%**              | ≥ 95%  |

**v2's search changes, measured offline:** on the original 30 questions v1's ranking cites 29 correctly (96.7%) and
v2's all 30 (100%): one question fixed, a closing balance on page 2 that ranked below page 1 of the same statement, and
none made worse. Three ranking changes did it: passages repeat their document's key identifiers and name the fields they
hold; within a document the page is chosen by the question words its pages don't share; and query-term coverage is a
fourth ranked list in the fusion. Two of the 30 questions turned out to have two right answers (one bank sent the same
person two forms that year), so six questions of those two kinds were reworded; on the reworded set v1's ranking scores
93.3% (the rewording made one question harder for it) and v2's 100%. A **wider check** (both phrasings for every
searchable document, 72 questions, in every report) went from 91.7% to 95.8% with the original wording and from 93.1% to
98.6% with the new one, with one question worse. It includes the 30 and its misses were looked at while tuning, so it is
not an independent test. The Groq column predates all this: rerun it to update
(`npm run eval -- --extractor=groq`, free tier). Every extraction error went to the review queue, never to the
wrong client, and CI fails the build on any wrong-client filing.

**Supported but not measured yet:** the Claude extractor (Haiku 5.5, escalating to Opus 5.5; it can also read
image-only scans) and **Voyage embeddings (`voyage-3.5`), the production option**. `local-hash-v1` is a
keyword-style embedder (hashed word and word-pair features, no model) chosen to keep the demo free to run; it can't
tell that "pay for the work" means "fee" (the wider check's one miss). Set `VOYAGE_API_KEY` and restart: start-up
rebuilds every passage with Voyage (`npm run reindex` does it by hand). Measure with `npm run eval:claude` (about
$0.10–0.30 a run) or `npm run eval` with the keys set. The report lists every case, every miss and what was changed.

## Run it locally

Requires Node 22+. No database or keys needed: local development uses [PGlite](https://pglite.dev) (Postgres in
WASM, with pgvector), the offline extractor and local embeddings.

```bash
npm install && npm run dashboard:install
cp .env.example .env
npm run dashboard:build
npm run dev          # MCP at http://localhost:3000/mcp, dashboard at http://localhost:3000/dashboard/
npm run check        # typecheck + lint + tests
npm run eval -- --extractor=rules   # offline accuracy report → eval/baseline.md (model runs → eval/report.md)
npx playwright test  # end-to-end tests in Chromium (builds the dashboard, starts its own server on :3399)
```

Locally (`AUTH_MODE=dev`) the dashboard's user picker switches between Maya (partner), Tom and Ana (assistants), the
second firm's Lena and Sam, and **Try the demo** (set `DEMO_LOGIN=true`). On the Inbox page, partners can drop several
files into **Batch intake** and watch each one being read, indexed, extracted, matched and filed (or sent to review)
by the background worker; the **Usage** page then shows the model calls it made.

Add `GROQ_API_KEY` (free tier; the extractor the live demo uses) or `ANTHROPIC_API_KEY` (Claude), and
`VOYAGE_API_KEY` (`voyage-3.5`, the production embeddings) to `.env` to use real models; everything else stays the
same, and the next start re-embeds every passage. `npm run seed -- --reset` reloads the demo firms.

For dashboard development with hot reload: `npm run dev` in one terminal, `npm run dashboard:dev` in another
(Vite on :5173, proxied to the server).

### Use it from Claude Code (stdio)

```bash
claude mcp add clientdesk --env CLIENTDESK_USER=tom@northbridge.example -- npx tsx src/stdio.ts
```

Then ask: _"What's still missing for Acme Ltd's 2026 return?"_, _"File the new invoice in the inbox"_, or
_"Show me Lakeside Dental Group"_ (Tom isn't assigned to it, so it's refused and logged).

### Use it from Claude (web or Desktop) as a custom connector

Claude connects from Anthropic's cloud, so the server needs a public HTTPS URL and real sign-in:

1. Create a WorkOS AuthKit application with dynamic client registration on, redirect URI
   `https://claude.ai/api/mcp/auth_callback`, and a JWT template that adds `email` to access tokens.
2. `ngrok http 3000`, then run with `AUTH_MODE=oauth PUBLIC_URL=https://<ngrok-host> OAUTH_ISSUER=https://<subdomain>.authkit.app`.
3. In Claude: **Customize → Connectors → Add custom connector**, URL `https://<ngrok-host>/mcp`, and sign in.

[`docs/PLAN.md`](docs/PLAN.md) has the full checklist and the gotchas.

## Deploy

`render.yaml` (Render blueprint) + `Dockerfile` build the server and dashboard into one image; the job worker runs
in the same process (`WORKER=1`), or separately with `npm run worker`. Production uses
Neon (Postgres + pgvector) via `DATABASE_URL` and Amazon S3 for files (`STORAGE=s3`, an IAM key limited to one
bucket; Cloudflare R2 and other S3-compatible services also work). Production refuses to
start without OAuth, an https `PUBLIC_URL`, `SESSION_SECRET` and `LINK_SECRET`.

## Architecture

```
Claude (web / Desktop / Code)                 Dashboard (React + Vite, /dashboard)
        │  MCP: Streamable HTTP or stdio              │  JSON API (/api): session cookie (staff or demo) or dev header
        ▼                                             ▼
src/http.ts ── OAuth bearer → resolveActor()        src/web/ ── sign-in, demo session, read-only guard, API routes
        │      (staff member + firm)                  │
        ▼                                             │                        src/jobs/ ── Postgres queue
src/mcp/server.ts ── one McpServer per request        │                          (SKIP LOCKED, retries,
        ▼                                             │                           dead-letter) → worker →
src/mcp/tools/* ── runTool() → audit row, usage scope │                           intake steps per document
        ▼                                             ▼                                    │
src/domain/* ── access, clients, documents, intake, matching, search, audit, usage ◄───────┘
        │        every query: db.forFirm(actor.firmId) + firm_id filter
        ▼                       ▼                              ▼
src/db/ (PGlite / Neon):  src/ai/ (Groq, Claude, Voyage,   src/storage/ (local / S3)
RLS per firm, role        offline fallbacks) → every call
clientdesk_app            recorded in llm_calls
```

## Built with Claude Code

- [`CLAUDE.md`](CLAUDE.md): commands, architecture and the rules that must not be broken.
- Skills in [`.claude/skills`](.claude/skills): `add-mcp-tool`, `add-migration`, `security-review`.
- Hooks in [`.claude/settings.json`](.claude/settings.json): Prettier after every edit; a turn can't finish while
  typecheck or lint fails.

## Docs

- [`docs/PLAN.md`](docs/PLAN.md): plan, decisions and status
- [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md): the 3-minute video, shot by shot
- [`docs/CASE-STUDY.md`](docs/CASE-STUDY.md): the write-up for clients
- [`docs/V2-REPORT.md`](docs/V2-REPORT.md): what v2 added, measured, and decided
- [`eval/report.md`](eval/report.md): the latest model accuracy report; [`eval/baseline.md`](eval/baseline.md): the
  offline run CI repeats on every push

## License

MIT
