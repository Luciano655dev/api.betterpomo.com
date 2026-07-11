import { RedisStore } from "rate-limit-redis";
import { redis } from "./redis";

/**
 * Build a shared rate-limit store backed by the command Redis connection. Only
 * call when `redis` is non-null. Each limiter passes a distinct `prefix` so their
 * counters don't collide (e.g. session-message vs DM-message quotas per user).
 */
export function makeRedisStore(prefix: string): RedisStore {
  return new RedisStore({
    // ioredis exposes `call`; forward the raw command express-rate-limit sends.
    sendCommand: (...args: string[]) => redis!.call(args[0], ...args.slice(1)) as Promise<never>,
    prefix,
  });
}
