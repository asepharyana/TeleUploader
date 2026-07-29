import { config } from '../../../env';
import logger from '../../../shared/logger/index';
import { extractClientIp } from '../../../shared/utils/ip';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const MAX_STORE_ENTRIES = 50000;

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

const ensureStoreCapacity = (now: number): void => {
  if (rateLimitStore.size < MAX_STORE_ENTRIES) return;

  evictExpiredEntries(now);
  while (rateLimitStore.size >= MAX_STORE_ENTRIES) {
    const oldestKey = rateLimitStore.keys().next().value;
    if (!oldestKey) break;
    rateLimitStore.delete(oldestKey);
  }
};

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

export const withRateLimit = <T extends Request>(
  handler: (req: T) => Promise<Response>,
): ((req: T) => Promise<Response>) => {
  return async (req: T): Promise<Response> => {
    const ip = extractClientIp(req);
    if (!checkRateLimit(ip)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    return handler(req);
  };
};

export const cleanupRateLimitCache = (): void => {
  const cleaned = evictExpiredEntries();

  if (cleaned > 0) {
    logger.debug('Rate limit cache cleanup', { cleaned, remaining: rateLimitStore.size });
  }
};

export const getRateLimitStats = () => ({
  trackedIPs: rateLimitStore.size,
  windowSize: config.rateLimitWindowMs,
  maxRequests: config.rateLimitMaxRequests,
  maxTrackedIPs: MAX_STORE_ENTRIES,
});

export const clearRateLimitCache = (): void => {
  rateLimitStore.clear();
};
