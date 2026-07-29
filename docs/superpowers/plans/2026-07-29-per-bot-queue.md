# Per-Bot Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace global PQueue with per-bot queues (concurrency=1 per bot) to eliminate 429 collisions and improve rate-limit safety.

**Architecture:** Each bot token gets its own PQueue with concurrency=1. Uploads are assigned to the least-loaded available bot via `selectBot()`. On 429, the bot is marked rate-limited and the upload retries on the next available bot. The global `upload-queue.ts` is removed; `uploadConcurrency` config is replaced by `botCount * perBotConcurrency`.

**Tech Stack:** TypeScript, PQueue, Telegraf

## Global Constraints

- Use `Bun` runtime, not Node.js
- Follow existing code style (Biome lint)
- Each bot queue has concurrency=1 (no two uploads hit same bot simultaneously)
- `selectBot()` picks bot with lowest pending queue count, skipping rate-limited bots
- Remove `uploadConcurrency` from config; derive effective concurrency from bot count
- Remove `upload-queue.ts` entirely
- Remove `enqueueUpload` from `ITelegramService` interface

---
## File Structure

### Files to Modify
| File | Change |
|------|--------|
| `src/infrastructure/telegram/bot-pool.ts` | BotEntry array, selectBot(), per-bot queues, retry logic |
| `src/domain/ports/telegram-service.ts` | Remove `enqueueUpload` from interface |
| `src/env.ts` | Remove `uploadConcurrency` field |
| `src/index.ts` | Remove upload-queue import and usage |
| `src/utils/chunked-storage.ts` | Replace `config.uploadConcurrency` with bot count |

### Files to Delete
| File | Reason |
|------|--------|
| `src/infrastructure/telegram/upload-queue.ts` | Global queue replaced by per-bot queues |
| `test/telegramQueue.test.ts` | Tests for deleted module |

### Files Not Changed
| File | Reason |
|------|--------|
| `test/bot.test.ts` | Only uses ITelegramService interface (via `forwardToStorage`) |
| `src/infrastructure/telegram/chunked-storage.ts` | Uses ITelegramService interface, not BotPool directly |

---

### Task 1: Refresh the spec & plan files after compaction

Due to context compaction, re-read the current spec and plan files to ensure accuracy before implementing.

- [ ] **Step 1: Re-read the spec**

Read: `docs/superpowers/specs/2026-07-29-per-bot-queue-design.md`

- [ ] **Step 2: Re-read key implementation files**

Read: `src/infrastructure/telegram/bot-pool.ts`, `src/env.ts`, `src/utils/chunked-storage.ts`

### Task 2: Refactor ITelegramService interface

Remove `enqueueUpload` from the interface — BotPool handles queueing internally now.

**Files:**
- Modify: `src/domain/ports/telegram-service.ts`

- [ ] **Step 1: Remove `enqueueUpload` from interface**

```typescript
// src/domain/ports/telegram-service.ts — remove entire section:
  /**
   * Enqueue a task for sequential upload execution.
   *
   * Ensures only one Telegram upload runs at a time to avoid
   * rate limits and resource contention.
   *
   * @param task - An async function performing the upload.
   * @returns The result of the task.
   */
  enqueueUpload<T>(task: () => Promise<T>): Promise<T>;
```

- [ ] **Step 2: Run lint to verify**

Run: `bunx biome check src/domain/ports/telegram-service.ts`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/domain/ports/telegram-service.ts
git commit -m "refactor: remove enqueueUpload from ITelegramService

Per-bot queue handles queueing internally.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

### Task 3: Refactor BotPool with per-bot queues

The core of the redesign. Replace `claimBotIndex()` round-robin with per-bot PQueue instances and `selectBot()` for least-loaded assignment.

**Files:**
- Modify: `src/infrastructure/telegram/bot-pool.ts`

**Interfaces:**
- Consumes: `ITelegramService` (no `enqueueUpload` method)
- Produces: `botPool` singleton with per-bot queues, `selectBot()`, per-bot rate-limit tracking

- [ ] **Step 1: Write test file for per-bot queue behavior**

```typescript
// test/bot-pool.test.ts
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// We'll test the BotEntry queue behavior and selectBot logic
```

- [ ] **Step 2: Implement BotEntry type and BotPool refactor**

Replace the class body:

