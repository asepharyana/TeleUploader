/**
 * Input for the upload file use case.
 * Carries all metadata needed to persist an uploaded file,
 * including its temporary location on disk and optional bucket/S3 context.a
 */
export interface UploadInput {
  /** Absolute path to the temporary file on disk */
  tempPath: string;
  /** SHA-256 hex digest of the file content */
  fileHash: string;
  /** Original file name (may include extension) */
  fileName: string;
  /** MIME type detected from content inspection or request header */
  mimeType: string;
  /** High-level file category (e.g. "document", "photo", "video") */
  fileType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Telegram user ID of the uploader; 0 when unknown or system */
  uploaderId?: number;
  /** Target bucket UUID for S3-compatible storage; null when un-bucketed */
  bucketId?: string | null;
  /** Object key within the bucket for S3-compatible storage; null when un-bucketed */
  s3Key?: string | null;
}

/**
 * Output from the upload file use case.
 * Contains the public-facing file metadata returned to the caller.
 */
export interface UploadOutput {
  /** Public, shareable identifier (nanoid) */
  publicId: string;
  /** Stored file name (may have been normalized with extension) */
  fileName: string;
  /** MIME type of the stored file */
  mimeType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** High-level file category */
  fileType: string;
  /** ISO-8601 timestamp of when the file record was created */
  createdAt: Date;
  /** Public download URL */
  downloadUrl: string;
}
