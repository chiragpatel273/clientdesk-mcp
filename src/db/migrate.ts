import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.js';

/** Finds the repo root (the folder holding package.json), whether running from src/ or dist/. */
export function projectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('package.json not found');
    dir = parent;
  }
  return dir;
}

/** Applies every migrations/*.sql file not yet recorded, in file-name order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`);
  const applied = new Set(
    (await db.query<{ version: string }>('select version from schema_migrations')).map((r) => r.version),
  );
  const dir = join(projectRoot(), 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await db.exec(`begin;\n${sql}\ninsert into schema_migrations (version) values ('${file}');\ncommit;`);
    ran.push(file);
  }
  return ran;
}
