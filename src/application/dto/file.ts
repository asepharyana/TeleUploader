/**
 * Public file information response returned by the file-info endpoint.
 * Mirrors the JSON shape of GET /file/:publicId/info.
 */
export interface FileInfoResponse {
  /** Public, shareable identifier (nanoid) */
  public_id: string;
  /** Stored file name */
  file_name: string;
  /** MIME type of the stored file */
  mime_type: string;
  /** File size in bytes */
  size_bytes: number;
  /** High-level file category (e.g. "document", "photo") */
  file_type: string;
  /** ISO-8601 timestamp of when the file record was created */
  created_at: string;
}

/**
 * Summary-level file metadata used internally for constructing
 * upload responses and object listing entries.
 */
export interface FileMetadata {
  /** Public, shareable identifier (nanoid) */
  publicId: string;
  /** Telegram file identifier used to retrieve the file from Telegram CDN */
  telegramFileId: string;
  /** Telegram unique file identifier (persists across re‑uploads) */
  telegramFileUniqueId: string;
  /** Chat ID where the file or archive was stored */
  storageChatId: number;
  /** Message ID of the stored file or archive */
  storageMessageId: number;
  /** Stored file name */
  fileName: string;
  /** MIME type of the stored file */
  mimeType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** High-level file category */
  fileType: string;
  /** Telegram user ID of the uploader; 0 when unknown or system */
  uploaderId: number;
  /** Timestamp of file record creation */
  createdAt: Date | string | number;
}

/**
 * Upload response shape returned to API callers.
 * Mirrors the JSON output of the /api/upload endpoint.
 */
export interface UploadResponse {
  /** Public, shareable identifier */
  public_id: string;
  /** Stored file name */
  file_name: string;
  /** MIME type */
  mime_type: string;
  /** File size in bytes */
  size_bytes: number;
  /** High-level file category */
  file_type: string;
  /** ISO-8601 creation timestamp */
  created_at: string;
  /** Public download URL */
  download_url: string;
}
