import type { Db } from '../db/index.js';

export type AuditOutcome = 'ok' | 'denied' | 'error';

export interface AuditEntry {
  staffId: string | null;
  tool: string;
  input: unknown;
  outcome: AuditOutcome;
  detail?: string;
  durationMs: number;
}

const SENSITIVE_KEYS = /tax.?id|account.?(number|no)|iban|ssn|password|secret|token/i;

/** Replaces values of sensitive-looking keys before they are written to the audit log. */
export function maskSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEYS.test(k) ? '***' : maskSensitive(v),
      ]),
    );
  }
  return value;
}

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.query(
    `insert into audit_log (staff_id, tool, input, outcome, detail, duration_ms)
     values ($1, $2, $3::jsonb, $4, $5, $6)`,
    [
      entry.staffId,
      entry.tool,
      JSON.stringify(maskSensitive(entry.input) ?? null),
      entry.outcome,
      entry.detail ?? null,
      Math.round(entry.durationMs),
    ],
  );
}
