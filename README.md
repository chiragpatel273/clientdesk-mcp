# ClientDesk MCP

**A Claude connector for professional-services firms.** Staff ask Claude about clients and documents in plain
English. ClientDesk answers through MCP tools, enforces who may see which client, and logs every call.

> Status: **Day 1 of 8**. `get_client` works over Streamable HTTP and stdio with role-based access and an audit log.
> Sign-in (OAuth), document search, extraction, filing and the accuracy report are next. See the roadmap below.

All data is fictional: the demo firm is _Northbridge Advisory_ with 3 staff and 12 clients.

## What it shows

| Concern             | How ClientDesk handles it                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Access control      | Partners see every client; assistants see only assigned clients. Enforced in code before any query, never in a prompt. |
| Auditability        | Every tool call writes one audit row: who, which tool, inputs (sensitive fields masked), outcome, duration.            |
| Safe answers        | Ambiguous names ("Acme", "Petrov") return candidates so Claude asks instead of guessing.                               |
| Honest tool hints   | Read tools are annotated `readOnlyHint`; write tools will be marked so Claude asks before running them.                |
| Structured output   | Every tool returns a short summary plus `structuredContent` validated against an `outputSchema`.                       |
| Built to be changed | The repo ships its own Claude Code setup: `CLAUDE.md`, skills and hooks (see below).                                   |

## Tools

| Tool         | What it does                                                                                         | Type |
| ------------ | ---------------------------------------------------------------------------------------------------- | ---- |
| `get_client` | Profile, team, contacts, open items, latest notes and recent documents for one client, by id or name | Read |

Coming next: `search_documents`, `list_open_items`, `list_inbox`, `extract_document`, `match_client`,
`file_document`, `add_crm_note`, `send_to_review`.

## Run it locally

Requires Node 22+. No database to install: local development uses [PGlite](https://pglite.dev) (Postgres in WASM, with pgvector).

```bash
npm install
cp .env.example .env
npm run dev          # http://localhost:3000/mcp, seeds the demo firm on first start
npm run check        # typecheck + lint + tests
```

### Use it from Claude Code (stdio)

```bash
claude mcp add clientdesk --env CLIENTDESK_USER=tom@northbridge.example -- npx tsx src/stdio.ts
```

Then ask: _"What's still open for Acme Ltd?"_ or _"Show me Lakeside Dental Group"_ (Tom isn't assigned to it, so it's refused and logged).

### Use it from Claude (web or Desktop) as a custom connector

Claude connects from Anthropic's cloud, so the server needs a public HTTPS URL. For a quick test:

```bash
ngrok http 3000                                                  # note the https host it prints
ALLOWED_HOSTS=localhost,127.0.0.1,<your-host>.ngrok-free.app npm run dev
```

In Claude: **Customize → Connectors → Add custom connector**, URL `https://<your-host>.ngrok-free.app/mcp`.
Until OAuth lands (Day 3) the server runs as `DEV_USER`, so use this only with the fictional demo data.

## Architecture

```
Claude (web / Desktop / Code)
        │  MCP over Streamable HTTP (stateless) or stdio
        ▼
src/http.ts ── resolveActor()          ← the only place identity is decided
        ▼
src/mcp/server.ts ── one McpServer per request, bound to the actor
        ▼
src/mcp/tools/*  ── each handler inside runTool() → audit row
        ▼
src/domain/*     ── access rules, clients, audit (plain functions over Db)
        ▼
src/db/          ── PGlite locally and in tests, Postgres (Neon) in production
```

## Built with Claude Code

This repo is set up so Claude Code works on it safely:

- [`CLAUDE.md`](CLAUDE.md) commands, architecture and the rules that must not be broken.
- Skills in [`.claude/skills`](.claude/skills): `add-mcp-tool`, `add-migration`, `security-review`.
- Hooks in [`.claude/settings.json`](.claude/settings.json): Prettier runs after every edit; Claude can't finish a
  turn while typecheck or lint fails.

## Roadmap

- [x] Day 1–2: foundation: schema, demo firm, `get_client`, HTTP and stdio transports, audit log, tests
- [ ] Day 3: OAuth sign-in with dynamic client registration; real roles from tokens
- [ ] Day 4–5: document ingestion, hybrid search with citations, extraction, client matching, filing, review queue
- [ ] Day 6: labelled test set and accuracy report in CI
- [ ] Day 7: dashboard (Angular + [@ngnova/ui](https://www.npmjs.com/package/@ngnova/ui)): audit log, review queue, scores
- [ ] Day 8: deploy, demo video, case study

## License

MIT
