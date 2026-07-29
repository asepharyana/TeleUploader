# Per-Bot Queue: Rate-Limit Safe Telegram Upload

**Date:** 2026-07-29
**Status:** Approved Design

## Problem

Telegram Bot API rate-limits each bot to approximately 1-2 concurrent uploads. When multiple upload chunks hit the same bot simultaneously, Telegram returns HTTP 429 (Too Many Requests), causing delays of 30-60 seconds per retry. Under Docker push load, these cumulative delays trigger Gitea client timeouts and `500 Internal Server Error`.

The current architecture uses a **global PQueue** with `concurrency=N` where each task picks a bot via round-robin (`claimBotIndex()`). This means two concurrent tasks can both land on the same bot index (after wrap-around), causing 429 collisions.

## Solution: Per-Bot Queue

Each bot has its own PQueue with `concurrency=1`. Uploads are assigned to the bot with the fewest pending tasks. If a bot rate-limits, the upload moves to the next available bot.

### Architecture

```
┌────────────────────────────────────────────────────────┐
│                      BotPool                           │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ BotEntry[0]    token=b1  queue=PQueue(conc=1)    │  │
│  │                rateLimitedUntil=0                  │  │
│  ├──────────────────────────────────────────────────┤  │
│  │ BotEntry[1]    token=b2  queue=PQueue(conc=1)    │  │
│  │                rateLimitedUntil=0                  │  │
│  ├──────────────────────────────────────────────────┤  │
│  │ ... up to N bots                                   │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  selectBot(skip?): number                              │
│    └─ bot dengan pending queue paling sedikit           │
│       dan tidak sedang rate-limited                     │
│                                                        │
│  forwardToStorage(file): ForwardResult                 │
│    └─ retry loop: selectBot → queue.add → handle 429   │
└────────────────────────────────────────────────────────┘
```

### BotEntry Structure

```typescript
interface BotEntry {
  index: number;
  token: string;
  instance: Telegraf;
  queue: PQueue;            // concurrency: 1
  rateLimitedUntil: number;  // epoch ms, 0 = not limited
}
```

### Data Flow: Upload

```
forwardToStorage(fileChunk, fileName, fileType)
  │
  ├─ MAX_RETRIES loop (attempt up to all bots)
  │   │
  │   ├─ selectBot(attemptedIndexes)
  │   │   ├─ Filter out rate-limited bots (rateLimitedUntil > Date.now())
  │   │   ├─ Filter out already-attempted bots
  │   │   ├─ If none available:
  │   │   │   ├─ Wait MIN_SLEEP_MS (5000ms)
  │   │   │   ├─ Reset rate-limited timers (clear attemptedIndexes)
  │   │   │   └─ Retry selectBot
  │   │   └─ Return bot with smallest queue.pending count
  │   │
  │   ├─ attemptedIndexes.add(selectedBot)
  │   │
  │   ├─ result = await bots[selectedBot].queue.add(() =>
  │   │     executeTelegramCall(bot, fileChunk, fileName)
  │   │   )
  │   │   │
  │   │   ├─ ✅ Success → return ForwardResult
  │   │   │
  │   │   └─ ❌ Error
  │   │       ├─ 429 → markRateLimited(bot, retryAfter)
  │   │       │        → continue to next bot in retry loop
  │   │       ├─ Transient (timeout, 5xx) → continue
  │   │       └─ Non-transient → throw (propagate up)
  │   │
  │   └─ Attempt counter exhausted → throw lastError
  │
  └─ Sorted part tracking (for chunked uploads)
```

### Key Design Decisions

1. **Concurrency=1 per bot**: Guarantees no two Telegram API calls compete for the same bot token. With 6 bots, effective concurrency = 6.

2. **Least-loaded assignment**: `selectBot()` picks the bot with the fewest queued + pending tasks. This naturally load-balances even when some bots are slower.

3. **Rate-limit isolation**: When bot A hits 429, only bot A's queue is paused. Other 5 bots continue serving uploads uninterrupted.

4. **Per-bot rate-limit timer**: `rateLimitedUntil` prevents re-selecting a recently-429'd bot until its cooldown expires.

5. **No global PQueue**: The old `upload-queue.ts` is removed. Each bot owns its queue, eliminating the global backpressure problem.

### Changes by File

| File | Action |
|------|--------|
| `src/infrastructure/telegram/bot-pool.ts` | **Major refactor**: BotEntry array, selectBot(), per-bot queues, retry loop |
| `src/infrastructure/telegram/upload-queue.ts` | **Delete**: No longer needed |
| `src/domain/ports/telegram-service.ts` | **Remove** `enqueueUpload<T>(task: () => Promise<T>): Promise<T>` from interface |
| `src/utils/chunked-storage.ts` | **No changes** — only uses `forwardToStorage()` |
| `src/env.ts` | **Remove** `uploadConcurrency` config (no longer needed) |

### Error Handling

- **429 per bot**: Mark bot rate-limited, move to next. Clear timer after `retryAfter` seconds.
- **All bots 429**: Sleep 5 seconds with jitter, then retry from bot 0.
- **Transient errors** (timeout, 5xx, connection reset): Retry on same bot (inside its queue), then on next bot.
- **Non-transient errors** (4xx other than 429, wrong file_id, auth errors): Propagate immediately.
- **MAX_RETRIES**: 10 attempts across all bots before giving up.

### Testing

- Unit: `selectBot()` returns bot with fewest pending tasks
- Unit: `selectBot()` skips rate-limited bots
- Unit: 429 on bot 0 → retries on bot 1 → succeeds
- Unit: All bots rate-limited → sleeps → retries → succeeds
- Unit: Per-bot queue has concurrency=1 (two tasks to same bot queue sequentially)
- Integration: Forward a real file through the per-bot pool
