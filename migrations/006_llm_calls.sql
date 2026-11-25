-- v2 phase 6: one row per model call (extraction, embeddings), for the Usage page. Counts and timings only: never
-- document text, prompts or answers.
create table llm_calls (
  id                bigserial primary key,
  at                timestamptz not null default now(),
  staff_id          text references staff (id),          -- on whose behalf (null: start-up seeding)
  source            text not null check (source in ('mcp', 'dashboard', 'job', 'startup', 'script')),
  operation         text not null check (operation in ('extract', 'embed', 'rerank')),
  provider          text not null,                       -- anthropic, groq, voyage, local
  model             text not null,
  input_tokens      integer not null default 0,
  output_tokens     integer not null default 0,
  tokens_estimated  boolean not null default false,      -- offline models: characters / 4, cost 0
  cost_usd          numeric(12, 6) not null default 0,   -- estimated from src/ai/prices.ts
  latency_ms        integer not null,
  escalated         boolean not null default false,      -- the larger model's second look
  success           boolean not null,
  error             text,                                -- short message, no document content
  document_id       text references documents (id) on delete set null,
  job_id            bigint references jobs (id) on delete set null
);

create index llm_calls_at_idx on llm_calls (at desc);
