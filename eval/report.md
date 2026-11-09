# ClientDesk accuracy report

Generated 2026-11-09T12:48:24.718Z · extractor **rules-v1 (offline baseline)** · embeddings **local-hash-v1** · filing threshold 0.85, margin 0.15

60 labelled documents (15 per type) and 30 questions with known source pages. All data is synthetic. Regenerate with `npm run eval`.

| Metric | Result | Target | |
| --- | --- | --- | --- |
| Field accuracy | 84.0% | ≥ 95.0% | **miss** |
| Wrong-client filings | 0 | ≤ 0 | pass |
| Review-queue rate | 25.0% | ≤ 10.0% | **miss** |
| Search hit rate (top 5) | 100.0% | ≥ 90.0% | pass |
| Citation accuracy | 96.7% | ≥ 95.0% | pass |

Decisions: 45 filed correctly, 0 filed to the wrong client, 2 sent to review as policy requires, 13 sent to review that a person would have filed.

## By document type

| Type | Documents | Field accuracy | Review rate |
| --- | --- | --- | --- |
| invoice | 15 | 86.7% | 33.3% |
| bank_statement | 15 | 88.3% | 26.7% |
| engagement_letter | 15 | 77.8% | 20.0% |
| tax_form | 15 | 81.1% | 20.0% |

## Cases with errors

| Case | Hard case | Expected | Outcome | Field errors |
| --- | --- | --- | --- | --- |
| inv_08 | prose layout | file to cl_harbor_pine | sent to review | invoice_number: expected AT-40776, got ∅; invoice_date: expected 2026-06-18, got ∅; due_date: expected 2026-07-21, got ∅; billed_to: expected Harbor & Pine Partners, got ∅; total_amount: expected 589.33, got ∅; tax_amount: expected 43.65, got ∅ |
| inv_09 | prose layout | file to cl_acme | sent to review | invoice_number: expected NO-79593, got ∅; invoice_date: expected 2026-05-18, got ∅; due_date: expected 2026-06-16, got ∅; billed_to: expected Acme Ltd, got ∅; total_amount: expected 2084.53, got ∅; tax_amount: expected 154.41, got ∅ |
| inv_10 | scan (OCR noise) | file to cl_acme_labs | sent to review | billed_to: expected Acme Labs Ltd, got Acmc Labs Ltd |
| inv_11 | scan (OCR noise) | file to cl_brightline | sent to review | due_date: expected 2026-05-20, got ∅; billed_to: expected Brightline Logistics Inc, got Brlghtline Logistics Inc; total_amount: expected 631.89, got ∅ |
| stm_08 | prose layout | file to cl_acme_labs | sent to review | account_holder: expected Acme Labs Ltd, got ∅; account_last4: expected 8953, got ∅; period_start: expected 2026-05-01, got ∅; period_end: expected 2026-05-31, got ∅; opening_balance: expected 69948.96, got ∅; closing_balance: expected 68860.53, got ∅ |
| stm_09 | prose layout | file to cl_brooks | sent to review | account_holder: expected Samuel Brooks, got ∅; account_last4: expected 6836, got ∅; period_start: expected 2026-08-01, got ∅; period_end: expected 2026-08-31, got ∅; opening_balance: expected 24262.96, got ∅; closing_balance: expected 28937.80, got ∅ |
| stm_10 | scan (OCR noise) | file to cl_acme | filed to cl_acme | closing_balance: expected 46437.99, got ∅ |
| stm_11 | scan (OCR noise) | file to cl_marlow | sent to review | account_holder: expected Marlow Studio LLC, got ∅ |
| eng_08 | prose layout | file to cl_greenfield | sent to review | client_name: expected Greenfield Bakery LLC, got ∅; tax_year: expected 2026, got ∅; services: expected Annual accounts and corporate tax return, got ∅; annual_fee: expected 12441.00, got ∅; signed_date: expected 2026-02-20, got ∅; signed_by: expected Owen Hart, got ∅ |
| eng_09 | prose layout | file to cl_acme | sent to review | client_name: expected Acme Ltd, got ∅; tax_year: expected 2026, got ∅; services: expected Annual accounts and corporate tax return, got ∅; annual_fee: expected 7222.00, got ∅; signed_date: expected 2026-02-06, got ∅; signed_by: expected Owen Hart, got ∅ |
| eng_10 | scan (OCR noise) | file to cl_lakeside | filed to cl_lakeside | tax_year: expected 2026, got ∅; annual_fee: expected 5323.00, got ∅; signed_by: expected Grace Harbor, got ∅ |
| eng_11 | scan (OCR noise) | file to cl_lakeside | sent to review | client_name: expected Lakeside Dental Group, got ∅; services: expected Bookkeeping review, payroll filings and year-end accounts, got 8ookkecping review, payroll filings and year-end accounts; annual_fee: expected 6263.00, got ∅; signed_date: expected 2026-01-23, got ∅; signed_by: expected Mia Torres, got Mia Torrcs |
| tax_08 | prose layout | file to cl_kim | sent to review | tax_year: expected 2025, got ∅; recipient_name: expected Hana Kim, got ∅; recipient_tin_last4: expected 1132, got ∅; payer_name: expected Summit Savings Bank, got ∅; amount: expected 10981.06, got ∅ |
| tax_09 | prose layout | file to cl_okoro_trust | sent to review | tax_year: expected 2025, got ∅; recipient_name: expected Okoro Family Trust, got ∅; recipient_tin_last4: expected 6684, got ∅; payer_name: expected Riverton Credit Union, got ∅; amount: expected 6157.54, got ∅ |
| tax_10 | scan (OCR noise) | file to cl_okoro_trust | sent to review | recipient_name: expected Okoro Family Trust, got Okoro Famlly Trust; recipient_tin_last4: expected 6684, got ∅; payer_name: expected Keystone Home Lending, got ∅; amount: expected 4044.92, got ∅ |
| tax_11 | scan (OCR noise) | file to cl_brooks | filed to cl_brooks | tax_year: expected 2025, got ∅; recipient_name: expected Samuel Brooks, got Samucl Brooks; payer_name: expected Coastal Health Partners, got Coastal Hcalth Partners |

