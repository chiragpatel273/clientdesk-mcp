import type { Db } from '../db/index.js';
import { fieldValue, type Extraction } from '../ai/extraction.js';

export interface MatchProfile {
  id: string;
  name: string;
  taxIdLast4: string | null;
  contacts: { name: string; email: string | null }[];
}

export interface MatchCandidate {
  clientId: string;
  name: string;
  /** 0..1. Calibrated so that only near-exact names, or a name plus a second identifier, reach the filing threshold. */
  confidence: number;
  reasons: string[];
}

export interface MatchResult {
  candidates: MatchCandidate[];
  /** `file`: the best candidate clears the threshold and the margin. `review`: a human must decide. */
  decision: 'file' | 'review';
  reason: string;
}

export async function loadMatchProfiles(db: Db): Promise<MatchProfile[]> {
  const clients = await db.query<{ id: string; name: string; tax_id_last4: string | null }>(
    `select id, name, tax_id_last4 from clients where status = 'active' order by id`,
  );
  const contacts = await db.query<{ client_id: string; name: string; email: string | null }>(
    'select client_id, name, email from contacts order by client_id, name',
  );
  return clients.map((c) => ({
    id: c.id,
    name: c.name,
    taxIdLast4: c.tax_id_last4,
    contacts: contacts.filter((x) => x.client_id === c.id).map((x) => ({ name: x.name, email: x.email })),
  }));
}

const LEGAL_SUFFIXES = /\b(ltd|limited|llc|inc|incorporated|corp|corporation|co|plc|lp|llp)\b/g;

/** Lowercase, no punctuation, no legal suffixes: "Acme Ltd." → "acme". */
export function normalizeEntity(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/^\s*the\s+/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** 0..1 similarity of two entity names: the better of edit-distance ratio and word overlap. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeEntity(a);
  const y = normalizeEntity(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const edit = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const wx = new Set(x.split(' '));
  const wy = new Set(y.split(' '));
  const overlap = [...wx].filter((w) => wy.has(w)).length / new Set([...wx, ...wy]).size;
  return Math.max(edit, overlap);
}

const BASE = 0.9; // an exact name alone scores 0.9: enough to file only when no look-alike client is close.
const TAX_ID_MATCH = 0.25;
const CONTACT_MENTIONED = 0.1;

export function matchClients(
  extraction: Extraction,
  text: string,
  profiles: MatchProfile[],
  filing: { threshold: number; margin: number },
): MatchResult {
  const lowerText = text.toLowerCase();
  const docName = extraction.clientName;
  const nameField = extraction.fields.find((x) =>
    ['billed_to', 'account_holder', 'client_name', 'recipient_name'].includes(x.name),
  );
  // How sure the extractor was about the name it read; a blurry name can't carry a filing on its own.
  const nameConfidence = nameField?.confidence ?? extraction.docTypeConfidence;
  const tinLast4 = fieldValue(extraction, 'recipient_tin_last4');

  const scored = profiles.map((client): MatchCandidate => {
    const reasons: string[] = [];
    let similarity = 0;
    if (docName) {
      similarity = nameSimilarity(docName, client.name);
      if (similarity === 1) reasons.push(`Name on the document, "${docName}", matches exactly`);
      else if (similarity >= 0.6)
        reasons.push(`Name on the document, "${docName}", is similar (${Math.round(similarity * 100)}%)`);
    }
    if (similarity < 0.9 && lowerText.includes(client.name.toLowerCase())) {
      similarity = 0.9;
      reasons.push(`"${client.name}" appears in the document text`);
    }

    let confidence = BASE * similarity * (0.7 + 0.3 * nameConfidence);
    if (nameConfidence < 0.8 && similarity > 0) reasons.push('The name was hard to read');

    if (tinLast4 && client.taxIdLast4) {
      if (tinLast4 === client.taxIdLast4) {
        confidence += TAX_ID_MATCH;
        reasons.push(`Tax id ending ${tinLast4} matches`);
      } else {
        confidence *= 0.3;
        reasons.push(`Tax id ending ${tinLast4} does not match this client`);
      }
    }

    const contact = client.contacts.find(
      (c) =>
        (c.email && lowerText.includes(c.email.toLowerCase())) ||
        (c.name !== client.name && lowerText.includes(c.name.toLowerCase())),
    );
    if (contact && confidence > 0.2) {
      confidence += CONTACT_MENTIONED;
      reasons.push(`Mentions ${contact.name}, a contact for this client`);
    }

    return {
      clientId: client.id,
      name: client.name,
      confidence: Math.min(0.99, Number(confidence.toFixed(3))),
      reasons,
    };
  });

  const candidates = scored
    .filter((c) => c.confidence >= 0.3)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  const [best, second] = candidates;
  if (!best) {
    return {
      candidates,
      decision: 'review',
      reason: docName ? `No client resembles "${docName}".` : 'Could not read who this document is for.',
    };
  }
  const pct = (c: MatchCandidate) => `${Math.round(c.confidence * 100)}%`;
  const close = second && best.confidence - second.confidence < filing.margin;
  if (best.confidence < filing.threshold) {
    return {
      candidates,
      decision: 'review',
      reason: close
        ? `Could be ${best.name} (${pct(best)}) or ${second.name} (${pct(second)}); neither reaches ${Math.round(filing.threshold * 100)}%.`
        : `Best match ${best.name} is only ${pct(best)} (needs ${Math.round(filing.threshold * 100)}%).`,
    };
  }
  if (close) {
    return {
      candidates,
      decision: 'review',
      reason: `${best.name} and ${second.name} are both likely (${pct(best)} vs ${pct(second)}).`,
    };
  }
  return { candidates, decision: 'file', reason: `${best.name} at ${Math.round(best.confidence * 100)}%.` };
}
