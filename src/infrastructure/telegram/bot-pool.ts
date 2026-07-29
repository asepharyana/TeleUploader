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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientError = (error: unknown): boolean => {
  const str = error instanceof Error ? error.message : String(error);
  const transientPatterns = [
    'timeout',
    'Timed out',
    'etimedout',
    'econnrefused',
    'econnreset',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    '5xx',
    '502',
    '503',
    '504',
    'Bad Gateway',
    'Service Unavailable',
    'Gateway Timeout',
    'socket hang up',
    'socket closed',
    'fetch failed',
    'network error',
    'network timeout',
    'API closed',
    'read ECONNRESET',
    'write EPIPE',
  ];
  return transientPatterns.some((p) => str.toLowerCase().includes(p.toLowerCase()));
};

const MAX_TRANSIENT_RETRIES = 3;
const MAX_OUTER_RETRIES = 10;
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
    const tokens = Array.from(new Set(config.botTokens));
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
    if (this.bots.length === 0) return null;

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

    // Outer retry loop — up to MAX_OUTER_RETRIES attempts across all bots
    for (let attempt = 0; attempt < MAX_OUTER_RETRIES; attempt++) {
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
        const earliestCooldown = Math.min(...this.bots.map((b) => b.rateLimitedUntil || Infinity));
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
                logger.info(`Bot #${bot.index} rate-limited for ${seconds}s`, {
                  fileName,
                  attempt,
                });
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
          // 429 catch in outer block: serves as a safety net for errors that
          // contain "retry after N" wording but were rethrown from the inner
          // queue task's fallback path (e.g., non-429 errors with similar text).
          logger.warn('Retry-after pattern caught in outer loop (safety net)', {
            fileName,
            error: errorStr,
          });
          continue;
        }

        // Transient error at the queue level — retry on next bot
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
            logger.warn(
              `Transient error getting file info, retrying bot ${bot.token.slice(0, 8)}... (${retry + 1}/${MAX_TRANSIENT_RETRIES})`,
              { telegramFileId, error: errorStr, backoffMs },
            );
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
