/**
 * Core domain entity representing a file stored in Telegram.
 * Contains both Telegram metadata and optional S3-compatible fields.
 */
export interface File {
  /** Primary key, UUID */
  id: string;
  /** Public-facing unique identifier (short, URL-safe) */
  publicId: string;
  /** Telegram file_id for retrieving the file */
  telegramFileId: string;
  /** Telegram unique file_id (stable across bot tokens) */
  telegramFileUniqueId: string;
  /** Chat ID where the file is stored */
  storageChatId: number;
  /** Message ID within the storage chat */
  storageMessageId: number;
  /** Original file name */
  fileName: string;
  /** MIME type of the file */
  mimeType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** File type classification (e.g. "photo", "document", "video") */
  fileType: string;
  /** Telegram user ID of the uploader */
  uploaderId: number;
  /** SHA-256 hash of file contents, or null */
  fileHash: string | null;
  /** Telegram file_id of the archive (zip) containing this file, or null */
  archiveTelegramFileId: string | null;
  /** Message ID of the archive message, or null */
  archiveStorageMessageId: number | null;
  /** File name within the archive, or null */
  archiveFileName: string | null;
  /** Entry name/path within the archive, or null */
  archiveEntryName: string | null;
  /** MIME type of the archive entry, or null */
  archiveMimeType: string | null;
  /** Size of the archive entry in bytes, or null */
  archiveSizeBytes: number | null;
  /** S3 bucket ID if stored via S3-compatible API, or null */
  bucketId: string | null;
  /** S3 object key if stored via S3-compatible API, or null */
  s3Key: string | null;
  /** Storage backend identifier, defaults to "telegram" */
  storageBackend: string | null;
  /** Soft-delete flag */
  isDeleted: boolean | null;
  /** S3 multipart upload ID if uploaded in parts, or null */
  multipartUploadId: string | null;
  /** Number of file_parts for chunked storage, or null */
  partCount: number | null;
  /** Record creation timestamp */
  createdAt: Date;
  /** Record last-updated timestamp */
  updatedAt: Date;
}

/**
 * Input type for creating a new File record.
 * Omits auto-generated fields (id, createdAt, updatedAt).
 */
export type NewFile = Omit<File, 'id' | 'createdAt' | 'updatedAt'>;
