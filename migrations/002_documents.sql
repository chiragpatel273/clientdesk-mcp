-- Day 4–5: document intake, extraction, matching, review queue and search.

-- Where a document came from and what was extracted from it.
alter table documents add column source_filename  text;
alter table documents add column mime_type        text;
alter table documents add column content_sha256   text;
alter table documents add column uploaded_by      text references staff (id);
alter table documents add column text_layer       boolean not null default true;  -- false: scanned, no usable text
alter table documents add column page_text        jsonb;                          -- ["page 1 text", "page 2 text", ...]
-- Latest extraction: { docType, docTypeConfidence, clientName, fields: [{ name, value, confidence }], model }
alter table documents add column extraction       jsonb;
alter table documents add column extracted_at     timestamptz;
-- Latest client match: { candidates: [{ clientId, confidence, reasons }], decision }
alter table documents add column match            jsonb;
alter table documents add column sent_to_review_by text references staff (id);
alter table documents add column sent_to_review_at timestamptz;

create unique index documents_sha256_idx on documents (content_sha256) where content_sha256 is not null;
create index documents_status_idx on documents (status, received_at desc);

-- Which embedding model produced a vector: vectors from different models are never compared.
alter table document_chunks add column embedding_model text;

-- An open item can be closed by the document that satisfied it.
alter table open_items add column document_id text references documents (id);

-- Notes can be written by a person or by a tool on their behalf; keep the kind for the dashboard.
alter table notes add column kind text not null default 'note' check (kind in ('note', 'filing'));
