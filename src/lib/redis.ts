// Optional Redis backing for horizontal scaling. When REDIS_URL is set we use it
// for two things that break when the API runs as more than one instance:
//
//   1. Rate limiting — a shared counter so limits are global, not N× per instance
//      (see middleware/rateLimit.ts and index.ts).
//   2. Cache-invalidation fan-out — each instance keeps its own fast in-memory
//      cache, but del/delByPrefix are published so every instance drops the stale
//      entry (see lib/cache.ts). Reads stay in-process (no per-request round trip).
//
// When REDIS_URL is unset (local dev / single instance) everything falls back to
// pure in-memory behaviour and these clients are null.

import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

export const redisEnabled = !!REDIS_URL;

/** Command connection — rate-limit counters and publishing invalidations. */
export const redis: Redis | null = REDIS_URL ? new Redis(REDIS_URL) : null;

/** Dedicated subscriber connection. A subscribing client can't issue other
 *  commands, so pub/sub needs its own connection separate from `redis`. */
export const redisSub: Redis | null = REDIS_URL ? new Redis(REDIS_URL) : null;

// A Redis outage must never take down the API — log and keep serving from the
// in-memory cache. ioredis auto-reconnects in the background.
redis?.on("error", (e) => console.error("Redis (command) error:", e.message));
redisSub?.on("error", (e) => console.error("Redis (subscriber) error:", e.message));

if (redisEnabled) console.log("Redis enabled — shared cache invalidation + rate limiting active.");
