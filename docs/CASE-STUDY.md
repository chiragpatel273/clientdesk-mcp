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

## Measured, not claimed

60 labelled synthetic documents (15 per type) with hard cases: prose layouts, simulated scans, look-alike clients,
missing fields, prior-year and multi-page documents, a non-client. Plus 30 questions with a known source page.

| Metric                  | Offline baseline (regex) | Groq (gpt-oss) | Target |
| ----------------------- | ------------------------ | -------------- | ------ |
| Field accuracy          | 84.0%                    | **98.1%**      | ≥ 95%  |
| Wrong-client filings    | 0                        | **0**          | 0      |
| Review-queue rate       | 25.0%                    | **10.0%**      | ≤ 10%  |
| Search hit rate (top 5) | 100%                     | **100%**       | ≥ 90%  |
| Citation accuracy       | 96.7%                    | 93.3% (miss)   | ≥ 95%  |

Four of five targets met, and the miss is published: 2 of 30 questions cite the right document but the wrong page
or a similar form first. Search uses `local-hash-v1` embeddings in both columns: a keyword-style embedder chosen to
keep the demo free to run. Voyage embeddings and the Claude extractor are supported but not measured yet.

What changed along the way (from the report):

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

TypeScript, MCP SDK (Streamable HTTP + stdio), Postgres + pgvector (Neon; PGlite locally and in tests), Claude API
(supported) and Groq gpt-oss (measured) with structured outputs, pdf.js, WorkOS AuthKit (OAuth with dynamic client registration),
Amazon S3, React + Vite + Tailwind + shadcn/ui, Render. Built with Claude Code, using project skills for adding
tools and migrations and a security-review skill run before each commit.

## Numbers that matter to a client

- 104 automated tests, including a denied-path test with an audit check for every tool.
- 0 wrong-client filings on the labelled set; 98.1% field accuracy; 10% sent to review.
- Video: https://youtu.be/hFSXsezX2ac · Repo: https://github.com/chiragpatel273/clientdesk-mcp · Live dashboard:
  https://clientdesk-mcp.onrender.com/dashboard (sign-in required)
