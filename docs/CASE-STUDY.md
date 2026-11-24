# Case study: a Claude connector an accounting firm can trust with client files

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

Version 2 turned the proof of concept into something that runs like a product: a recruiter or client can try it
without an account, partners can drop a batch of files and watch a background job queue process them, every model
call is costed, several firms can share one deployment without seeing each other's data, and the main journeys are
tested in a real browser on every push.

## How it earns trust

**Access control in code, not prompts.** Every tool checks the signed-in staff member's assignments before reading
client data. Search filters by access inside the SQL query, document links are signed for one person and re-checked
when opened, and refusals never reveal another client's details, not even a candidate's name.

**Cited answers.** Hybrid search (pgvector embeddings, Postgres full-text and exact identifiers, merged with
reciprocal-rank fusion) returns passages with document title, client, page and a link. Claude is instructed to
cite every fact. The demo's embeddings are `local-hash-v1`, a free keyword-style embedder; Voyage is the drop-in for
real semantic search.

**Safe automation.** Extraction returns a confidence for every field. What was measured, and what the live demo
runs, is Groq's open models: `gpt-oss-20b` first, escalating to `gpt-oss-120b` when the document type or any required
field is below 0.8 confidence, with a strict JSON schema. The extractor is swappable: Claude (Haiku 5.5, then Opus 5.5, which can also
read image-only scans) is built in and one setting away, but not measured yet. Client matching scores every client with human-readable reasons. A document is filed only when the best
match clears 85% and beats the runner-up by 15 points, and look-alike clients need a second identifier such as a
tax id. The server re-checks this itself when Claude asks to file, so a confused or manipulated model can't force
a wrong filing. Everything else goes to the review queue with a reason.

**Every call audited.** Tool calls, downloads and dashboard actions each write one row: who, what, inputs with
sensitive fields masked, outcome and duration.

**Firms isolated twice.** Every firm-owned table carries a `firm_id`. Every domain query filters on the caller's
firm, and Postgres row-level security enforces the same rule again: each query runs as a role without bypass rights,
with the firm set for that transaction only. Same-firm foreign keys make a cross-firm reference impossible even for a
bug that slips past both. A second fictional firm with its own "Acme Ltd" proves it: 21 tests try cross-firm reads,
writes, searches, filings, links and job retries with forged ids. An id from another firm is answered and logged exactly like one that doesn't exist, so ids can't be probed; only the owner of the deployment sees the attempt.

**Background work that fails safely.** Batch intake runs on a job queue inside Postgres (`FOR UPDATE SKIP LOCKED`, no
Redis): each document goes through stored → text → indexed → fields → matched → filed or review, each step audited.
Filing, its note, its audit row and the job's state are written in one statement, so a crash can't leave them disagreeing. Failures retry with exponential backoff, then land in a dead-letter state and the document goes
back to people; a stuck worker's job is reclaimed. Filing follows exactly the same rules as filing through Claude.

**Costs you can see.** Every model call (extraction and embeddings) is recorded with tokens, estimated cost from one
price table, latency, escalations and errors, and never document text. The Usage page shows cost per day, per model
and per filed document.

**Try it safely.** "Try the demo" opens a read-only, partner-level session. Read-only is enforced on the server in
two central places (the API router and the tool runner), so every write is refused with a 403 and logged, and new
routes inherit the rule.

## Measured, not claimed

60 labelled synthetic documents (15 per type) with hard cases: prose layouts, simulated scans, look-alike clients,
missing fields, prior-year and multi-page documents, a non-client. Plus 30 questions with a known source page.

| Metric                  | Offline baseline (regex, v2) | Groq (gpt-oss, before v2 search) | Target |
| ----------------------- | ---------------------------- | -------------------------------- | ------ |
| Field accuracy          | 84.0%                        | **98.1%**                        | ≥ 95%  |
| Wrong-client filings    | 0                            | **0**                            | 0      |
| Review-queue rate       | 25.0%                        | **10.0%**                        | ≤ 10%  |
| Search hit rate (top 5) | 100%                         | **100%**                         | ≥ 90%  |
| Citation accuracy       | **100%**                     | 93.3% (missed)                   | ≥ 95%  |

The Groq run missed citation accuracy: 2 of 30 questions cited the wrong page or a similar form first. v2 changed the
ranking and measured it offline: 29 of 30 correct (96.7%) before, 30 of 30 after, on the same questions. The Groq column
predates v2 and needs a rerun.
Search uses `local-hash-v1` embeddings in both columns: a keyword-style
embedder chosen to keep the demo free to run. Voyage embeddings (the production option) and the Claude extractor are
supported but not measured yet.

What changed along the way (from the report):

- v2: of the two citation misses, one was a question with two right answers (one bank sent the same person two forms
  that year). Six questions of that kind were reworded, and the effect is reported separately: the rewording lowers v1's
  score from 96.7% to 93.3%. The other miss was a closing balance on page 2 ranked below page 1, because the words that
  pick the document (client, bank, account) are on page 1. Passages now repeat their document's identifiers and name
  the fields they hold ("balance at the end of the period"), the page within a document is chosen by the words its
  pages don't share, and query-term coverage is a fourth ranked list. A wider 72-question check went from 91.7% to
  95.8% (original wording), with one question worse; its misses were looked at while tuning, so it is not an
  independent test.
- A first run showed citation accuracy at 56.7%. Adding a context line to every passage, descriptive titles for
  filed documents and an exact-identifier signal, together with fixing two labelling mistakes in the question set,
  brought it to 96.7%. The report says plainly which part came from which.
- The first Groq run scored 92.9% field accuracy with a 13.3% review rate. Four of the six needless reviews weren't
  misreads at all: the model wrote a year as a number where the schema said text, and the API rejected the whole
  answer. Accepting numbers, retrying a failed answer on the larger model and one prompt rule ("an absent field is
  null, never 'Not signed'") took it to 98.1% and 10.0%.
- What's left is the safe kind of error: OCR misreads ("Acmc Labs") and two prose letters where the model took the
  signer for the client. Every one went to review; none was filed to the wrong client.

## Stack

TypeScript, MCP SDK (Streamable HTTP + stdio), Postgres + pgvector with row-level security and a `SKIP LOCKED` job
queue (Neon; PGlite locally and in tests), Claude API
(supported) and Groq gpt-oss (measured) with structured outputs, pdf.js, WorkOS AuthKit (OAuth with dynamic client registration),
Amazon S3, React + Vite + Tailwind + shadcn/ui, Recharts, Vitest, Playwright, Render. Built with Claude Code, using project skills for adding
tools and migrations, a security-review checklist, and an independent review by a second agent that found (before release)
a way for a public visitor to disturb batch intake and a 100 KB file that froze the server; both fixed and tested.

## Numbers that matter to a client

- 202 automated tests and 14 Playwright end-to-end tests, including a denied-path test with an audit check for every
  tool and 21 cross-firm isolation tests.
- Citation accuracy offline: 29 of 30 before v2's ranking changes, 30 of 30 after, on the same questions.
- 0 wrong-client filings on the labelled set; 98.1% field accuracy; 10% sent to review.
- Video: https://youtu.be/hFSXsezX2ac · Repo: https://github.com/chiragpatel273/clientdesk-mcp · Live dashboard:
  https://clientdesk-mcp.onrender.com/dashboard ("Try the demo", no account needed)
