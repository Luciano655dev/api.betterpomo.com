import type { Request, Response, NextFunction } from "express";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { adminDb, createAuthClient } from "../lib/supabase";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: User;
      supabase: SupabaseClient;
      token: string;
    }
  }
}

// Short-lived cache of verified tokens → user. Every API request would otherwise
// make a network round-trip to Supabase Auth (auth.getUser); the frontend polls
// several endpoints on intervals, so at thousands of users that is a large, mostly
// redundant load. Caching the verification for a few seconds collapses bursts of
// requests from the same client into one upstream call. The TTL is the worst-case
// latency for a revoked/expired token to stop being accepted.
// Kept in-process on purpose: this is a latency optimization on the hot auth path,
// so a per-request Redis round trip would defeat it. The TTL is the worst-case
// window a revoked/expired token stays accepted — kept short to bound that.
const TOKEN_TTL_MS = 15_000;
const MAX_ENTRIES = 50_000; // hard cap so the map can't grow unbounded
const tokenCache = new Map<string, { user: User; expiresAt: number }>();

function getCachedUser(token: string): User | null {
  const hit = tokenCache.get(token);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { tokenCache.delete(token); return null; }
  return hit.user;
}

function cacheUser(token: string, user: User): void {
  // Cheap eviction: when full, drop the oldest insertion (Map preserves order).
  if (tokenCache.size >= MAX_ENTRIES) {
    const oldest = tokenCache.keys().next().value;
    if (oldest) tokenCache.delete(oldest);
  }
  tokenCache.set(token, { user, expiresAt: Date.now() + TOKEN_TTL_MS });
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  let user = getCachedUser(token);
  if (!user) {
    // Validate the JWT with the anon client (auth.getUser verifies the signature server-side)
    const authClient = createAuthClient(token);
    const { data, error } = await authClient.auth.getUser();
    if (error || !data.user) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    user = data.user;
    cacheUser(token, user);
  }

  req.user = user;
  req.token = token;
  // Route handlers use the service-role client — bypasses RLS so the Express
  // application layer (not the DB) is the sole authorization boundary.
  req.supabase = adminDb;
  next();
}
