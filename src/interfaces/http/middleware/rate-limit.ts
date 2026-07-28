import { config } from '../../config/index';
import { extractClientIp } from '../../../shared/utils/ip';
import logger from '../../../shared/logger/index';

/** An entry in the in-memory rate-limit store. */
interface RateLimitEntry {
  /** Number of requests received during the current window. */
  count: number;
  /** Epoch timestamp (ms) when the current window expires. */
  resetTime: number;
}

/** In-memory store mapping keys (typically client IPs) to rate-limit entries. */
const rateLimitStore = new Map<string, RateLimitEntry>();
/** Maximum number of tracked entries before LRU eviction kicks in. */
const MAX_STORE_ENTRIES = 50000;

/**
 * Removes all expired entries from the rate-limit store.
 *
 * @param now - Current epoch timestamp in milliseconds (defaults to `Date.now()`).
 * @returns The number of entries that were cleaned.
 */
const evictExpiredEntries = (now = Date.now()): number => {
  let cleaned = 0;

  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }

  return cleaned;
};

/**
 * Ensures the store stays below {@link MAX_STORE_ENTRIES} by first
 * evicting expired entries, then dropping the oldest entries if the
 * store is still over capacity.
 *
 * @param now - Current epoch timestamp in milliseconds.
 */
const ensureStoreCapacity = (now: number): void => {
  if (rateLimitStore.size < MAX_STORE_ENTRIES) return;

  evictExpiredEntries(now);
  while (rateLimitStore.size >= MAX_STORE_ENTRIES) {
    const oldestKey = rateLimitStore.keys().next().value;
    if (!oldestKey) break;
    rateLimitStore.delete(oldestKey);
  }
};

/**
 * Checks whether the given key (typically a client IP) has exceeded
 * the allowed rate limit.
 *
 * On the first request within a window the entry is created and the
 * caller is allowed through.  Subsequent requests increment the
 * counter.  Returns `false` (and logs a warning) when the counter
 * exceeds the configured maximum.
 *
 * @param key - The key to check (e.g. a client IP address).
 * @returns `true` if the request is within the limit, `false` if
 *          rate-limited.
 */
export const checkRateLimit = (key: string): boolean => {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetTime) {
    ensureStoreCapacity(now);
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + config.rateLimitWindowMs,
    });
    return true;
  }

  if (entry.count >= config.rateLimitMaxRequests) {
    logger.warn('Rate limit exceeded', { key, count: entry.count });
    return false;
  }

  entry.count++;
  return true;
};

/**
 * Middleware that wraps a request handler with rate-limiting based
 * on the client IP address.
 *
 * When the client has exceeded the allowed number of requests within
 * the configured window a 429 Too Many Requests response is returned.
 *
 * @typeParam T - The request type (must extend `Request`).
 * @param handler - The request handler to protect.
 * @returns A wrapped handler that applies rate-limiting.
 */
export const withRateLimit = <T extends Request>(
  handler: (req: T) => Promise<Response>,
): ((req: T) => Promise<Response>) => {
  return async (req: T): Promise<Response> => {
    const ip = extractClientIp(req, config.trustProxy);
    if (!checkRateLimit(ip)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    return handler(req);
  };
};

/**
 * Manually evicts all expired entries from the rate-limit cache and
 * logs a debug message with the count of removed entries.
 */
export const cleanupRateLimitCache = (): void => {
  const cleaned = evictExpiredEntries();

  if (cleaned > 0) {
    logger.debug('Rate limit cache cleanup', { cleaned, remaining: rateLimitStore.size });
  }
};

/**
 * Returns diagnostic statistics about the current state of the
 * rate-limit store.
 *
 * @returns An object with tracked-IP count, configured window size,
 *          max requests, and max tracked entries.
 */
export const getRateLimitStats = () => ({
  trackedIPs: rateLimitStore.size,
  windowSize: config.rateLimitWindowMs,
  maxRequests: config.rateLimitMaxRequests,
  maxTrackedIPs: MAX_STORE_ENTRIES,
});

/**
 * Clears all entries from the rate-limit cache (used primarily in
 * tests).
 */
export const clearRateLimitCache = (): void => {
  rateLimitStore.clear();
};
