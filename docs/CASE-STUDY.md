# Case study: a Claude connector an accounting firm can trust with client files

> Fill the `[[…]]` slots after running `npm run eval:claude` and deploying. Every other number here comes from the
> committed report (`eval/report.md`) and the test suite.

## The problem

Small accounting and advisory firms live in documents: invoices, bank statements, engagement letters, tax forms.
Partners want to ask Claude "what's still missing for this client?" and have assistants file incoming paperwork
faster. They hold back for three reasons:

1. **Made-up answers.** A wrong figure in a tax return costs real money.
2. **Wrong-client filings.** Two clients with similar names, one blurry scan, and a document ends up in the wrong
   file: a confidentiality breach.
3. **Over-sharing.** An assistant shouldn't see clients they don't work on, however the question is phrased.

## What I built

ClientDesk is a remote MCP server: a custom connector that Claude (web, Desktop or Code) signs in to with the
firm's identity provider. Nine tools let Claude look up clients, search documents with citations, read the intake
inbox, extract fields, match documents to clients, file them, add CRM notes and send unclear cases to a human.
A small React dashboard shows the audit log, the review queue and the accuracy report.

## How it earns trust

**Access control in code, not prompts.** Every tool checks the signed-in staff member's assignments before reading
client data. Search filters by access inside the SQL query, document links are signed for one person and re-checked
when opened, and refusals never reveal another client's details, not even a candidate's name.

**Cited answers.** Hybrid search (pgvector embeddings, Postgres full-text and exact identifiers, merged with
reciprocal-rank fusion) returns passages with document title, client, page and a link. Claude is instructed to
cite every fact.

**Safe automation.** Extraction returns a confidence for every field (Claude Haiku 5.5 first, Opus 5.5 when it's
unsure). Client matching scores every client with human-readable reasons. A document is filed only when the best
match clears 85% and beats the runner-up by 15 points, and look-alike clients need a second identifier such as a
tax id. The server re-checks this itself when Claude asks to file, so a confused or manipulated model can't force
a wrong filing. Everything else goes to the review queue with a reason.

**Every call audited.** Tool calls, downloads and dashboard actions each write one row: who, what, inputs with
sensitive fields masked, outcome and duration.

## Measured, not claimed

60 labelled synthetic documents (15 per type) with hard cases: prose layouts, simulated scans, look-alike clients,
missing fields, prior-year and multi-page documents, a non-client. Plus 30 questions with a known source page.

| Metric                  | Offline baseline | Claude          | Target |
| ----------------------- | ---------------- | --------------- | ------ |
| Field accuracy          | 84.0%            | [[claude]]      | ≥ 95%  |
| Wrong-client filings    | 0                | [[claude]]      | 0      |
| Review-queue rate       | 25.0%            | [[claude]]      | ≤ 10%  |
| Search hit rate (top 5) | 100%             | [[with Voyage]] | ≥ 90%  |
| Citation accuracy       | 96.7%            | [[with Voyage]] | ≥ 95%  |

What changed along the way (from the report): a first run showed citation accuracy at 56.7%. Adding a context line
to every passage, descriptive titles for filed documents and an exact-identifier signal, together with fixing two
labelling mistakes in the question set, brought it to 96.7%. The report says plainly which part came from which.

## Stack

TypeScript, MCP SDK (Streamable HTTP + stdio), Postgres + pgvector (Neon; PGlite locally and in tests), Claude API
with structured outputs, Voyage embeddings, pdf.js, WorkOS AuthKit (OAuth with dynamic client registration),
Cloudflare R2, React + Vite + Tailwind + shadcn/ui, Render. Built with Claude Code, using project skills for adding
tools and migrations and a security-review skill run before each commit.

## Numbers that matter to a client

- [[N]] automated tests, including a denied-path test with an audit check for every tool.
- 0 wrong-client filings on the labelled set.
- Demo: [[video URL]] · Repo: [[GitHub URL]] · Live: [[deploy URL]]
