/**
 * Types for the dashboard JSON API (`/api/*`) and a small typed fetch client.
 *
 * Auth has two modes, reported by `GET /api/me`:
 * - dev:   the server trusts the `x-clientdesk-user: <email>` header, chosen with the user switcher.
 * - oauth: a session cookie set by the server; `/api/me` answers 401 when not signed in.
 * Every POST carries `x-clientdesk-csrf: 1` (the server rejects POSTs without it).
 */

export type Role = 'partner' | 'assistant';
export type AuthMode = 'dev' | 'oauth';
export type Outcome = 'ok' | 'denied' | 'error';

export interface Me {
  staffId: string;
  name: string;
  email: string;
  role: Role;
  authMode: AuthMode;
}

export interface StaffMember {
  email: string;
  name: string;
  role: Role;
}

export interface Stats {
  documents: { inbox: number; review: number; filed: number };
  toolCallsToday: { ok: number; denied: number; error: number };
  openItems: number;
}

export interface AuditRow {
  id: number;
  at: string;
  staff: { id: string; name: string } | null;
  tool: string;
  outcome: Outcome;
  detail: string | null;
  durationMs: number | null;
  input: unknown;
}

export interface AuditPage {
  rows: AuditRow[];
  nextBefore: number | null;
  tools: string[];
}

export interface AuditQuery {
  limit?: number;
  before?: number | null;
  outcome?: Outcome | null;
  tool?: string | null;
}

export interface ExtractedField {
  name: string;
  value: string | null;
  confidence: number;
}

export interface ClientCandidate {
  clientId: string;
  name: string;
  /** 0..1 */
  confidence: number;
  reasons: string[];
}

export interface ReviewItem {
  id: string;
  title: string;
  filename: string | null;
  receivedAt: string;
  reviewReason: string | null;
  sentBy: { name: string } | null;
  docType: string | null;
  extraction: { docType: string | null; fields: ExtractedField[]; model: string } | null;
  candidates: ClientCandidate[];
}

export interface InboxItem {
  id: string;
  title: string;
  filename: string | null;
  receivedAt: string;
  uploadedBy: { name: string } | null;
  pageCount: number | null;
}

export interface UploadResult {
  id: string;
  title: string;
  duplicate: boolean;
}

export interface AccuracyMetric {
  key: string;
  label: string;
  value: number;
  target: number;
  op: '>=' | '<=';
  unit: 'percent' | 'count';
  pass: boolean;
}

export interface AccuracyByDocType {
  docType: string;
  documents: number;
  /** 0..1 */
  fieldAccuracy: number;
  /** 0..1 */
  reviewRate: number;
}

export interface AccuracyCase {
  id: string;
  docType: string;
  hardCase: string | null;
  expected: string;
  outcome: string;
  correct: boolean;
  fieldErrors: string[];
}

export interface AccuracyReport {
  generatedAt: string;
  extractor: string;
  embedder: string;
  dataset: { documents: number; questions: number };
  metrics: AccuracyMetric[];
  byDocType: AccuracyByDocType[];
  cases: AccuracyCase[];
  changes: string[];
}

/** An HTTP error from the API, carrying the server's `{ error }` message when there is one. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}

// ---------------------------------------------------------------------------------------------------------------
// Dev-mode identity. Sent until the server reports its auth mode, then only in dev mode.

export const DEFAULT_DEV_USER = 'maya@northbridge.example';
const DEV_USER_KEY = 'clientdesk.devUser';

export function getDevUser(): string {
  try {
    return localStorage.getItem(DEV_USER_KEY) || DEFAULT_DEV_USER;
  } catch {
    return DEFAULT_DEV_USER;
  }
}

export function setDevUser(email: string): void {
  try {
    localStorage.setItem(DEV_USER_KEY, email);
  } catch {
    // Storage blocked (private window): the choice lasts until reload.
  }
  memoryDevUser = email;
}

let memoryDevUser: string | null = null;

/**
 * Forgets a stored dev user and goes back to the default. Used when the server no longer knows the stored email
 * (for example after a re-seed), which would otherwise leave dev mode stuck on a 401.
 * Returns whether there was a non-default choice to forget.
 */
