import type { NextFunction, Request, Response } from 'express';

export interface RateWindow {
  /** Requests allowed per key in each window. */
  max: number;
  windowMs: number;
}

/** One visitor: an IPv4 address, or an IPv6 /64 (a home network owns the whole block, so single addresses mean nothing). */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const v4 = ip.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4) return v4[1]!;
  const [head = '', tail] = ip.split('::');
  const left = head.split(':').filter(Boolean);
  const right = tail === undefined ? [] : tail.split(':').filter(Boolean);
  const groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, '').toLowerCase())
    .join(':')}::/64`;
}

/**
 * A small in-memory fixed-window limiter, keyed by client IP. Enough for one instance (Render free runs one); several
 * instances would each keep their own counts, which only makes the limit looser, never stricter.
 */
export function rateLimit(
  windows: RateWindow[],
  options: { now?: () => number; message?: string } = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const now = options.now ?? Date.now;
  const message = options.message ?? 'Too many requests from this address. Try again in a few minutes.';
  const hits = new Map<string, { start: number; count: number }[]>();
  let lastSweep = now();

  return (req: Request, res: Response, next: NextFunction) => {
    const t = now();
    // Forget idle keys now and then so the map can't grow without bound.
    if (t - lastSweep > 60_000) {
      const longest = Math.max(...windows.map((w) => w.windowMs));
      for (const [key, entries] of hits) if (entries.every((e) => t - e.start >= longest)) hits.delete(key);
      lastSweep = t;
    }
    const key = clientKey(req.ip);
    const entries = hits.get(key) ?? windows.map(() => ({ start: t, count: 0 }));
    let retryAfterMs = 0;
    windows.forEach((w, i) => {
      const e = entries[i]!;
      if (t - e.start >= w.windowMs) {
        e.start = t;
        e.count = 0;
      }
      if (e.count >= w.max) retryAfterMs = Math.max(retryAfterMs, e.start + w.windowMs - t);
    });
    hits.set(key, entries);
    if (retryAfterMs > 0) {
      res
        .status(429)
        .set('retry-after', String(Math.ceil(retryAfterMs / 1000)))
        .json({ error: message });
      return;
    }
    for (const e of entries) e.count++;
    next();
  };
}
