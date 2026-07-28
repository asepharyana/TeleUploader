/**
 * Telegram-specific types used internally by the infrastructure layer.
 *
 * These types represent the raw Telegram Bot API response shapes and
 * the internal abstractions built on top of them. The higher-level domain
 * types (ForwardResult, TelegramFileInfo) are defined in
 * src/domain/ports/telegram-service.ts.
 */

/**
 * File reference within a Telegram message result.
 * Contains identifiers returned by the Telegram API for uploaded media.
 */
export interface UploadedTelegramFile {
  /** Telegram file_id for retrieving the file */
  file_id?: string;
  /** Telegram unique file_id (stable across bot tokens) */
  file_unique_id?: string;
}

/**
 * Result structure returned by Telegram send* API methods.
 * Covers all media types a Telegram message can carry.
 */
export interface TelegramMessageResult {
  /** Unique message identifier inside the chat */
  message_id: number;
  /** Sent document, if applicable */
  document?: UploadedTelegramFile;
  /** Sent photo (array of sizes, last element is largest), if applicable */
  photo?: UploadedTelegramFile[];
  /** Sent video, if applicable */
  video?: UploadedTelegramFile;
  /** Sent audio, if applicable */
  audio?: UploadedTelegramFile;
  /** Sent voice message, if applicable */
  voice?: UploadedTelegramFile;
  /** Sent animation (GIF), if applicable */
  animation?: UploadedTelegramFile;
  /** Sent sticker, if applicable */
  sticker?: UploadedTelegramFile;
  /** Sent video note, if applicable */
  video_note?: UploadedTelegramFile;
  /** Catch-all for any additional Telegram response fields */
  [key: string]: unknown;
}

/**
 * Payload structure for sending a file via the Telegram Bot API.
 *
 * @internal
 */
export type FilePayload = { source: unknown; filename: string };

/**
 * Additional optional payload for Telegram send method calls.
 *
 * @internal
 */
export type SendPayload = { caption?: string };

/**
 * Function signature for Telegram send* method calls on a bot instance.
 *
 * @internal
 */
export type SendMethod = (
  chatId: number,
  filePayload: FilePayload,
  payload?: SendPayload,
) => Promise<TelegramMessageResult>;

/**
 * Mapping from file type identifier to Telegram Bot API method name.
 *
 * Each key corresponds to a Telegram media type; the value is the
 * method name to call on `bot.telegram`.
 */
export const sendMethodMap: Record<string, string> = {
  photo: 'sendPhoto',
  audio: 'sendAudio',
  video: 'sendVideo',
  voice: 'sendVoice',
  animation: 'sendAnimation',
  sticker: 'sendSticker',
  document: 'sendDocument',
  video_note: 'sendDocument',
};

/**
 * Extract the uploaded file reference from a Telegram message result
 * based on the media type present in the result.
 *
 * Falls back to looking up the file type key directly on the result object.
 *
 * @param result - The message result from a Telegram send* call.
 * @param fileType - The file type classification (e.g. "document", "photo").
 * @returns The uploaded file reference, or `undefined` if none was found.
 */
export const extractUploadedFile = (
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

/**
 * Build the send payload (caption, etc.) for a Telegram send* method call.
 *
 * Stickers do not support captions. Documents get a labelled caption
 * with the file name. All other types use the plain file name as caption.
 *
 * @param fileType - The file type (e.g. "document", "photo", "sticker").
 * @param fileName - The file name to use in the caption.
 * @returns The payload object with caption (or empty for sticker).
 */
export const buildSendPayload = (fileType: string, fileName: string): SendPayload => {
  const basePayload: SendPayload = { caption: fileName };
  if (fileType === 'sticker') return {};
  if (fileType === 'document') return { caption: `📁 ${fileName}` };
  return basePayload;
};
