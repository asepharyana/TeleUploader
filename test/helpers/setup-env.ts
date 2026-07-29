/**
 * Test environment setup — sets default env vars BEFORE any module is loaded.
 *
 * This prevents `src/env.ts` from throwing at import time when required
 * environment variables are absent.  Add this file as a `--preload` argument
 * to `bun test` calls in package.json.
 *
 * Only the 5 env vars that `src/env.ts` considers required are set here.
 * Optional vars (S3_SECRET_KEY, ADMIN_API_TOKEN, etc.) use their own
 * defaults in `src/env.ts` and are not touched.
 */

process.env.BOT_TOKEN ||= '123456:ABC-DEF';
process.env.STORAGE_CHANNEL_ID ||= '-1001234567890';
process.env.BASE_URL ||= 'https://example.com';
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.PORT ||= '3000';
process.env.NODE_ENV = 'test';

// Add mock additional bot tokens so multi-bot rotation logic is tested too
process.env.ADDITIONAL_BOT_TOKENS ||= '789012:GHI-JKL,345678:MNO-PQR';
