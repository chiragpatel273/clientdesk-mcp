# ClientDesk accuracy report

Generated 2026-11-24T14:56:56.120Z · extractor **rules-v1 (offline baseline)** · embeddings **local-hash-v1** · filing threshold 0.85, margin 0.15

60 labelled documents (15 per type) and 30 questions with known source pages. All data is synthetic. Regenerate with `npm run eval -- --extractor=rules`.

| Metric | Result | Target | |
| --- | --- | --- | --- |
| Field accuracy | 84.0% | ≥ 95.0% | **miss** |
| Wrong-client filings | 0 | ≤ 0 | pass |
| Review-queue rate | 25.0% | ≤ 10.0% | **miss** |
| Search hit rate (top 5) | 100.0% | ≥ 90.0% | pass |
| Citation accuracy | 100.0% | ≥ 95.0% | pass |

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

None.

## Model usage

221 model calls, 15,590 input and 6,494 output tokens, estimated cost $0.0000. Offline models: token counts are estimates (characters / 4), cost 0.

## Wider check (not a target)

Both question variants for every searchable document: 72 questions, hit rate 100.0%, citation accuracy 98.6%. It includes the 30 asked questions and was looked at while tuning, so it shows breadth but is not an independent test.

- eng_03 (paraphrased): expected eng_03 p.1, top result inv_08 p.1

## What was changed to improve these numbers

- First run (rules baseline, 2026-11-09): field accuracy 82.1%, wrong-client filings 0, review rate 25.0%, search hit rate 100%, citation accuracy 56.7%.
- Dataset fixes, not system improvements: a printed $0.00 tax was labelled as missing; several questions had two right answers (two engagement letters for the same client and year), so clients are now dealt without repeats and a question is only asked when exactly one document matches it; hard cases (multi-page, prior year, look-alike, missing fields) are asked about first so they can't drop out of the 30 questions.
- Rules extractor: reads the vendor after a 'Tax Invoice - ' heading and drops a bank's division suffix ('- Business Banking'). With the label fix above, field accuracy went from 82.1% to 84.0%.
- Search: every passage now starts with a context line (document title, client, page), filed documents get a descriptive title from their extraction instead of the file name, and exact identifiers in a question (invoice and account numbers) are a third ranked list in the fusion. Together with the question-set fixes, citation accuracy went from 56.7% to 96.7%; the split between the two was not measured.
- Matching (before the first run): a leading 'The' is ignored, so 'The Okoro Family Trust' matches 'Okoro Family Trust'.
- Still missing targets with the rules baseline: field accuracy and review rate fail on prose layouts and simulated scans, which the regex extractor cannot read. A model-based extractor (Claude or Groq) is needed for those.
- Groq extractor added (2026-11-09: openai/gpt-oss-20b, escalating to openai/gpt-oss-120b when unsure; Groq's free tier). First run: field accuracy 92.9%, wrong-client filings 0, review rate 13.3%, search hit rate 100%, citation accuracy 93.3%.
- Groq fixes: 4 of the 6 needless reviews were API rejections, not misreads (the model wrote a year or amount as a number where the schema said text, and Groq refused the whole answer). Numbers are now accepted and converted to text, and a failed small-model answer is retried on the large model. The prompt (shared with Claude) now says an absent field is null, never placeholder text like 'Not signed'. Second run: field accuracy 98.1%, wrong-client filings 0, review rate 10.0%, search hit rate 100%, citation accuracy 93.3%; the small model answered all 60 documents.
- Still missing with Groq: citation accuracy (2 of 30 questions: a closing balance on page 2 ranked below page 1 of the same statement, and a paraphrased tax-form question ranked a similar form first). Remaining field errors are OCR misreads ('Acmc Labs') and two prose letters where the model took the signer for the client; all of those went to review rather than the wrong client. Scans with no text layer are not covered: Groq's structured-output models are text only, so those always go to review.
- v2 dataset fix, not a system improvement (2026-11-19): two of the 30 asked questions had two right answers (q_24 and q_27: one payer can send a person two forms in a year; 'What did Summit Savings Bank report for Hana Kim for 2025?' fits both her Form 1098 and her 1099-DIV). All six asked questions of the two affected kinds were reworded: paraphrased invoice questions now name the invoice number, and paraphrased tax questions name the kind of amount ('mortgage interest'). The rewording makes q_21 harder for v1's ranking: v1 scores 96.7% citation accuracy offline on the original questions and 93.3% on the reworded ones.
- v2 search (2026-11-19), three ranking changes, measured offline (rules extractor, local-hash-v1). On the original 30 questions: citation accuracy 96.7% to 100% (q_18 fixed, none worse), and 91.7% to 95.8% on a wider check of 72 questions (both variants for every searchable document, now in every report; it includes the 30 and its misses were looked at while tuning, so it is not an independent test). (1) Passage context: every passage repeats its document's key identifiers (account ****9950, invoice number, form, tax year), and lists the extracted fields it holds by their plain description ('balance at the end of the period'). (2) Page choice within a document: a document's passages are re-ordered by the question words that its other passages don't all share. (3) Query-term coverage as a fourth ranked list in the fusion. Ablation on the reworded questions (30 / 72): v1 93.3% / 93.1%; (1) alone 93.3% / 91.7%; (2)+(3) 96.7% / 97.2%; (1)+(2) 100% / 97.2%; all three 100% / 98.6%. Hit rate 100% throughout.
- Still open after v2 search: one wider-check question got worse (eng_03 paraphrased, 'How much will Harbor & Pine Partners pay Northbridge for the 2026 work?', an invoice now ranks a hair above the engagement letter: 0.0487 vs 0.0484). 'Pay for the work' shares few words with 'fee'; semantic embeddings (Voyage, voyage-3.5, the production option) may help but have not been measured. The Groq report (98.1% field accuracy, 93.3% citation) predates these changes and the rewording; it needs a rerun to show their effect.

## Method and limits

- Field accuracy: every field defined for the document type, compared after normalisation (dates, amounts, names case- and punctuation-insensitive). A wrong document type counts all its fields as wrong.
- Wrong-client filings: documents the system would file automatically to a client other than the true one (or at all, for the non-client document).
- Review-queue rate: share of all documents sent to human review, including those policy requires.
- Search hit rate: the source document appears in the top 5 passages. Citation accuracy: the top passage is from the source document and on the page holding the answer.
- Scans are simulated with OCR-style character noise in the text layer; real image-only scans go to Claude as PDF (vision) and are not covered by this set yet.
- The rules extractor is a regex baseline written alongside these templates, so its numbers on labelled layouts are optimistic; the prose and scan cases show where it breaks.
