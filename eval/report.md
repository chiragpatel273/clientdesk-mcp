# ClientDesk accuracy report

Generated 2026-11-09T17:06:33.067Z · extractor **groq (openai/gpt-oss-20b, escalating to openai/gpt-oss-120b)** · embeddings **local-hash-v1** · filing threshold 0.85, margin 0.15

60 labelled documents (15 per type) and 30 questions with known source pages. All data is synthetic. Regenerate with `npm run eval`.

| Metric | Result | Target | |
| --- | --- | --- | --- |
| Field accuracy | 98.1% | ≥ 95.0% | pass |
| Wrong-client filings | 0 | ≤ 0 | pass |
| Review-queue rate | 10.0% | ≤ 10.0% | pass |
| Search hit rate (top 5) | 100.0% | ≥ 90.0% | pass |
| Citation accuracy | 93.3% | ≥ 95.0% | **miss** |

Decisions: 54 filed correctly, 0 filed to the wrong client, 2 sent to review as policy requires, 4 sent to review that a person would have filed.

## By document type

| Type | Documents | Field accuracy | Review rate |
| --- | --- | --- | --- |
| invoice | 15 | 97.5% | 13.3% |
| bank_statement | 15 | 99.2% | 13.3% |
| engagement_letter | 15 | 97.8% | 13.3% |
| tax_form | 15 | 97.8% | 0.0% |

## Cases with errors

| Case | Hard case | Expected | Outcome | Field errors |
| --- | --- | --- | --- | --- |
| inv_08 | prose layout | file to cl_harbor_pine | filed to cl_harbor_pine | currency: expected USD, got ∅ |
| inv_10 | scan (OCR noise) | file to cl_acme_labs | sent to review | billed_to: expected Acme Labs Ltd, got Acmc Labs Ltd |
| inv_11 | scan (OCR noise) | file to cl_brightline | filed to cl_brightline | currency: expected USD, got ∅ |
| stm_11 | scan (OCR noise) | file to cl_marlow | sent to review | account_holder: expected Marlow Studio LLC, got Morlow Studio LLC |
| eng_08 | prose layout | file to cl_greenfield | sent to review | client_name: expected Greenfield Bakery LLC, got Owen Hart |
| eng_09 | prose layout | file to cl_acme | sent to review | client_name: expected Acme Ltd, got Owen Hart |
| tax_11 | scan (OCR noise) | file to cl_brooks | filed to cl_brooks | recipient_name: expected Samuel Brooks, got Samucl Brooks; payer_name: expected Coastal Health Partners, got Coastal Hcalth Partners |

## Search misses

- q_18 (paraphrased): "What did Lakeside Dental Group have left in the Meridian Trust Bank account ending 9950 at the end of the period?" expected stm_15 p.2, found at rank 1; top result stm_15 p.1
- q_27 (paraphrased): "What did Summit Savings Bank report for Hana Kim for 2025?" expected tax_03 p.1, found at rank 2; top result tax_08 p.1

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

## Method and limits

- Field accuracy: every field defined for the document type, compared after normalisation (dates, amounts, names case- and punctuation-insensitive). A wrong document type counts all its fields as wrong.
- Wrong-client filings: documents the system would file automatically to a client other than the true one (or at all, for the non-client document).
- Review-queue rate: share of all documents sent to human review, including those policy requires.
- Search hit rate: the source document appears in the top 5 passages. Citation accuracy: the top passage is from the source document and on the page holding the answer.
- Scans are simulated with OCR-style character noise in the text layer; real image-only scans go to Claude as PDF (vision) and are not covered by this set yet.
- The rules extractor is a regex baseline written alongside these templates, so its numbers on labelled layouts are optimistic; the prose and scan cases show where it breaks.
