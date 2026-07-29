/**
 * Factory function for building NewFile records with sensible defaults.
 *
 * Most call sites set the same null defaults for archive/S3/soft-delete fields.
 * This factory eliminates ~20 lines of boilerplate per call site (~27 sites).
 */
import type { NewFile } from './file';

/**
 * Partial input for creating a file record.
 * Only the required unique fields must be provided; optional fields default to null/0/false.
 */
export interface FileInput {
  publicId: string;
  telegramFileId: string;
  telegramFileUniqueId: string;
  storageChatId: number;
  storageMessageId: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  fileType: string;
  storageBackend: string | null;
  /** Optional overrides */
  uploaderId?: number;
  fileHash?: string | null;
  bucketId?: string | null;
  s3Key?: string | null;
  partCount?: number | null;
  multipartUploadId?: string | null;
  /** Archive fields (for batch/zip archives) */
  archiveTelegramFileId?: string | null;
  archiveStorageMessageId?: number | null;
  archiveFileName?: string | null;
  archiveEntryName?: string | null;
  archiveMimeType?: string | null;
  archiveSizeBytes?: number | null;
}

/**
 * Build a NewFile record, filling in null/zero defaults for omitted fields.
 *
 * @example
 * ```ts
 * await fileRepo.create(buildNewFile({
 *   publicId,
 *   telegramFileId: result.telegramFileId,
 *   telegramFileUniqueId: result.telegramFileUniqueId,
 *   storageChatId,
 *   storageMessageId: result.storageMessageId,
 *   fileName: input.fileName,
 *   mimeType,
 *   sizeBytes: input.sizeBytes,
 *   fileType,
 *   storageBackend: 'telegram',
 *   uploaderId: input.uploaderId,
 *   fileHash: input.fileHash,
 * }));
 * ```
 */
export const buildNewFile = (input: FileInput): NewFile => ({
  publicId: input.publicId,
  telegramFileId: input.telegramFileId,
  telegramFileUniqueId: input.telegramFileUniqueId,
  storageChatId: input.storageChatId,
  storageMessageId: input.storageMessageId,
  fileName: input.fileName,
  mimeType: input.mimeType,
  sizeBytes: input.sizeBytes,
  fileType: input.fileType,
  uploaderId: input.uploaderId ?? 0,
  fileHash: input.fileHash ?? null,
  archiveTelegramFileId: input.archiveTelegramFileId ?? null,
  archiveStorageMessageId: input.archiveStorageMessageId ?? null,
  archiveFileName: input.archiveFileName ?? null,
  archiveEntryName: input.archiveEntryName ?? null,
  archiveMimeType: input.archiveMimeType ?? null,
  archiveSizeBytes: input.archiveSizeBytes ?? null,
  bucketId: input.bucketId ?? null,
  s3Key: input.s3Key ?? null,
  storageBackend: input.storageBackend,
  isDeleted: false,
  multipartUploadId: input.multipartUploadId ?? null,
  partCount: input.partCount ?? null,
});
