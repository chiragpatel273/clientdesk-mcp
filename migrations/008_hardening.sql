-- v2 security review fixes.

-- Search passages: which version of the document they were built from. Filing bumps content_version in the same
-- statement that files; a rebuild records the version it read. Different (or null): stale, rebuilt on start-up.
alter table documents add column content_version integer not null default 1;
alter table documents add column indexed_version integer;
update documents set indexed_version = content_version
 where exists (select 1 from document_chunks ch where ch.document_id = documents.id);

-- Files a batch has taken, so its limit holds under parallel uploads.
alter table batches add column accepted integer not null default 0;
update batches set accepted = (select count(*) from jobs where jobs.batch_id = batches.id);

-- Same-firm references 007 left out.
alter table batches add constraint batches_firm_id_key unique (firm_id, id);
alter table jobs add constraint jobs_firm_id_key unique (firm_id, id);
alter table batches
  add constraint batches_firm_created_by_fkey foreign key (firm_id, created_by) references staff (firm_id, id);
alter table jobs
  add constraint jobs_firm_batch_fkey foreign key (firm_id, batch_id) references batches (firm_id, id) on delete cascade;
alter table audit_log
  add constraint audit_log_firm_staff_fkey foreign key (firm_id, staff_id) references staff (firm_id, id);
alter table llm_calls
  add constraint llm_calls_firm_staff_fkey foreign key (firm_id, staff_id) references staff (firm_id, id),
  add constraint llm_calls_firm_document_fkey foreign key (firm_id, document_id) references documents (firm_id, id)
    on delete set null (document_id),
  add constraint llm_calls_firm_job_fkey foreign key (firm_id, job_id) references jobs (firm_id, id)
    on delete set null (job_id);
alter table documents
  add constraint documents_firm_sent_to_review_by_fkey
    foreign key (firm_id, sent_to_review_by) references staff (firm_id, id);

-- Idempotency keys belong to a firm: one firm's key can't clash with another's.
alter table jobs drop constraint jobs_idempotency_key_key;
alter table jobs add constraint jobs_firm_idempotency_key unique (firm_id, idempotency_key);

-- New tables are closed to the app role until a migration grants them (and adds RLS) on purpose.
alter default privileges in schema public revoke select, insert, update, delete on tables from clientdesk_app;
alter default privileges in schema public revoke usage, select on sequences from clientdesk_app;

-- Attempts to use another firm's ids. Owner only: a firm's own audit log records every unknown id the same way, so
-- neither the caller nor their partners can tell "exists elsewhere" from "doesn't exist".
create table security_events (
  id             bigserial primary key,
  at             timestamptz not null default now(),
  firm_id        text not null,
  staff_id       text,
  tool           text not null,
  kind           text not null,
  object_id      text not null,
  owner_firm_id  text not null
);
alter table security_events enable row level security;
revoke all on security_events from clientdesk_app;

drop function clientdesk_owner_firm(text, text);

-- Records an attempt if the id belongs to another firm. Returns nothing, so the app never learns which it was.
create function clientdesk_note_cross_firm(object_kind text, object text, staff text, used_by text) returns void
language sql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
  insert into public.security_events (firm_id, staff_id, tool, kind, object_id, owner_firm_id)
  select current_setting('app.firm_id', true), staff, left(used_by, 100), object_kind, left(object, 100), o.firm_id
  from (
    select firm_id from public.clients where object_kind = 'client' and id = object
    union all select firm_id from public.documents where object_kind = 'document' and id = object
    union all select firm_id from public.jobs where object_kind = 'job' and id::text = object
    union all select firm_id from public.batches where object_kind = 'batch' and id = object
    union all select firm_id from public.open_items where object_kind = 'open_item' and id = object
  ) o
  where o.firm_id <> current_setting('app.firm_id', true)
$$;
revoke all on function clientdesk_note_cross_firm(text, text, text, text) from public;
grant execute on function clientdesk_note_cross_firm(text, text, text, text) to clientdesk_app;
