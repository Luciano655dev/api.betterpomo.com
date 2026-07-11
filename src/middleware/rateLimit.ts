import rateLimit from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import { redis } from "../lib/redis";
import { makeRedisStore } from "../lib/rateStore";

/**
 * Per-authenticated-user rate limiter. Mount AFTER `authenticate` so `req.user`
 * is populated. Keys by user id (not IP) so a single account can't spam an
 * endpoint regardless of how many devices/IPs it uses.
 *
 * When REDIS_URL is set the counter lives in Redis, so the limit is global across
 * instances; otherwise it's process-local (an N× ceiling with N instances, which
 * is still an adequate abuse backstop). `name` scopes the Redis keys so two
 * limiters don't share a counter.
 */
export function perUserLimiter(opts: {
  windowMs: number;
  limit: number;
  message: string;
  name: string;
}): RequestHandler {
  // Returned as a plain RequestHandler so composing it into a route
  // (`router.post(path, limiter, handler)`) doesn't widen the handler's inferred
  // req.params typing.
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? "anon",
    // We intentionally key by user id, not IP — disable the IPv6-fallback check.
    validate: { keyGeneratorIpFallback: false },
    message: { error: opts.message },
    ...(redis ? { store: makeRedisStore(`rl:${opts.name}:`) } : {}),
  });
}