## Search misses

- q_18 (paraphrased): "What did Lakeside Dental Group have left in the Meridian Trust Bank account ending 9950 at the end of the period?" expected stm_15 p.2, found at rank 1; top result stm_15 p.1

## What was changed to improve these numbers

- First run (rules baseline, 2026-11-09): field accuracy 82.1%, wrong-client filings 0, review rate 25.0%, search hit rate 100%, citation accuracy 56.7%.
- Dataset fixes, not system improvements: a printed $0.00 tax was labelled as missing; several questions had two right answers (two engagement letters for the same client and year), so clients are now dealt without repeats and a question is only asked when exactly one document matches it; hard cases (multi-page, prior year, look-alike, missing fields) are asked about first so they can't drop out of the 30 questions.
- Rules extractor: reads the vendor after a 'Tax Invoice - ' heading and drops a bank's division suffix ('- Business Banking'). With the label fix above, field accuracy went from 82.1% to 84.0%.
- Search: every passage now starts with a context line (document title, client, page), filed documents get a descriptive title from their extraction instead of the file name, and exact identifiers in a question (invoice and account numbers) are a third ranked list in the fusion. Together with the question-set fixes, citation accuracy went from 56.7% to 96.7%; the split between the two was not measured.
- Matching (before the first run): a leading 'The' is ignored, so 'The Okoro Family Trust' matches 'Okoro Family Trust'.
- Still missing targets with the rules baseline: field accuracy and review rate fail on prose layouts and simulated scans, which the regex extractor cannot read. That is the Claude extractor's job: run `npm run eval -- --extractor=claude` (about $0.10–0.30 per run) for the numbers that matter.

## Method and limits

- Field accuracy: every field defined for the document type, compared after normalisation (dates, amounts, names case- and punctuation-insensitive). A wrong document type counts all its fields as wrong.
- Wrong-client filings: documents the system would file automatically to a client other than the true one (or at all, for the non-client document).
- Review-queue rate: share of all documents sent to human review, including those policy requires.
- Search hit rate: the source document appears in the top 5 passages. Citation accuracy: the top passage is from the source document and on the page holding the answer.
- Scans are simulated with OCR-style character noise in the text layer; real image-only scans go to Claude as PDF (vision) and are not covered by this set yet.
- The rules extractor is a regex baseline written alongside these templates, so its numbers on labelled layouts are optimistic; the prose and scan cases show where it breaks.