```typescript
import PQueue from 'p-queue';
import { Telegraf } from 'telegraf';
import type {
  ForwardResult,
  ITelegramService,
  TelegramFileInfo,
} from '../../domain/ports/telegram-service';
import { config } from '../../env';
import logger from '../../shared/logger/index';
import {
  buildSendPayload,
  extractUploadedFile,
  type SendMethod,
  sendMethodMap,
  type TelegramMessageResult,
} from './types';

const sleep = (ms: number): Promise<void> => 
  new Promise((resolve) => setTimeout(resolve, ms));

const isTransientError = (error: unknown): boolean => {
  const str = error instanceof Error ? error.message : String(error);
  const transientPatterns = [
    'timeout', 'Timed out', 'etimedout', 'econnrefused', 'econnreset',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '5xx', '502', '503', '504',
    'Bad Gateway', 'Service Unavailable', 'Gateway Timeout', 'socket hang up',
    'socket closed', 'fetch failed', 'network error', 'network timeout',
    'API closed', 'read ECONNRESET', 'write EPIPE',
  ];
  return transientPatterns.some((p) => str.toLowerCase().includes(p.toLowerCase()));
};

const MAX_TRANSIENT_RETRIES = 3;
const TELEGRAM_API_TIMEOUT_MS = 120_000;
const PER_BOT_CONCURRENCY = 1;

interface BotEntry {
  index: number;
  token: string;
  instance: Telegraf;
  queue: PQueue;
  rateLimitedUntil: number; // 0 = not rate-limited
}

export class BotPool implements ITelegramService {
  private readonly bots: BotEntry[] = [];

  constructor() {
    const tokens = Array.from(new Set([config.botToken, ...config.additionalBotTokens]));
    this.bots = tokens.map((token, index) => ({
      index,
      token,
      instance: new Telegraf(token),
      queue: new PQueue({ concurrency: PER_BOT_CONCURRENCY }),
      rateLimitedUntil: 0,
    }));
  }

  /** Number of bots in the pool */
  get size(): number {
    return this.bots.length;
  }

  /**
   * Select the bot with the fewest pending tasks that isn't rate-limited
   * or in the skip set.
   */
  private selectBot(skipIndexes?: Set<number>): BotEntry | null {
    let best: BotEntry | null = null;
    let bestPending = Infinity;

    for (const bot of this.bots) {
      if (skipIndexes?.has(bot.index)) continue;
      if (bot.rateLimitedUntil > Date.now()) continue;

      const pending = bot.queue.pending + bot.queue.size;
      if (pending < bestPending) {
        bestPending = pending;
        best = bot;
      }
    }

    return best;
  }

  /**
   * Execute a Telegram API action on a specific bot entry.
   * Wraps with timeout.
   */
  private async executeBotAction<T>(
    bot: BotEntry,
    action: (instance: Telegraf, token: string) => Promise<T>,
  ): Promise<T> {
    return Promise.race([
      action(bot.instance, bot.token),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Telegram API timeout after ${TELEGRAM_API_TIMEOUT_MS}ms`)),
          TELEGRAM_API_TIMEOUT_MS,
        ),
      ),
    ]);
  }

  /**
   * Forward a file chunk to the configured Telegram storage chat.
   *
   * The upload is submitted to the least-loaded bot's queue. If the bot
   * returns 429, it is marked rate-limited and the upload retries on the
   * next available bot. If all bots are rate-limited, sleeps before retrying.
   */
  async forwardToStorage(
    fileChunk: unknown,
    fileName: string,
    fileType: string,
  ): Promise<ForwardResult> {
    let lastError: unknown;
    const attemptedIndexes = new Set<number>();
    let transientAttempts = 0;

    // Outer retry loop — up to 10 attempts across all bots
    for (let attempt = 0; attempt < 10; attempt++) {
      const bot = this.selectBot(attemptedIndexes);

      if (!bot) {
        // No available bots — either all rate-limited or all attempted
        if (attemptedIndexes.size > 0) {
          // All non-rate-limited bots were tried and failed — wait & reset
          logger.warn('All available bots exhausted, sleeping 5s before retry');
          await sleep(5000 + Math.random() * 1000);
          attemptedIndexes.clear();
          continue;
        }
        // All bots rate-limited — wait for the shortest cooldown
        const earliestCooldown = Math.min(
          ...this.bots.map((b) => b.rateLimitedUntil || Infinity),
        );
        const waitMs = Math.max(1000, earliestCooldown - Date.now() + 500);
        logger.warn('All bots rate-limited, waiting', { waitMs });
        await sleep(waitMs);
        attemptedIndexes.clear();
        continue;
      }

      attemptedIndexes.add(bot.index);

      try {
        const result = await bot.queue.add(async () => {
          // Inner transient retry loop inside the queue
          for (let innerRetry = 0; innerRetry <= MAX_TRANSIENT_RETRIES; innerRetry++) {
            try {
              const filePayload = { source: fileChunk, filename: fileName };
              const sendMethodName = sendMethodMap[fileType] || 'sendDocument';
              const payload = buildSendPayload(fileType, fileName);

              const tgResult = await this.executeBotAction<TelegramMessageResult>(
                bot,
                (activeBot) => {
                  const telegram = activeBot.telegram as unknown as Record<string, SendMethod>;
                  return telegram[sendMethodName](config.storageChatId, filePayload, payload);
                },
              );

              const uploadedFile = extractUploadedFile(tgResult, fileType);
              return {
                telegramFileId: uploadedFile?.file_id || '',
                telegramFileUniqueId: uploadedFile?.file_unique_id || '',
                storageMessageId: tgResult.message_id,
              };
            } catch (error: unknown) {
              const errorStr = error instanceof Error ? error.message : String(error);
              const retryAfterMatch = errorStr.match(/retry after (\d+)/i);

              if (retryAfterMatch) {
                // 429 — mark bot rate-limited, throw to outer loop for retry on different bot
                const seconds = parseInt(retryAfterMatch[1], 10);
                bot.rateLimitedUntil = Date.now() + seconds * 1000;
                logger.info(`Bot #${bot.index} rate-limited for ${seconds}s`, { fileName, attempt });
                throw error; // caught by outer retry loop
              }

              if (innerRetry < MAX_TRANSIENT_RETRIES && isTransientError(error)) {
                const backoffMs = Math.min(1000 * 2 ** innerRetry, 10_000);
                logger.warn(
                  `Transient error on bot #${bot.index}, retrying (${innerRetry + 1}/${MAX_TRANSIENT_RETRIES})`,
                  { fileName, error: errorStr, backoffMs },
                );
                await sleep(backoffMs);
                continue;
              }

              throw error; // non-transient — propagate
            }
          }

          throw new Error(`Exhausted transient retries on bot #${bot.index}`);
        });

        logger.info('File forwarded to storage', { fileName, message: result.storageMessageId });
        return result;
      } catch (error: unknown) {
        lastError = error;
        const errorStr = error instanceof Error ? error.message : String(error);
        const retryAfterMatch = errorStr.match(/retry after (\d+)/i);

        if (retryAfterMatch) {
          // Bot was rate-limited — already marked, try next bot
          continue;
        }

        // Transient error at the queue level (timeout, 5xx)
        if (transientAttempts < MAX_TRANSIENT_RETRIES && isTransientError(error)) {
          transientAttempts++;
          continue;
        }

        // Non-transient — give up
        logger.error('Failed to forward file to storage', {
          fileName,
          error: errorStr,
          attempt,
        });
        throw error;
      }
    }

    throw lastError || new Error('Failed to forward file after all retries');
  }

  /** Get total effective concurrency across all bots */
  getEffectiveConcurrency(): number {
    return this.bots.length * PER_BOT_CONCURRENCY;
  }

  async getFileInfo(telegramFileId: string): Promise<TelegramFileInfo> {
    let lastError: unknown;
    for (const bot of this.bots) {
      for (let retry = 0; retry <= MAX_TRANSIENT_RETRIES; retry++) {
        try {
          const result = await bot.instance.telegram.getFile(telegramFileId);
          const fileData = result as unknown as Omit<TelegramFileInfo, 'bot_token'>;
          return {
            file_size: fileData.file_size || 0,
            mime_type: fileData.mime_type || 'application/octet-stream',
            file_path: fileData.file_path || '',
            bot_token: bot.token,
          };
        } catch (error: unknown) {
          lastError = error;
          const errorStr = error instanceof Error ? error.message : String(error);
          if (
            errorStr.includes('wrong file_id') ||
            errorStr.includes('file is temporarily unavailable')
          ) {
            break;
          }
          if (retry < MAX_TRANSIENT_RETRIES && isTransientError(error)) {
            const backoffMs = Math.min(1000 * 2 ** (retry + 1), 5_000);
            await sleep(backoffMs);
            continue;
          }
          break;
        }
      }
    }
    logger.error('Failed to get file info from any bot', {
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError;
  }
}

export const botPool = new BotPool();
```

- [ ] **Step 3: Run lint**

Run: `bunx biome check src/infrastructure/telegram/bot-pool.ts`
Expected: No errors.

- [ ] **Step 4: Run existing test suite**

Run: `bun test test/bot.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/telegram/bot-pool.ts
git commit -m "refactor: per-bot queue with selectBot() and rate-limit tracking

Each bot has its own PQueue (concurrency=1). Uploads are assigned to
the least-loaded available bot. On 429, the bot is marked rate-limited
and the upload retries on the next available bot.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

### Task 4: Remove global upload queue

Delete the global queue, its test, and all references to it from index.ts.

**Files:**
- Delete: `src/infrastructure/telegram/upload-queue.ts`
- Modify: `src/index.ts` (lines 4, 71-81)
- Delete: `test/telegramQueue.test.ts`

- [ ] **Step 1: Delete upload-queue.ts**

Run: `rm src/infrastructure/telegram/upload-queue.ts`

- [ ] **Step 2: Delete the test file**

Run: `rm test/telegramQueue.test.ts`

- [ ] **Step 3: Update index.ts — remove upload-queue import and shutdown drain logic**

Remove line:
```typescript
import { clearQueue, getQueueStats, waitForQueue } from './infrastructure/telegram/upload-queue';
```

Remove the drain block (lines 70-81):
```typescript
  // Drain pending upload queue with a timeout
  const { pending, size } = getQueueStats();
  if (pending > 0 || size > 0) {
    logger.info('Draining upload queue', { pending, size });
    const drainTimeout = setTimeout(() => {
      logger.warn('Upload queue drain timeout — clearing remaining tasks');
      clearQueue();
    }, 30_000);
    await waitForQueue();
    clearTimeout(drainTimeout);
    logger.info('Upload queue drained');
  }
```

- [ ] **Step 4: Run lint**

Run: `bunx biome check src/index.ts`
Expected: No errors.

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: All tests pass (some may be skipped due to missing queue test).

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/telegram/upload-queue.ts test/telegramQueue.test.ts src/index.ts
git commit -m "refactor: remove global upload queue

Per-bot queues now handle concontrol internally.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

### Task 5: Update env.ts and chunked-storage backpressure

Remove `uploadConcurrency` from config and update chunked-storage to derive effective concurrency from bot pool.

**Files:**
- Modify: `src/env.ts`
- Modify: `src/utils/chunked-storage.ts`

- [ ] **Step 1: Remove `uploadConcurrency` from env.ts**

Remove:
```typescript
  uploadConcurrency: number;
```
and:
```typescript
  uploadConcurrency: parseNumber(process.env.UPLOAD_CONCURRENCY, 8),
```

- [ ] **Step 2: Update chunked-storage.ts backpressure**

Replace:
```typescript
import { config } from '../env';
// ...
if (inFlight.size >= config.uploadConcurrency * 2) {
```
With:
```typescript
import { botPool } from '../infrastructure/telegram/bot-pool';
// ...
if (inFlight.size >= botPool.getEffectiveConcurrency()) {
```
(Use effective concurrency * 2 for backpressure, or just use effective concurrency as the limit.)

Actually let me think about this more carefully. The backpressure in chunked-storage:
```
if (inFlight.size >= config.uploadConcurrency * 2) {
  await Promise.race(inFlight);
  await new Promise((resolve) => setTimeout(resolve, 0));
}
```

This limits the number of in-flight chunks per file. With `uploadConcurrency: 16`, it was 32. Now with effective concurrency of 6 (6 bots), it would be 12. That's fine as backpressure — it prevents too many chunks from being in memory at once.

Let me use `botPool.getEffectiveConcurrency() * 2` to keep the same multiplier.

- [ ] **Step 3: Run lint and tests**

```bash
bunx biome check src/env.ts src/utils/chunked-storage.ts
bun test test/chunked-storage.test.ts
```

Expected: All checks pass.

- [ ] **Step 4: Commit**

```bash
git add src/env.ts src/utils/chunked-storage.ts
git commit -m "refactor: remove uploadConcurrency from config

Effective concurrency derived from bot pool size. Chunked-storage
backpressure now uses botPool.getEffectiveConcurrency().

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

### Task 6: Full integration test

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 2: Run lint**

Run: `bunx biome check src test`
Expected: No errors.

- [ ] **Step 3: Create summary commit**

```bash
git add -A
git commit -m "refactor: implement per-bot queue architecture

- Each bot has its own PQueue with concurrency=1
- selectBot() assigns uploads to least-loaded available bot
- 429 rate limits are tracked per-bot with cooldown timers
- Failed uploads retry on next available bot
- Removed global upload-queue.ts and uploadConcurrency config
- Updated ITelegramService interface

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
