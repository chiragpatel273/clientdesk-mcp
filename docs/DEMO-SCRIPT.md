# Demo video: 3 minutes, five moments

Record in Claude (web) with the ClientDesk connector added, plus the dashboard in a second tab. Reset the data first
so the inbox holds the three demo documents: `npm run seed -- --reset` (or redeploy with an empty database).
Sign-in: Maya Rao (partner) and Tom Lindqvist (assistant), created in WorkOS.

Use two browser profiles (one signed in as Maya, one as Tom) so switching users is a click, not a sign-out.

## 0:00–0:15 · Hook

Voice-over: "Accounting firms want Claude on their client files, but only if it cites its sources, never files a
document to the wrong client, and respects who may see what. This is ClientDesk, a Claude connector that does all
three, with the numbers to prove it."

Show: Claude with the ClientDesk connector enabled.

## 0:15–0:50 · 1. Cited answers (as Maya)

Prompt: **"What's still missing for Acme Ltd's FY2026 return, and what did we agree in the engagement letter?"**

Expect: `list_open_items` (bank statements Oct–Dec, Q4 payroll summary, fixed assets over $2,500) and
`search_documents` (engagement letter: $14,400 fee, services), each fact cited [n] with a link.
Click one link: the PDF opens. Say: "Links are signed, expire in an hour, and re-check access when opened."

## 0:50–1:35 · 2. Document intake (as Tom)

Prompt: **"There's a new invoice in the inbox. File it."**

Expect: `list_inbox` → `extract_document` (Northwind Office Supplies, INV-20931, $4,768.20, confidences shown) →
`match_client` (Acme Ltd, 99%: exact name plus the contact Priya Natarajan on the invoice) → Claude asks to
confirm. Reply **"Yes, and it covers the fixed-asset item. Add a note too."** → `file_document` (closes the open
item) → `add_crm_note`. Point out that Claude asked before writing anything, because the write tools are annotated
that way.

## 1:35–2:05 · 3. Safe failure (as Tom)

Prompt: **"And the scanned bank statement?"**

Expect: `match_client` says it could be Elena Petrova or another client he isn't assigned to, both below 85% →
`send_to_review` with the reason. Say: "It doesn't guess. Look-alike names need a second identifier, like a tax id,
before anything is filed. Notice it didn't even tell Tom the other client's name."

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

- [ ] `npm run eval:claude` run and committed, so the dashboard shows the Claude numbers.
- [ ] Data reset; the inbox shows 3 documents.
- [ ] Both browser profiles signed in; the connector authorised in each.
- [ ] Browser zoom at 110–125% so text is readable in the video.
- [ ] Notifications off; bookmarks bar hidden.