export function resetDevUser(): boolean {
  const current = memoryDevUser ?? getDevUser();
  memoryDevUser = null;
  try {
    localStorage.removeItem(DEV_USER_KEY);
  } catch {
    // Nothing stored.
  }
  return current !== DEFAULT_DEV_USER;
}

/**
 * The auth mode last reported by `/api/me`. Until it is known the dev header is sent (the server needs it to answer
 * `/api/me` in dev mode); once the server reports `oauth`, it is no longer sent.
 */
let knownAuthMode: AuthMode | null = null;

export function setKnownAuthMode(mode: AuthMode | null): void {
  knownAuthMode = mode;
}

function authHeaders(): Record<string, string> {
  if (knownAuthMode === 'oauth') return {};
  return { 'x-clientdesk-user': memoryDevUser ?? getDevUser() };
}

// ---------------------------------------------------------------------------------------------------------------
// Fetch client

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(), ...init.headers };
  if (method === 'POST') headers['x-clientdesk-csrf'] = '1';

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: init.body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Could not reach the ClientDesk server. Is it running?');
  }

  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(res.status, 'The server sent a response the dashboard could not read.');
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Not JSON (for example a proxy error page).
  }
  return `Request failed (${res.status} ${res.statusText || 'error'})`;
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

/** HTTP header values must be Latin-1; keep printable ASCII and replace anything else so fetch never throws. */
function headerSafeFilename(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/g, '_').trim();
  return safe || 'upload';
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  staff: () => request<{ staff: StaffMember[] }>('GET', '/api/staff'),
  stats: () => request<Stats>('GET', '/api/stats'),
  audit: (q: AuditQuery = {}) =>
    request<AuditPage>(
      'GET',
      `/api/audit${query({ limit: q.limit ?? 50, before: q.before, outcome: q.outcome, tool: q.tool })}`,
    ),
  review: () => request<{ items: ReviewItem[] }>('GET', '/api/review'),
  resolveReview: (id: string, body: { clientId: string; taxYear?: number }) =>
    request<{ ok: true }>('POST', `/api/review/${encodeURIComponent(id)}/resolve`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  inbox: () => request<{ items: InboxItem[] }>('GET', '/api/inbox'),
  upload: (file: File, contentType: 'application/pdf' | 'text/plain') =>
    request<UploadResult>('POST', '/api/documents', {
      body: file,
      headers: { 'content-type': contentType, 'x-filename': headerSafeFilename(file.name) },
    }),
  accuracy: () => request<AccuracyReport>('GET', '/api/accuracy'),
  logout: () => request<unknown>('POST', '/auth/logout'),
};

export function documentFileUrl(id: string): string {
  return `/api/documents/${encodeURIComponent(id)}/file`;
}

/**
 * Opens a stored document in a new tab.
 *
 * With a session cookie (oauth) a plain link works. In dev mode the identity travels in a header, which a link can't
 * send, so the file is fetched with the header and shown from a blob URL. The tab is opened synchronously (inside
 * the click) so pop-up blockers allow it, then pointed at the blob once it has loaded.
 */
export async function openDocument(id: string): Promise<void> {
  const url = documentFileUrl(id);
  if (knownAuthMode === 'oauth') {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const tab = window.open('', '_blank');
  try {
    const res = await fetch(url, { headers: authHeaders(), credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    // The blob URL lives on the dashboard's origin, so never let it be anything a browser would run as a page:
    // a PDF, or else plain text.
    const type = res.headers.get('content-type')?.startsWith('application/pdf') ? 'application/pdf' : 'text/plain';
    const blobUrl = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
    if (tab) tab.location.href = blobUrl;
    else window.location.assign(blobUrl);
    // Give the new tab time to load the blob before releasing it.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  } catch (error) {
    tab?.close();
    throw error instanceof ApiError ? error : new ApiError(0, 'Could not open the document.');
  }
}
