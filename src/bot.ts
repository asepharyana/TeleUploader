import { nanoid } from 'nanoid';
import { type Context, Telegraf } from 'telegraf';
import { db, files as fileSchema } from './db';
import { findFileByUniqueId } from './db/files';
import { config } from './env';
import {
  detectFileType,
  extractFileFromMessage,
  getErrorMessage,
  getFileSizeLimit,
  type TelegramMediaMessage,
} from './utils/file';
import logger from './utils/logger';
import { forwardToStorage } from './utils/telegram';

type BotContext = {
  message: TelegramMediaMessage;
  from: { id: number };
  chat?: { id: number };
  reply: (text: string, extra?: { reply_parameters: { message_id: number } }) => Promise<unknown>;
};

type MediaEventRegistrar = {
  on: (events: string[], handler: (ctx: BotContext) => Promise<unknown>) => void;
};

const replyWithDownloadUrl = async (ctx: BotContext, publicId: string): Promise<void> => {
  const url = `${config.baseUrl}/f/${publicId}`;
  await ctx.reply(`File berhasil diupload! 📎\n\nDownload: ${url}`, {
    reply_parameters: { message_id: ctx.message.message_id },
  });
};

export const startBot = async (): Promise<Telegraf<Context>> => {
  try {
    const bot = new Telegraf(config.botToken);

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

          const maxSize = getFileSizeLimit(fileType);

          if (fileSize > maxSize) {
            return ctx.reply(`File size exceeds ${maxSize / (1024 * 1024)}MB limit`);
          }

          const existing = await findFileByUniqueId(fileObj.file_unique_id);

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

          const result = await forwardToStorage(file_id, fileName, fileType);
          const publicId = nanoid();

          const uploaded = {
            publicId: publicId,
            telegramFileId: result.telegramFileId,
            telegramFileUniqueId: result.telegramFileUniqueId,
            storageChatId: config.storageChatId,
            storageMessageId: result.storageMessageId,
            fileName: fileName,
            mimeType: mime_type || 'application/octet-stream',
            sizeBytes: fileSize,
            fileType: fileType,
            uploaderId: ctx.from.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          await db.insert(fileSchema).values(uploaded);

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

    logger.info('Telegram bot started', { botToken: `${config.botToken?.substring(0, 10)}...` });

    return bot;
  } catch (error: unknown) {
    logger.error('Failed to start bot', { error: getErrorMessage(error) });
    throw error;
  }
};
