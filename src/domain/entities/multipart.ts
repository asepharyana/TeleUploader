/**
 * Core domain entity representing an S3 multipart upload session.
 * Tracks in-progress multipart uploads within a bucket.
 */
export interface MultipartUpload {
  /** Unique upload identifier (nanoid) */
  uploadId: string;
  /** Foreign key to the parent Bucket (UUID) */
  bucketId: string;
  /** S3 object key being uploaded */
  s3Key: string;
  /** Timestamp when the upload was initiated */
  initiatedAt: Date;
  /** Upload status: "in_progress", "completed", or "aborted" */
  status: string;
  /** Identifier of the entity that initiated the upload */
  initiatedBy: string;
}

/**
 * Core domain entity representing an individual part of an S3 multipart upload.
 * Each part is stored as a separate Telegram message.
 */
export interface MultipartPart {
  /** Primary key, auto-increment */
  id: number;
  /** Foreign key to the parent MultipartUpload */
  uploadId: string;
  /** Sequential part number (1-based within the upload) */
  partNumber: number;
  /** Telegram file_id for retrieving this part */
  telegramFileId: string;
  /** Telegram unique file_id (stable across bot tokens) */
  telegramFileUniqueId: string;
  /** Message ID within the storage chat */
  storageMessageId: number;
  /** Part size in bytes */
  sizeBytes: number;
  /** ETag for this part */
  etag: string;
  /** Record creation timestamp */
  createdAt: Date;
}
