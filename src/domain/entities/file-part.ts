/**
 * Supported compression algorithms for stored file parts.
 * - `"gzip"`: Gzip compression was applied
 * - `null`: No compression applied
 */
export type CompressionAlgorithm = 'gzip' | null;

/**
 * Core domain entity representing a chunk (part) of a file stored in Telegram.
 * Large files are split into multiple parts for Telegram-safe storage.
 */
export interface FilePart {
  /** Primary key, auto-increment */
  id: number;
  /** Foreign key to the parent File record (UUID) */
  fileId: string;
  /** Sequential part number (1-based within the file) */
  partNumber: number;
  /** Telegram file_id for retrieving this part */
  telegramFileId: string;
  /** Telegram unique file_id (stable across bot tokens) */
  telegramFileUniqueId: string;
  /** Chat ID where this part is stored */
  storageChatId: number;
  /** Message ID within the storage chat */
  storageMessageId: number;
  /** Original size of this part in bytes */
  sizeBytes: number;
  /** Stored (post-compression) size in bytes */
  storedSizeBytes: number;
  /** Compression algorithm applied, or null if uncompressed */
  compressionAlgorithm: CompressionAlgorithm;
  /** ETag for this part (hash of the stored content) */
  etag: string;
  /** Record creation timestamp */
  createdAt: Date;
}

/**
 * Input type for creating a new FilePart record.
 * Omits auto-generated fields (id, createdAt).
 */
export type NewFilePart = Omit<FilePart, 'id' | 'createdAt'>;
