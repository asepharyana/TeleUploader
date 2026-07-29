/**
 * Result of forwarding a file to Telegram storage.
 */
export interface ForwardResult {
  /** The Telegram file_id for retrieving the file */
  telegramFileId: string;
  /** The Telegram unique file_id (stable across bot tokens) */
  telegramFileUniqueId: string;
  /** The message ID within the storage chat */
  storageMessageId: number;
}

/**
 * File information returned by Telegram's getFile API.
 */
export interface TelegramFileInfo {
  /** File size in bytes */
  file_size: number;
  /** MIME type of the file */
  mime_type: string;
  /** Path on Telegram's file server for downloading */
  file_path: string;
  /** Bot token that owns the retrieved file */
  bot_token: string;
}

/**
 * Abstraction over Telegram bot API operations.
 *
 * Defines the contract for forwarding files to Telegram storage,
 * retrieving file metadata, and managing concurrent uploads.
 */
export interface ITelegramService {
  /**
   * Forward a file chunk to the configured Telegram storage chat.
   *
   * @param fileChunk - The file data (ReadStream, Buffer, or file path).
   * @param fileName - The original file name.
   * @param fileType - The file type classification (e.g. "photo", "document").
   * @returns The Telegram identifiers of the stored file.
   */
  forwardToStorage(fileChunk: unknown, fileName: string, fileType: string): Promise<ForwardResult>;

  /**
   * Retrieve file metadata from Telegram by file ID.
   *
   * Tries all configured bots; returns info from the first that owns the file.
   *
   * @param telegramFileId - The Telegram file_id to look up.
   * @returns Metadata including size, MIME type, download path, and bot token.
   */
  getFileInfo(telegramFileId: string): Promise<TelegramFileInfo>;
}
