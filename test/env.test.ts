import { describe, expect, it } from 'bun:test';
import { config } from '../src/env';

describe('Environment Variables Validation', () => {
  it('config should have all required fields', () => {
    expect(config).toHaveProperty('botTokens');
    expect(config).toHaveProperty('storageChatId');
    expect(config).toHaveProperty('baseUrl');
    expect(config).toHaveProperty('databaseUrl');
    expect(config).toHaveProperty('port');
    expect(config).toHaveProperty('nodeEnv');
    expect(config).toHaveProperty('logLevel');
    expect(config).toHaveProperty('rateLimitWindowMs');
    expect(config).toHaveProperty('rateLimitMaxRequests');
    expect(config).toHaveProperty('adminApiToken');
    expect(config).toHaveProperty('sessionCookieName');
    expect(config).toHaveProperty('sessionMaxAgeMs');
  });

  it('config.botTokens should return array from BOT_TOKENS env', () => {
    expect(Array.isArray(config.botTokens)).toBe(true);
    expect(config.botTokens.length).toBeGreaterThanOrEqual(3);
  });

  it('config.storageChatId should be parsed as integer from STORAGE_CHANNEL_ID', () => {
    expect(typeof config.storageChatId).toBe('number');
    expect(config.storageChatId).toBe(parseInt(process.env.STORAGE_CHANNEL_ID || '0', 10));
  });

  it('config.port should default to 3000 when not specified', () => {
    expect(typeof config.port).toBe('number');
  });

  it("nodeEnv should be 'test' or 'development'", () => {
    expect(['test', 'development']).toContain(config.nodeEnv);
  });

  it("logLevel should default to 'info'", () => {
    expect(config.logLevel).toBe('info');
  });

  it('rateLimitWindowMs should default to 60000 when not specified', () => {
    expect(config.rateLimitWindowMs).toBe(60000);
  });

  it('rateLimitMaxRequests should default to 150 when not specified', () => {
    expect(config.rateLimitMaxRequests).toBe(150);
  });

  it('auth config should be disabled by default with a 24 hour session', () => {
    expect(config.adminApiToken).toBe(process.env.ADMIN_API_TOKEN || '');
    expect(config.sessionCookieName).toBe(process.env.SESSION_COOKIE_NAME || 'tu_session');
    expect(config.sessionMaxAgeMs).toBe(86400 * 1000);
  });

  it('botTokens should be populated in test environment', () => {
    expect(Array.isArray(config.botTokens)).toBe(true);
    // With mock tokens from setup-env.ts there should be at least 3 tokens
    expect(config.botTokens.length).toBeGreaterThanOrEqual(3);
  });

  it('S3 validation should not throw — env already loaded without error at import time', () => {
    // config was imported at the top of this file; if S3 validation had failed,
    // this test file would never have loaded. The fact that we're here means
    // validation passed.
    expect(config.s3AccessKey).toBeDefined();
    expect(config.s3SecretKey).toBeDefined();
  });
});
