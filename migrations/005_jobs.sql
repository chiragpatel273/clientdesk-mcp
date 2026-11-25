-- v2 phase 3: batch intake through a Postgres job queue (FOR UPDATE SKIP LOCKED; no Redis).

-- A document being processed by a background job is not in the inbox yet: list_inbox and file_document skip it.
alter table documents drop constraint documents_status_check;
alter table documents add constraint documents_status_check
  check (status in ('processing', 'inbox', 'filed', 'review'));

-- One upload of several files by a partner.
create table batches (
  id          text primary key,
  created_by  text not null references staff (id),
  created_at  timestamptz not null default now(),
  total       integer not null check (total between 1 and 100)
);

-- One job per document. `step` is the last step completed; `status` is where the job is in the queue.
create table jobs (
  id               bigserial primary key,
  kind             text not null check (kind in ('intake')),
  batch_id         text references batches (id) on delete cascade,
  document_id      text not null references documents (id) on delete cascade,
  created_by       text not null references staff (id),
  idempotency_key  text unique,
  step             text not null default 'stored'
                   check (step in ('stored', 'text_extracted', 'embedded', 'fields_extracted', 'matched', 'filed', 'review')),
  status           text not null default 'queued' check (status in ('queued', 'running', 'done', 'dead')),
  attempts         integer not null default 0,      -- counted when claimed, reset when a step succeeds
  max_attempts     integer not null default 5,
  run_at           timestamptz not null default now(),  -- not before: retry backoff
  locked_at        timestamptz,
  locked_by        text,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create index jobs_claim_idx on jobs (run_at, id) where status in ('queued', 'running');
create index jobs_batch_idx on jobs (batch_id, id);
create index jobs_dead_idx on jobs (updated_at desc) where status = 'dead';
