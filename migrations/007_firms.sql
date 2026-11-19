-- v2 phase 4: several firms in one database, isolated twice: in the domain layer (every query names the actor's firm)
-- and here, with row-level security on every firm-owned table.

create table firms (
  id          text primary key check (id ~ '^firm_[a-z0-9_]{1,40}$'),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Everything that exists today belongs to the first firm.
insert into firms (id, name) values ('firm_northbridge', 'Northbridge Advisory');

-- firm_id everywhere, backfilled to Northbridge. Afterwards it defaults to the transaction's app.firm_id: an insert
-- made outside a firm scope gets null and fails (NOT NULL) instead of landing in some firm.
do $$
declare
  t text;
begin
  foreach t in array array['staff', 'clients', 'client_assignments', 'contacts', 'open_items', 'notes', 'documents',
                           'document_chunks', 'audit_log', 'batches', 'jobs', 'llm_calls'] loop
    execute format('alter table %I add column firm_id text not null default %L references firms (id)', t,
                   'firm_northbridge');
    execute format($f$alter table %I alter column firm_id set default nullif(current_setting('app.firm_id', true), '')$f$, t);
  end loop;
end $$;

-- Same-firm references, enforced by the database: a client, staff member or document can only be referenced from
-- rows of its own firm, even by a bug that slipped past both other layers.
alter table staff add constraint staff_firm_id_key unique (firm_id, id);
alter table clients add constraint clients_firm_id_key unique (firm_id, id);
alter table documents add constraint documents_firm_id_key unique (firm_id, id);

alter table client_assignments
  add constraint client_assignments_firm_client_fkey foreign key (firm_id, client_id) references clients (firm_id, id) on delete cascade,
  add constraint client_assignments_firm_staff_fkey foreign key (firm_id, staff_id) references staff (firm_id, id) on delete cascade;
alter table contacts
  add constraint contacts_firm_client_fkey foreign key (firm_id, client_id) references clients (firm_id, id) on delete cascade;
alter table open_items
  add constraint open_items_firm_client_fkey foreign key (firm_id, client_id) references clients (firm_id, id) on delete cascade,
  add constraint open_items_firm_document_fkey foreign key (firm_id, document_id) references documents (firm_id, id);
alter table notes
  add constraint notes_firm_client_fkey foreign key (firm_id, client_id) references clients (firm_id, id) on delete cascade,
  add constraint notes_firm_author_fkey foreign key (firm_id, author_id) references staff (firm_id, id);
alter table documents
  add constraint documents_firm_client_fkey foreign key (firm_id, client_id) references clients (firm_id, id),
  add constraint documents_firm_filed_by_fkey foreign key (firm_id, filed_by) references staff (firm_id, id),
  add constraint documents_firm_uploaded_by_fkey foreign key (firm_id, uploaded_by) references staff (firm_id, id);
alter table document_chunks
  add constraint document_chunks_firm_document_fkey foreign key (firm_id, document_id) references documents (firm_id, id) on delete cascade;
alter table jobs
  add constraint jobs_firm_document_fkey foreign key (firm_id, document_id) references documents (firm_id, id) on delete cascade,
  add constraint jobs_firm_created_by_fkey foreign key (firm_id, created_by) references staff (firm_id, id);

-- Duplicate detection per firm: a global check would tell one firm that another already holds the same file.
drop index documents_sha256_idx;
create unique index documents_firm_sha256_idx on documents (firm_id, content_sha256) where content_sha256 is not null;

create index clients_firm_idx on clients (firm_id, lower(name));
create index documents_firm_status_idx on documents (firm_id, status, received_at desc);
create index audit_log_firm_at_idx on audit_log (firm_id, at desc);
create index llm_calls_firm_at_idx on llm_calls (firm_id, at desc);

-- The role every firm-scoped query runs as: not the tables' owner and without BYPASSRLS, so the policies below
-- apply to it. The app connects as the owner and switches with SET LOCAL ROLE inside each scoped transaction.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'clientdesk_app') then
    create role clientdesk_app nologin;
  end if;
end $$;
grant clientdesk_app to current_user;
grant usage on schema public to clientdesk_app;
grant select, insert, update, delete on all tables in schema public to clientdesk_app;
grant usage, select on all sequences in schema public to clientdesk_app;
revoke all on schema_migrations from clientdesk_app;
alter default privileges in schema public grant select, insert, update, delete on tables to clientdesk_app;
alter default privileges in schema public grant usage, select on sequences to clientdesk_app;

-- Row-level security: a scoped transaction sees and writes only rows of its firm.
do $$
declare
  t text;
begin
  foreach t in array array['staff', 'clients', 'client_assignments', 'contacts', 'open_items', 'notes', 'documents',
                           'document_chunks', 'audit_log', 'batches', 'jobs', 'llm_calls'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy firm_isolation on %I
                      using (firm_id = current_setting('app.firm_id', true))
                      with check (firm_id = current_setting('app.firm_id', true))$p$, t);
  end loop;
end $$;
alter table firms enable row level security;
create policy firm_isolation on firms using (id = current_setting('app.firm_id', true));

-- Which firm owns an id, and nothing else: lets the app tell "not found" from "another firm's" for the audit log
-- (the caller still just sees "not found"). Runs as the owner, so it can look across firms.
create function clientdesk_owner_firm(kind text, object_id text) returns text
language sql stable security definer set search_path = public as $$
  select case kind
    when 'client' then (select firm_id from clients where id = object_id)
    when 'document' then (select firm_id from documents where id = object_id)
    when 'staff' then (select firm_id from staff where id = object_id)
    when 'job' then (select firm_id from jobs where id::text = object_id)
  end
$$;
revoke all on function clientdesk_owner_firm(text, text) from public;
grant execute on function clientdesk_owner_firm(text, text) to clientdesk_app;
