---
name: add-migration
description: Change the ClientDesk database schema with a new numbered SQL migration. Use for any new table, column or index.
---

# Add a migration

1. Create `migrations/NNN_short_name.sql` with the next number (`002_…`, `003_…`). Never edit a file that has been applied.
2. Plain Postgres SQL that runs on both PGlite and Postgres 16+. The `vector` extension is available.
3. Any table holding client data gets a `client_id text references clients (id)` column, so access checks stay one join.
4. Never add columns for full tax ids, account numbers or passwords. Store the last 4 digits at most.
5. Add indexes for the queries you are about to write (client_id plus a date is the usual pair).
6. If `resetData()` in `src/demo/seed.ts` must truncate the new table, add it there.
7. Run `npm test`: tests build a fresh in-memory database from all migrations, so a broken migration fails fast.
8. Locally: `npm run seed -- --reset` rebuilds `.data/` with the new schema (delete `.data/` if a migration was rewritten during development).
