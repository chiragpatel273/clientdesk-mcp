-- ClientDesk core schema.
-- Every client-scoped table carries client_id so access checks are a single join.

create extension if not exists vector;

create table staff (
  id          text primary key,
  name        text not null,
  email       text not null unique,
  role        text not null check (role in ('partner', 'assistant'))
);

create table clients (
  id               text primary key,
  name             text not null,
  entity_type      text not null check (entity_type in ('individual', 'company', 'partnership', 'trust')),
  fiscal_year_end  text,                -- 'MM-DD'
  tax_id_last4     text,                -- never store a full tax id
  status           text not null default 'active' check (status in ('active', 'inactive')),
  created_at       timestamptz not null default now()
);

create index clients_name_idx on clients (lower(name));

-- Which staff members work on which clients. Partners see every client;
-- assistants see only the clients assigned to them.
create table client_assignments (
  client_id  text not null references clients (id) on delete cascade,
  staff_id   text not null references staff (id) on delete cascade,
  primary key (client_id, staff_id)
);

create table contacts (
  id          text primary key,
  client_id   text not null references clients (id) on delete cascade,
  name        text not null,
  email       text,
  phone       text,
  is_primary  boolean not null default false
);

create table open_items (
  id           text primary key,
  client_id    text not null references clients (id) on delete cascade,
  tax_year     integer not null,
  description  text not null,
  status       text not null default 'open' check (status in ('open', 'received', 'waived')),
  due_date     date,
  created_at   timestamptz not null default now()
);

create table notes (
  id          text primary key,
  client_id   text not null references clients (id) on delete cascade,
  author_id   text references staff (id),
  body        text not null,
  created_at  timestamptz not null default now()
);

create table documents (
  id             text primary key,
  client_id      text references clients (id),          -- null while in the inbox
  tax_year       integer,
  doc_type       text check (doc_type in ('invoice', 'bank_statement', 'engagement_letter', 'tax_form', 'other')),
  title          text not null,
  status         text not null default 'inbox' check (status in ('inbox', 'filed', 'review')),
  storage_key    text,
  page_count     integer,
  received_at    timestamptz not null default now(),
  filed_at       timestamptz,
  filed_by       text references staff (id),
  review_reason  text
);

create index documents_client_idx on documents (client_id, received_at desc);

create table document_chunks (
  id           text primary key,
  document_id  text not null references documents (id) on delete cascade,
  page         integer,
  chunk_index  integer not null,
  content      text not null,
  embedding    vector(1024),
  tsv          tsvector generated always as (to_tsvector('english', content)) stored
);

create index document_chunks_tsv_idx on document_chunks using gin (tsv);

-- One row per tool call. Inputs are stored with sensitive fields masked.
create table audit_log (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  staff_id     text references staff (id),
  tool         text not null,
  input        jsonb,
  outcome      text not null check (outcome in ('ok', 'denied', 'error')),
  detail       text,
  duration_ms  integer
);

create index audit_log_at_idx on audit_log (at desc);
