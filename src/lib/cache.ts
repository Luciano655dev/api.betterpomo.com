// Each API instance keeps its own fast, in-process cache (reads never leave the
// process). The one thing that breaks with multiple instances — a mutation's
// invalidation not reaching the others — is fixed by broadcasting del/delByPrefix
// over Redis pub/sub when REDIS_URL is set (see lib/redis.ts). Every instance
// applies the invalidation to its local copy, so reads stay coherent while
// avoiding a Redis round trip on the hot read path. Without Redis this is a plain
// single-instance in-memory cache with bounded (TTL) staleness.
import { randomUUID } from "crypto";
import { redis, redisSub } from "./redis";

interface Entry { data: unknown; expiresAt: number }
const store = new Map<string, Entry>();

// Hard ceiling so a flood of distinct keys (e.g. unique search terms) can't grow
// the map without bound between sweeps. On overflow we drop the oldest entries
// (Map preserves insertion order).
const MAX_ENTRIES = 50_000;

// Identifies this instance so it can ignore the invalidations it published itself
// (it already applied them locally before publishing).
const INSTANCE_ID = randomUUID();
const INVALIDATION_CHANNEL = "cache:invalidate";

// Local mutations that must NOT re-publish (used when applying a remote message).
function localDel(key: string): void { store.delete(key); }
function localDelByPrefix(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

function broadcast(op: "del" | "delByPrefix", arg: string): void {
  // Fire-and-forget; a publish failure just means other instances rely on TTL.
  redis?.publish(INVALIDATION_CHANNEL, JSON.stringify({ from: INSTANCE_ID, op, arg }))
    .catch(() => {});
}

export const cache = {
  get<T>(key: string): T | null {
    const e = store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { store.delete(key); return null; }
    return e.data as T;
  },

  set(key: string, data: unknown, ttlMs: number): void {
    // Refresh insertion order on overwrite so hot keys aren't evicted first.
    store.delete(key);
    if (store.size >= MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { data, expiresAt: Date.now() + ttlMs });
  },

  del(key: string): void {
    localDel(key);
    broadcast("del", key);
  },

  delByPrefix(prefix: string): void {
    localDelByPrefix(prefix);
    broadcast("delByPrefix", prefix);
  },
};

// Apply invalidations published by other instances to the local copy.
if (redisSub) {
  redisSub.subscribe(INVALIDATION_CHANNEL).catch((e) =>
    console.error("Redis subscribe failed:", (e as Error).message));
  redisSub.on("message", (channel, message) => {
    if (channel !== INVALIDATION_CHANNEL) return;
    try {
      const { from, op, arg } = JSON.parse(message) as { from: string; op: string; arg: string };
      if (from === INSTANCE_ID) return; // we already applied it locally
      if (op === "del") localDel(arg);
      else if (op === "delByPrefix") localDelByPrefix(arg);
    } catch { /* ignore malformed messages */ }
  });
}

// Entries are lazily dropped on read-after-expiry, but keys never read again
// would otherwise linger forever. Sweep expired entries periodically so idle
// keys don't pin memory. unref() so this timer never keeps the process alive.
const SWEEP_INTERVAL_MS = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of store) if (now > e.expiresAt) store.delete(k);
}, SWEEP_INTERVAL_MS).unref();

export const TTL = {
  PROFILE: 60_000,         // 60s — own profile
  USER: 60_000,            // 60s — public user profile by username
  USER_HISTORY: 60_000,    // 60s — public user history
  HISTORY: 30_000,         // 30s — own history list
  SEARCH: 30_000,          // 30s — search results
  TIMERS: 30_000,          // 30s — session timer definitions
  FRIENDS: 30_000,         // 30s — friends list + count
  FRIEND_REQUESTS: 15_000, // 15s — incoming/outgoing friend requests
  CONVERSATIONS: 10_000,   // 10s — conversation list (drives unread badge)
  NOTIFICATIONS: 10_000,   // 10s — notification list + unread count
  ACTIVE_SESSIONS: 10_000, // 10s — public "browse live sessions" list (same for everyone)
  FEEDBACK: 30_000,        // 30s — feedback board posts + vote counts (viewer votes stay fresh)
  PLAN: 60_000,            // 60s — billing columns for entitlement gates (plan:{userId})
  BILLING: 30_000,         // 30s — GET /api/billing response (billing:{userId})
  TEMPLATES: 60_000,       // 60s — session templates list (templates:{userId})
};

// Default lifetime for temporary chat messages (passed to post_dm_message).
export const CHAT_TTL_SECONDS = 86_400; // 24h
