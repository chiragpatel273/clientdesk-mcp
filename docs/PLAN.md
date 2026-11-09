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
- Files: Cloudflare R2. Hosting: Render or Fly.io. Dashboard: Angular 22 + `@ngnova/ui` (the owner's own library).
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
| Sign-in and audit | 3    | Sign-in works inside Claude (web) via custom connector | Next                                       |
| Documents         | 4–5  | Cited search + intake flow work end to end             |                                            |
| Accuracy          | 6    | First accuracy report published                        |                                            |
| Dashboard         | 7    | Audit log, review queue, scores visible                |                                            |
| Ship              | 8    | Public launch: deployed, video, case study             |                                            |

If a phase runs over, cut the HubSpot adapter and the demo login first, never the accuracy report.

## Status

- **Day 1 (done):** schema and migrations, PGlite/pg `Db`, demo firm, `get_client` with access check + audit, stateless
  HTTP (`AUTH_MODE=dev`) and stdio, Claude Code setup (CLAUDE.md, skills, hooks), 11 tests, CI.

## Next up: Day 3, OAuth sign-in

Goal: Claude (web) adds the connector, the user signs in, and every tool runs as that staff member. No dev header in production.

1. **Provider.** Create a free WorkOS (AuthKit) application with dynamic client registration enabled. Add Claude's
   callback `https://claude.ai/api/mcp/auth_callback`. Note the issuer and JWKS URL. If DCR doesn't work in about an hour, switch to Auth0.
2. **Config.** Add `PUBLIC_URL` (this server's https origin), `OAUTH_ISSUER`, `OAUTH_JWKS_URL` and `OAUTH_AUDIENCE`
   to `src/config.ts` and `.env.example`. With `AUTH_MODE=oauth`, all are required.
3. **Discovery.** Serve protected-resource metadata with the SDK's `mcpAuthMetadataRouter`
   (`@modelcontextprotocol/sdk/server/auth/router.js`), pointing at the provider as the authorization server.
4. **Token checks.** Protect `POST /mcp` with `requireBearerAuth`
   (`@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js`), passing `resourceMetadataUrl` from
   `getOAuthProtectedResourceMetadataUrl` so a 401 carries the `WWW-Authenticate` hint. Implement the verifier with
   `jose` (`createRemoteJWKSet` + `jwtVerify`), checking issuer, audience/resource, expiry and signature.
5. **Identity.** In `resolveActor()`, map the token's email claim to `staff.email` (case-insensitive). Unknown users get
   403 with a clear message. Keep `dev` mode for local work and tests; it is already refused in production.
6. **Origin check.** Reject requests whose `Origin` header is present and not allowed.
7. **Tests.** Generate a local key pair with `jose`, serve a fake JWKS, and test: valid token → 200 as the right
   actor; wrong audience, expired or bad signature → 401; unknown email → 403; metadata endpoint shape.
8. **Gate.** Run with ngrok, add the connector in Claude, sign in as each demo user, and check that Tom is refused
   Lakeside Dental while Maya isn't. Record which provider worked and any gotchas in this file.

Run the `security-review` skill before committing.
