import { nanoid } from 'nanoid';
import { type Context, Telegraf } from 'telegraf';
import { buildNewFile } from '../../domain/entities/file-factory';
import type { IFileRepository } from '../../domain/ports/file-repository';
import type { ITelegramService } from '../../domain/ports/telegram-service';
import { config } from '../../env';
import { DrizzleFileRepository } from '../../infrastructure/persistence/repositories/file-repository';
import { botPool } from '../../infrastructure/telegram/bot-pool';
import logger from '../../shared/logger/index';
import {
  checkFileSize,
  detectFileType,
  extractFileFromMessage,
  getErrorMessage,
  getFileSizeLimit,
  type TelegramMediaMessage,
} from '../../shared/utils/file';

/**
 * Minimal bot context shape used by the media event handler.
 *
 * Represents the subset of Telegraf's Context that the handler requires
 * for processing incoming media messages.
 */
type BotContext = {
  /** The incoming media message with file attachments. */
  message: TelegramMediaMessage;
  /** The sender of the message. */
  from: { id: number };
  /** The chat where the message was sent, if available. */
  chat?: { id: number };
  /**
   * Reply to the message with text.
   *
   * @param text - The reply text.
   * @param extra - Optional reply parameters (e.g. reply_parameters for threading).
   */
  reply: (text: string, extra?: { reply_parameters: { message_id: number } }) => Promise<unknown>;
};

/**
 * Duck-typed object that exposes a Telegraf-style `on()` method
 * for registering event handlers on multiple event types.
 */
type MediaEventRegistrar = {
  /**
   * Register a handler for the given event types.
   *
   * @param events - Array of event type strings (e.g. "document", "photo").
   * @param handler - Async handler receiving the bot context.
   */
  on: (events: string[], handler: (ctx: BotContext) => Promise<unknown>) => void;
};

/**
 * Replies to a Telegram message with a download URL for the uploaded file.
 *
 * @param ctx - The bot context for the incoming message.
 * @param publicId - The public identifier of the uploaded file.
 */
const replyWithDownloadUrl = async (ctx: BotContext, publicId: string): Promise<void> => {
  const url = `${config.baseUrl}/f/${publicId}`;
  await ctx.reply(`File berhasil diupload! 📎\n\nDownload: ${url}`, {
    reply_parameters: { message_id: ctx.message.message_id },
  });
};

/**
 * Start the Telegram bot and register message handlers.
 *
 * Creates a Telegraf instance, registers a `/start` command handler,
 * logging middleware, and media event handlers for all supported file types.
 * Incoming media files are deduplicated by their Telegram unique ID,
 * forwarded to the storage channel, and persisted with a public download URL.
 *
 * @param deps - Optional external dependencies for testing or DI override.
 * @param deps.telegramService - The Telegram service used to forward files to
 *   the storage channel. Defaults to the singleton BotPool instance.
 * @param deps.fileRepo - The file repository used for deduplication queries
 *   and persisting new file records. Defaults to a new DrizzleFileRepository.
 * @returns The launched Telegraf bot instance, suitable for graceful shutdown
 *   via `bot.stop(signal)`.
 */
export async function startBot(
  deps: {
    /** The Telegram service to forward files to storage. */
    telegramService?: ITelegramService;
    /** The file repository for deduplication and persistence. */
    fileRepo?: IFileRepository;
  } = {},
): Promise<Telegraf<Context>> {
  const telegramService = deps.telegramService ?? botPool;
  const fileRepo = deps.fileRepo ?? new DrizzleFileRepository();

  try {
    const bot = new Telegraf(config.botTokens[0]);

    bot.command('start', async (ctx) => {
      await ctx.reply(
        `👋 Halo! Kirimkan file (document, photo, video, audio, voice, animation) ke bot ini. ` +
          `File akan disimpan di private channel dan kamu dapat download link permanen.`,
      );
    });

    // Logging middleware must be registered BEFORE the media handler so all events are captured
    bot.use((ctx, next) => {
      logger.info('Telegram event received', {
        type: 'type' in ctx.update ? ctx.update.type : undefined,
        chat_id: ctx.chat?.id,
      });
      return next();
    });

    const mediaBot = bot as unknown as MediaEventRegistrar;
    mediaBot.on(
      ['document', 'photo', 'video', 'audio', 'voice', 'animation', 'sticker', 'video_note'],
      async (ctx) => {
        try {
          const fileType = detectFileType(ctx.message);
          const fileObj = extractFileFromMessage(ctx.message, fileType);
          const { file_id, mime_type } = fileObj;
          const fileSize = fileObj.file_size || 0;
          const fileName =
            ctx.message.document?.file_name ||
            ctx.message.photo?.slice(-1)[0]?.file_name ||
            ctx.message.video?.file_name ||
            ctx.message.audio?.file_name ||
            ctx.message.voice?.file_name ||
            'file';

          if (!checkFileSize(fileSize, fileType)) {
            return ctx.reply(
              `File size exceeds ${getFileSizeLimit(fileType) / (1024 * 1024)}MB limit`,
            );
          }

          const existing = await fileRepo.findByUniqueId(fileObj.file_unique_id);

          if (existing) {
            await replyWithDownloadUrl(ctx, existing.publicId);
            logger.info('Duplicate file detected in bot, returned existing link', {
              publicId: existing.publicId,
              fileType,
              fileName,
              uploader: ctx.from.id,
            });
            return;
          }

          const result = await telegramService.forwardToStorage(file_id, fileName, fileType);
          const publicId = nanoid();

          await fileRepo.create(
            buildNewFile({
              publicId,
              telegramFileId: result.telegramFileId,
              telegramFileUniqueId: result.telegramFileUniqueId,
              storageChatId: config.storageChatId,
              storageMessageId: result.storageMessageId,
              fileName,
              mimeType: mime_type || 'application/octet-stream',
              sizeBytes: fileSize,
              fileType,
              uploaderId: ctx.from.id,
              storageBackend: 'telegram',
            }),
          );

          await replyWithDownloadUrl(ctx, publicId);

          logger.info('File uploaded via bot', {
            publicId,
            fileType,
            fileName,
            uploader: ctx.from.id,
          });
        } catch (error: unknown) {
          logger.error('Bot file handler error', {
            error: getErrorMessage(error),
            chat_id: ctx.chat?.id,
          });
          await ctx.reply('❌ Gagal mengupload file. Coba lagi nanti.');
        }
      },
    );

    await bot.launch();

    logger.info('Telegram bot started', {
      botToken: `${config.botTokens[0]?.substring(0, 10)}...`,
    });

    return bot;
  } catch (error: unknown) {
    logger.error('Failed to start bot', { error: getErrorMessage(error) });
    throw error;
  }
}
