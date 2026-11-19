# Demo video: 3 minutes, five moments

Record against the live server (https://clientdesk-mcp.onrender.com) with two browser windows:

- **Normal window: Claude (web) as Tom Lindqvist (assistant).** The connector's sign-in belongs to the claude.ai
  account, so Claude stays Tom for the whole video. Only the **ClientDesk (live)** connector switched on.
- **Incognito window: the dashboard as Maya Rao (partner).** Incognito has its own cookies, so WorkOS asks for
  Maya's password instead of reusing Tom's sign-in.

**Reset the live demo data first**, so the inbox holds the three demo documents and the audit log is empty:

1. Neon console → SQL Editor → run:

   ```sql
   truncate llm_calls, jobs, batches, audit_log, document_chunks, documents, notes, open_items, contacts,
            client_assignments, clients, staff restart identity cascade;
   ```

2. Render → `clientdesk-mcp` → Manual Deploy → Restart service. On start, the server finds the database empty and
   reloads both demo firms and their documents (logs: "Seeded the Northbridge Advisory demo firm.", "Loaded 13
   Northbridge Advisory demo documents.", and the same for Harbourline Tax Partners).

(`npm run seed -- --reset` with the Neon `DATABASE_URL` does the same from a laptop, but many networks block
Postgres's port 5432. Never paste the connection string anywhere: it contains the password.)

Then reload Maya's dashboard. Render's free plan sleeps after 15 idle minutes: open the dashboard once, a minute
before recording, so the first question doesn't wait for a cold start (or switch to the Starter plan).

## 0:00–0:15 · Hook

Voice-over: "Accounting firms want Claude on their client files, but only if it cites its sources, never files a
document to the wrong client, and respects who may see what. This is ClientDesk, a Claude connector that does all
three, with the numbers to prove it."

Show: Claude with the ClientDesk connector enabled.

## 0:15–0:50 · 1. Cited answers (as Tom, who works on Acme)

Prompt: **"What's still missing for Acme Ltd's FY2026 return, and what did we agree in the engagement letter?"**

Expect: `list_open_items` (bank statements Oct–Dec, Q4 payroll summary, fixed assets over $2,500) and
`search_documents` (engagement letter: $14,400 fee, services), each fact cited [n] with a link.
Click one link: the PDF opens. Say: "Links are signed, expire in an hour, and re-check access when opened."

## 0:50–1:35 · 2. Document intake (as Tom)

Prompt: **"File the new Northwind invoice in the inbox."** (Name it: the inbox also holds another client's invoice.)

Expect: `list_inbox` → `extract_document` (Northwind Office Supplies, INV-20931, $4,768.20, confidences shown) →
`match_client` (Acme Ltd, 99%: exact name plus the contact Priya Natarajan on the invoice) → Claude asks to
confirm. Reply **"Yes, and it covers the fixed-asset item. Add a note too."** → `file_document` (closes the open
item) → `add_crm_note`. Point out that Claude asked before writing anything, because the write tools are annotated
that way.

## 1:35–2:05 · 3. Safe failure (as Tom)

Prompt: **"And the scanned bank statement?"**

Expect: the holder's name is half-legible ("Elena Petrov?") and a look-alike client exists, so `match_client` finds
no match above 85% → `send_to_review` with the reason. Say: "It doesn't guess. Look-alike names need a second
identifier, like a tax id, before anything is filed. Notice it didn't even tell Tom the other client's name."

## 2:05–2:25 · 4. Permissions (as Tom)

Prompt: **"Show me Lakeside Dental Group."** → refused: not assigned, ask a partner.
Optional: **"What's in the DentalSoft invoice in the inbox?"** → contents withheld, offer to send it to review.

## 2:25–2:55 · 5. Proof (dashboard, as Maya)

- Overview: tool calls today, with Tom's two refusals highlighted.
- Audit log: filter "Denied", expand a row to show the logged input.
- Review queue: the blurry statement with extracted fields, confidences and both candidates; file it to Elena
  Petrova as a partner.
- Accuracy: the five metrics against their targets, the per-type chart and the "what we changed" list.

## 2:55–3:00 · Close

"Real MCP integration, measured accuracy, access control in code. The repo, tests and accuracy report are public."
Show the GitHub URL.

## Checklist before recording

- [ ] Live data reset (command above); Maya's dashboard shows Inbox 3 and an empty audit log.
- [ ] Claude (normal window): only **ClientDesk (live)** on, signed in as Tom. Dashboard (incognito): Maya.
- [ ] Server awake: dashboard opened a minute before recording.
- [ ] The Accuracy page shows the Groq report (98.1% field accuracy).
- [ ] Browser zoom at 110–125% so text is readable in the video.
- [ ] Notifications off; bookmarks bar hidden.
