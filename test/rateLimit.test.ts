import { beforeEach, describe, expect, it } from 'bun:test';
import { config } from '../src/env';
import {
  checkRateLimit,
  cleanupRateLimitCache,
  clearRateLimitCache,
} from '../src/interfaces/http/middleware/rate-limit';

describe('Rate Limiter', () => {
  beforeEach(() => {
    clearRateLimitCache();
  });

  it('should allow requests up to the configured limit then block', () => {
    const key = 'user-1';
    const limit = config.rateLimitMaxRequests;

    for (let i = 0; i < limit; i++) {
      expect(checkRateLimit(key)).toBe(true);
    }

    expect(checkRateLimit(key)).toBe(false);
  });

  it('should track different IPs independently', () => {
    expect(checkRateLimit('10.0.0.1')).toBe(true);
    expect(checkRateLimit('10.0.0.1')).toBe(true);
    expect(checkRateLimit('10.0.0.2')).toBe(true);
  });

  it('should no-op on cleanup of active entries', () => {
    checkRateLimit('user-3');
    expect(() => cleanupRateLimitCache()).not.toThrow();
  });
});
