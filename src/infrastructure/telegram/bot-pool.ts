import { Telegraf } from 'telegraf';
import { config } from '../../env';
import logger from '../../shared/logger/index';
import type { ITelegramService, ForwardResult, TelegramFileInfo } from '../../domain/ports/telegram-service';
import { enqueueUpload } from './upload-queue';
import {
  sendMethodMap,
  extractUploadedFile,
  buildSendPayload,
  type TelegramMessageResult,
  type SendMethod,
} from './types';

/**
 * Sleep for a given number of seconds.
 *
 * Used as a backoff mechanism when all bots in the pool are rate-limited.
 *
 * @param seconds - Number of seconds to sleep.
 * @returns A promise that resolves after the specified delay.
 */
const sleep = (seconds: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

/**
 * Manages a pool of Telegram bots with automatic rotation and rate-limit handling.
 *
 * Distributes uploads across multiple bot tokens to maximise throughput.
 * When a bot receives a 429 (rate-limit) error, the pool instantly rotates
 * to the next available bot. If all bots are rate-limited, a coordinated
 * sleep is performed before retrying.
 *
 * Implements the {@link ITelegramService} contract.
 */
export class BotPool implements ITelegramService {
  private readonly bots: Telegraf[];
  private readonly botTokens: string[];
  private nextBotIndex = 0;

  /** Create a new BotPool from the application configuration. */
  constructor() {
    this.botTokens = Array.from(new Set([config.botToken, ...config.additionalBotTokens]));
    this.bots = this.botTokens.map((token) => new Telegraf(token));
  }

  /**
   * Claim the next bot index using round-robin rotation.
   *
   * @returns The index of the selected bot.
   */
  private claimBotIndex(): number {
    const botIndex = this.nextBotIndex;
    this.nextBotIndex = (this.nextBotIndex + 1) % this.bots.length;
    return botIndex;
  }

  /**
   * Execute a Telegram API action with automatic retry and bot rotation.
   *
   * On 429 errors the pool either:
   * 1. Rotates to the next bot immediately (if another bot is available), or
   * 2. Sleeps for the required duration after all bots are exhausted, then retries.
   *
   * @param action - The action to execute on a bot instance.
   * @param retries - Number of full-pool retry cycles remaining.
   * @param attemptedBots - Number of bots attempted in the current cycle.
   * @returns The result of the action.
   */
  private async executeWithBotRetry<T>(
    action: (botInstance: Telegraf, botToken: string) => Promise<T>,
    retries = 5,
    attemptedBots = 0,
  ): Promise<T> {
    const botIndex = this.claimBotIndex();
    const currentBot = this.bots[botIndex];
    const currentToken = this.botTokens[botIndex];
    try {
      return await action(currentBot, currentToken);
    } catch (error: unknown) {
      const errorStr = error instanceof Error ? error.message : String(error);
      const match = errorStr.match(/retry after (\d+)/i);

      if (match) {
        const nextIndex = this.nextBotIndex;
        const nextAttemptedBots = attemptedBots + 1;

        if (nextAttemptedBots < this.bots.length) {
          logger.info(
            `Bot Index ${botIndex} hit 429. Instantly rotating to Bot Index ${nextIndex}...`,
          );
          return this.executeWithBotRetry(action, retries, nextAttemptedBots);
        }

        if (retries > 0) {
          const seconds = parseInt(match[1], 10);
          logger.warn(
            `All bots in the pool are rate-limited. Sleeping for ${seconds} seconds...`,
            { error: errorStr },
          );
          await sleep(seconds);
          return this.executeWithBotRetry(action, retries - 1, 0);
        }
      }
      throw error;
    }
  }

  /**
   * Forward a file chunk to the configured Telegram storage chat.
   *
   * The upload is queued (via {@link enqueueUpload}) and executed with
   * automatic bot rotation on rate-limit errors.
   *
   * @param fileChunk - The file data (ReadStream, Buffer, or file path).
   * @param fileName - The original file name.
   * @param fileType - The file type classification (e.g. "document", "photo").
   * @returns The Telegram identifiers of the stored file.
   */
  async forwardToStorage(
    fileChunk: unknown,
    fileName: string,
    fileType: string,
  ): Promise<ForwardResult> {
    try {
      const result = await this.enqueueUpload<TelegramMessageResult>(async () => {
        const filePayload = { source: fileChunk, filename: fileName };
        const sendMethodName = sendMethodMap[fileType] || 'sendDocument';
        const payload = buildSendPayload(fileType, fileName);

        return this.executeWithBotRetry<TelegramMessageResult>((activeBot) => {
          const telegram = activeBot.telegram as unknown as Record<string, SendMethod>;
          return telegram[sendMethodName](config.storageChatId, filePayload, payload);
        });
      });

      const uploadedFile = extractUploadedFile(result, fileType);
      logger.info('File forwarded to storage', { fileName, message: result.message_id });

      return {
        telegramFileId: uploadedFile?.file_id || '',
        telegramFileUniqueId: uploadedFile?.file_unique_id || '',
        storageMessageId: result.message_id,
      };
    } catch (error: unknown) {
      logger.error('Failed to forward file to storage', {
        fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Retrieve file metadata from Telegram by file ID.
   *
   * Tries all configured bots sequentially; returns info from the first
   * bot that can retrieve the file. Errors indicating the file belongs
   * to a different bot are silently skipped.
   *
   * @param telegramFileId - The Telegram file_id to look up.
   * @returns Metadata including size, MIME type, download path, and bot token.
   */
  async getFileInfo(telegramFileId: string): Promise<TelegramFileInfo> {
    let lastError: unknown;
    for (const activeBot of this.bots) {
      try {
        const result = await activeBot.telegram.getFile(telegramFileId);
        const fileData = result as unknown as Omit<TelegramFileInfo, 'bot_token'>;
        return {
          file_size: fileData.file_size || 0,
          mime_type: fileData.mime_type || 'application/octet-stream',
          file_path: fileData.file_path || '',
          bot_token: activeBot.telegram.token,
        };
      } catch (error: unknown) {
        lastError = error;
        const errorStr = error instanceof Error ? error.message : String(error);
        if (
          errorStr.includes('wrong file_id') ||
          errorStr.includes('file is temporarily unavailable') ||
          errorStr.includes('retry after')
        ) {
          continue;
        }
        throw error;
      }
    }

    logger.error('Failed to get file info from any bot', {
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError;
  }

  /**
   * Enqueue a task for sequential upload execution.
   *
   * Delegates to the shared upload queue to ensure only a limited number
   * of Telegram uploads run concurrently.
   *
   * @param task - An async function performing the upload.
   * @returns The result of the task.
   */
  enqueueUpload<T>(task: () => Promise<T>): Promise<T> {
    return enqueueUpload(task);
  }
}

/**
 * Singleton BotPool instance initialised from application configuration.
 */
export const botPool = new BotPool();
