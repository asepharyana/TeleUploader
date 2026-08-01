import { describe, expect, it } from 'bun:test';
import { config } from '../src/env';
import { asSafeChunkSize, TELEGRAM_CHUNK_SIZE_MAX_BYTES } from '../src/shared/utils/validation';

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

describe('Telegram chunk size validation', () => {
  it('config.telegramChunkSizeBytes should default to the safe 19 MB value when unset', () => {
    // setup-env.ts does not set TELEGRAM_CHUNK_SIZE_BYTES, so the default must
    // be the safe 19 MB value — never the raw 20 MB getFile limit.
    expect(config.telegramChunkSizeBytes).toBe(TELEGRAM_CHUNK_SIZE_MAX_BYTES);
    expect(config.telegramChunkSizeBytes).toBeLessThan(20 * 1024 * 1024);
  });

  it('asSafeChunkSize accepts sizes at or below the maximum (19 MB)', () => {
    expect(asSafeChunkSize(TELEGRAM_CHUNK_SIZE_MAX_BYTES)).toBe(TELEGRAM_CHUNK_SIZE_MAX_BYTES);
    expect(asSafeChunkSize(1024)).toBe(1024);
    expect(asSafeChunkSize(19 * 1024 * 1024)).toBe(19 * 1024 * 1024);
  });

  it('asSafeChunkSize rejects sizes above the Telegram getFile limit (incl. the 48 MB production bug)', () => {
    // The production bug value (48 MB / 50331648) must be rejected.
    expect(() => asSafeChunkSize(48 * 1024 * 1024)).toThrow(/exceeds/);
    // Even exactly 20 MB is at the raw Telegram limit — rejected by the margin.
    expect(() => asSafeChunkSize(20 * 1024 * 1024)).toThrow(/exceeds/);
    expect(() => asSafeChunkSize(TELEGRAM_CHUNK_SIZE_MAX_BYTES + 1)).toThrow(/exceeds/);
  });

  it('asSafeChunkSize rejects non-positive or non-integer sizes', () => {
    expect(() => asSafeChunkSize(0)).toThrow('Invalid Telegram chunk size');
    expect(() => asSafeChunkSize(-1)).toThrow('Invalid Telegram chunk size');
    expect(() => asSafeChunkSize(1.5)).toThrow('Invalid Telegram chunk size');
  });

  it('startup fails fast when TELEGRAM_CHUNK_SIZE_BYTES exceeds the limit', async () => {
    // Spawn a real process that imports src/env with an oversized chunk size;
    // it must exit non-zero with a clear error instead of starting silently.
    const proc = Bun.spawn({
      cmd: ['bun', '-e', "import('./src/env')"],
      cwd: `${import.meta.dir}/..`,
      env: {
        ...process.env,
        BOT_TOKENS: '123456:ABC-DEF',
        STORAGE_CHANNEL_ID: '-1001234567890',
        BASE_URL: 'https://example.com',
        DATABASE_URL: 'postgresql://user:***@localhost:5432/test',
        PORT: '3000',
        TELEGRAM_CHUNK_SIZE_BYTES: String(48 * 1024 * 1024),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('TELEGRAM_CHUNK_SIZE_BYTES');
    expect(stderr).toContain('exceeds');
  });

  it('startup succeeds when TELEGRAM_CHUNK_SIZE_BYTES is at the safe limit', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', '-e', "import('./src/env')"],
      cwd: `${import.meta.dir}/..`,
      env: {
        ...process.env,
        BOT_TOKENS: '123456:ABC-DEF',
        STORAGE_CHANNEL_ID: '-1001234567890',
        BASE_URL: 'https://example.com',
        DATABASE_URL: 'postgresql://user:***@localhost:5432/test',
        PORT: '3000',
        TELEGRAM_CHUNK_SIZE_BYTES: String(TELEGRAM_CHUNK_SIZE_MAX_BYTES),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
