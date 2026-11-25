-- v2 phase 2: passages now carry key identifiers and the fields they hold in their context line.
-- Start-up rebuilds any document whose passages are older than the current format or come from another embedder.
alter table document_chunks add column passage_version integer not null default 1;
