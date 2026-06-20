import { Telegraf } from 'telegraf';
import { config } from '../env';
import logger from './logger';
import { enqueueUpload } from './telegramQueue';

const botTokens = Array.from(new Set([config.botToken, ...config.additionalBotTokens]));

type FileInfoResult = {
  result: unknown;
  botToken: string;
};

const bots = botTokens.map((token) => new Telegraf(token));

let nextBotIndex = 0;

const claimBotIndex = (): number => {
  const botIndex = nextBotIndex;
  nextBotIndex = (nextBotIndex + 1) % bots.length;
  return botIndex;
};

const sleep = (seconds: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

const executeWithBotRetry = async <T>(
  action: (botInstance: Telegraf, botToken: string) => Promise<T>,
  retries = 5,
  attemptedBots = 0,
): Promise<T> => {
  const botIndex = claimBotIndex();
  const currentBot = bots[botIndex];
  const currentToken = botTokens[botIndex];
  try {
    return await action(currentBot, currentToken);
  } catch (error: unknown) {
    const errorStr = error instanceof Error ? error.message : String(error);
    const match = errorStr.match(/retry after (\d+)/i);

    if (match) {
      const nextIndex = nextBotIndex;
      const nextAttemptedBots = attemptedBots + 1;

      if (nextAttemptedBots < bots.length) {
        logger.info(
          `Bot Index ${botIndex} hit 429. Instantly rotating to Bot Index ${nextIndex}...`,
        );
        return executeWithBotRetry(action, retries, nextAttemptedBots);
      }

      if (retries > 0) {
        const seconds = parseInt(match[1], 10);
        logger.warn(`All bots in the pool are rate-limited. Sleeping for ${seconds} seconds...`, {
          error: errorStr,
        });
        await sleep(seconds);
        return executeWithBotRetry(action, retries - 1, 0);
      }
    }
    throw error;
  }
};

interface ForwardResult {
  telegramFileId: string;
  telegramFileUniqueId: string;
  storageMessageId: number;
}

export interface TelegramFileInfo {
  file_size: number;
  mime_type: string;
  file_path: string;
  bot_token: string;
}

interface UploadedTelegramFile {
  file_id?: string;
  file_unique_id?: string;
}

interface TelegramMessageResult {
  message_id: number;
  document?: UploadedTelegramFile;
  photo?: UploadedTelegramFile[];
  video?: UploadedTelegramFile;
  audio?: UploadedTelegramFile;
  voice?: UploadedTelegramFile;
  animation?: UploadedTelegramFile;
  sticker?: UploadedTelegramFile;
  video_note?: UploadedTelegramFile;
  [key: string]: unknown;
}

type FilePayload = { source: unknown; filename: string };
type SendPayload = { caption?: string };
type SendMethod = (
  chatId: number,
  filePayload: FilePayload,
  payload?: SendPayload,
) => Promise<TelegramMessageResult>;

const sendMethodMap: Record<string, string> = {
  photo: 'sendPhoto',
  audio: 'sendAudio',
  video: 'sendVideo',
  voice: 'sendVoice',
  animation: 'sendAnimation',
  sticker: 'sendSticker',
  document: 'sendDocument',
  video_note: 'sendDocument',
};

const extractUploadedFile = (
  result: TelegramMessageResult,
  fileType: string,
): UploadedTelegramFile | undefined => {
  if (result.document) return result.document;
  if (result.photo) return result.photo?.slice(-1)[0];
  if (result.video) return result.video;
  if (result.audio) return result.audio;
  if (result.voice) return result.voice;
  if (result.animation) return result.animation;
  if (result.sticker) return result.sticker;
  if (result.video_note) return result.video_note;
  return result[fileType] as UploadedTelegramFile | undefined;
};

const buildSendPayload = (fileType: string, fileName: string): SendPayload => {
  const basePayload = { caption: fileName };
  if (fileType === 'sticker') return {};
  if (fileType === 'document') return { caption: `📁 ${fileName}` };
  return basePayload;
};

const getMediaGroupType = (fileType: string): string => {
  if (fileType === 'photo') return 'photo';
  if (fileType === 'video') return 'video';
  if (fileType === 'audio') return 'audio';
  return 'document';
};

interface MediaGroupPayloadItem {
  type: string;
  media: string;
  caption: string;
}

const buildMediaGroup = (items: MediaGroupItem[]): MediaGroupPayloadItem[] => {
  return items.map((item) => ({
    type: getMediaGroupType(item.fileType),
    media: item.fileId,
    caption: item.fileName,
  }));
};

export const forwardToStorage = async (
  fileChunk: unknown,
  fileName: string,
  fileType: string,
): Promise<ForwardResult> => {
  try {
    const result = await enqueueUpload(async (): Promise<TelegramMessageResult> => {
      const filePayload = { source: fileChunk, filename: fileName };
      const sendMethod = sendMethodMap[fileType] || 'sendDocument';
      const payload = buildSendPayload(fileType, fileName);

      return executeWithBotRetry((activeBot) => {
        const telegram = activeBot.telegram as unknown as Record<string, SendMethod>;
        return telegram[sendMethod](config.storageChatId, filePayload, payload);
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
};

export interface MediaGroupItem {
  fileId: string;
  fileName: string;
  fileType: string;
}

export const forwardMediaGroupToStorage = async (
  items: MediaGroupItem[],
): Promise<{
  storageMessageId: number;
  telegramFileIds: string[];
  telegramFileUniqueIds: string[];
}> => {
  try {
    const result = await enqueueUpload(async (): Promise<TelegramMessageResult[]> => {
      const mediaGroup = buildMediaGroup(items);

      return executeWithBotRetry((activeBot) => {
        const sendMediaGroup = activeBot.telegram.sendMediaGroup as unknown as (
          chatId: number,
          media: MediaGroupPayloadItem[],
        ) => Promise<TelegramMessageResult[]>;
        return sendMediaGroup(config.storageChatId, mediaGroup);
      });
    });

    const messages = Array.isArray(result) ? result : [result];
    const storageMessageId = messages[0]?.message_id || 0;

    const telegramFileIds: string[] = [];
    const telegramFileUniqueIds: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      const uploadedFile = extractUploadedFile(messages[i], items[i]?.fileType || 'document');
      telegramFileIds.push(uploadedFile?.file_id || '');
      telegramFileUniqueIds.push(uploadedFile?.file_unique_id || '');
    }

    return {
      storageMessageId,
      telegramFileIds,
      telegramFileUniqueIds,
    };
  } catch (error: unknown) {
    logger.error('Failed to forward media group to storage', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const getFileInfo = async (telegramFileId: string): Promise<TelegramFileInfo> => {
  let lastError: unknown;
  for (const activeBot of bots) {
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
};

export const getBot = (): Telegraf => bots[nextBotIndex];

export const getCurrentBotIndex = (): number => nextBotIndex;
