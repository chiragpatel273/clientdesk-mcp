const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const integer = new Intl.NumberFormat();

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(iso: string): string {
  const d = parse(iso);
  return d ? dateTime.format(d) : iso;
}

/** Time for today's rows, day + time otherwise. */
export function formatWhen(iso: string, now = new Date()): string {
  const d = parse(iso);
  if (!d) return iso;
  return d.toDateString() === now.toDateString() ? timeOnly.format(d) : dayAndTime.format(d);
}

export function formatRelative(iso: string, now = Date.now()): string {
  const d = parse(iso);
  if (!d) return iso;
  const seconds = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  return formatDateTime(iso);
}

export function formatInt(n: number): string {
  return integer.format(n);
}

/** 0..1 fraction to a percentage. One decimal unless it is a whole number. */
export function formatPercent(fraction: number, digits = 1): string {
  const pct = fraction * 100;
  const rounded = Number(pct.toFixed(digits));
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(digits)}%`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** `bank_statement` -> `Bank statement` */
export function humanize(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  const s = value.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
