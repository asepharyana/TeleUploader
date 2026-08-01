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

process.env.BOT_TOKENS ||= '123456:ABC-DEF,789012:GHI-JKL,345678:MNO-PQR';
process.env.STORAGE_CHANNEL_ID ||= '-1001234567890';
process.env.BASE_URL ||= 'https://example.com';
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.PORT ||= '3000';
process.env.NODE_ENV = 'test';

// Pin the chunk size to the safe 19 MB value UNCONDITIONALLY. Bun auto-loads
// the repo .env before preloads run, and a stale oversized value there would
// trip the fail-fast guard in src/env.ts and break every test file's import.
// Tests that need a different value set it explicitly in their own process.
process.env.TELEGRAM_CHUNK_SIZE_BYTES = String(19 * 1024 * 1024);

// Keep old env names for backward compat with tests that reference them directly
