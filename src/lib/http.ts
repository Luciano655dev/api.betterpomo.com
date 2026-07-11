import type { Response } from "express";

/**
 * Log the real error server-side and return a generic 500 to the client.
 *
 * Raw Supabase/Postgres error text (table names, column names, constraint
 * details, driver internals) is reconnaissance material — it should never reach
 * an API client. Use this for unexpected/internal failures only; keep specific
 * 4xx validation messages ("name is required", etc.) as they are, since those
 * are intentional and safe to show.
 */
export function serverError(res: Response, err: unknown, context?: string): void {
  console.error(context ? `[${context}]` : "Server error:", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
}
