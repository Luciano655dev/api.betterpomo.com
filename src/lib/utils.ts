export function generateSessionCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/**
 * Parse a query-string value into a bounded integer. Garbage / missing input
 * falls back to `fallback`; valid input is clamped to [min, max]. Keeps malformed
 * `?limit=`/`?offset=` params from producing NaN ranges or unbounded scans.
 */
export function clampInt(raw: unknown, opts: { min: number; max: number; fallback: number }): number {
  const n = parseInt(String(raw), 10);
  if (Number.isNaN(n)) return opts.fallback;
  return Math.min(opts.max, Math.max(opts.min, n));
}

/**
 * Escape LIKE/ILIKE wildcards (`\`, `%`, `_`) so user-supplied search text is
 * matched literally instead of acting as a pattern (e.g. a lone `%` matching
 * every row, or `_` matching any character).
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
