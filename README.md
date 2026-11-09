# ClientDesk MCP

**A Claude connector for professional-services firms.** Staff ask Claude about clients and documents in plain
English. ClientDesk answers through MCP tools with cited sources, files incoming documents only when it is sure,
enforces who may see which client, and logs every call. A dashboard shows the audit log, the review queue and a
measured accuracy report.

All data is fictional: the demo firm is _Northbridge Advisory_ with 3 staff, 12 clients and 13 documents.

## What it proves

| Concern                 | How ClientDesk handles it                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Claude integration | A remote MCP server (Streamable HTTP + stdio) that Claude web, Desktop and Code connect to, with OAuth sign-in (dynamic client registration).                                                                           |
| Access control          | Partners see every client; assistants only assigned ones. Enforced in code before any query, in search filters, on document links and on the dashboard, never in a prompt.                                              |
| Cited answers           | Hybrid search (pgvector + Postgres full-text + exact identifiers) returns passages with document, client, page and a signed, expiring link.                                                                             |
| Safe automation         | Extraction gives a confidence per field; matching scores every client with reasons. A document is filed only above 85% and 15 points clear of the runner-up; look-alike clients need a second identifier. Else: review. |
| Measured accuracy       | 60 labelled documents and 30 questions; `npm run eval` publishes field accuracy, wrong-client filings, review rate, search hit rate and citation accuracy, even when they miss.                                         |
| Auditability            | Every tool call, download and dashboard action writes an audit row: who, what, inputs (sensitive fields masked), outcome, duration.                                                                                     |
| AI-first development    | Built with Claude Code: `CLAUDE.md`, skills (`add-mcp-tool`, `add-migration`, `security-review`) and hooks that block a turn while typecheck or lint fails.                                                             |

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

The latest report is in [`eval/report.md`](eval/report.md) and on the dashboard's Accuracy page. The committed
report uses the **offline rules baseline** (free, deterministic, run in CI on every push):

| Metric                  | Rules baseline | Target |
| ----------------------- | -------------- | ------ |
| Field accuracy          | 84.0%          | ≥ 95%  |
| Wrong-client filings    | 0              | 0      |
| Review-queue rate       | 25.0%          | ≤ 10%  |
| Search hit rate (top 5) | 100%           | ≥ 90%  |
| Citation accuracy       | 96.7%          | ≥ 95%  |

The baseline can't read prose layouts or noisy scans, so those go to review: that is the safe failure, not a wrong
filing. The Claude extractor (Haiku 5.5, escalating to Opus 5.5 when unsure) is measured with
`npm run eval:claude` (about $0.10–0.30 a run). The report lists every case, every miss and what was changed.

## Run it locally

Requires Node 22+. No database or keys needed: local development uses [PGlite](https://pglite.dev) (Postgres in
WASM, with pgvector), the offline extractor and local embeddings.

```bash
npm install && npm run dashboard:install
cp .env.example .env
npm run dashboard:build
npm run dev          # MCP at http://localhost:3000/mcp, dashboard at http://localhost:3000/dashboard/
npm run check        # typecheck + lint + tests
npm run eval         # accuracy report → eval/report.md, eval/report.json
```

Add `ANTHROPIC_API_KEY` (extraction with Claude) and `VOYAGE_API_KEY` (embeddings) to `.env` to use the real
models; everything else stays the same. `npm run seed -- --reset` reloads the demo firm.

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

`render.yaml` (Render blueprint) + `Dockerfile` build the server and dashboard into one image. Production uses
Neon (Postgres + pgvector) via `DATABASE_URL` and Cloudflare R2 for files (`STORAGE=r2`). Production refuses to
start without OAuth, an https `PUBLIC_URL`, `SESSION_SECRET` and `LINK_SECRET`.

## Architecture

```
Claude (web / Desktop / Code)                 Dashboard (React + Vite, /dashboard)
        │  MCP: Streamable HTTP or stdio              │  JSON API (/api), session cookie or dev header
        ▼                                             ▼
src/http.ts ── OAuth bearer check → resolveActor()   src/web/ ── session, sign-in, API routes
        ▼                                             │
src/mcp/server.ts ── one McpServer per request        │
        ▼                                             │
src/mcp/tools/* ── runTool() → audit row              │
        ▼                                             ▼
src/domain/* ── access, clients, documents, intake, matching, search, audit (plain functions over Db)
        ▼                       ▼                         ▼
src/db/ (PGlite / Neon)   src/ai/ (Claude, Voyage,   src/storage/ (local / R2)
                          offline fallbacks)
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
- [`eval/report.md`](eval/report.md): the latest accuracy report

## License

MIT
