import { open } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { File } from '../../domain/entities/file';
import { buildNewFile } from '../../domain/entities/file-factory';
import type { IFileRepository } from '../../domain/ports/file-repository';
import type { ITelegramService } from '../../domain/ports/telegram-service';
import type { ChunkedStorage } from '../../infrastructure/telegram/chunked-storage';
import {
  checkFileSize,
  cleanupTempFile,
  ensureExtension,
  getFileType,
} from '../../shared/utils/file';
import type { UploadInput, UploadOutput } from '../dto/upload';

/** Subset of application configuration consumed by the upload-file use case. */
export interface UploadFileConfig {
  /** Server base URL for constructing download links. */
  baseUrl: string;
  /** Maximum chunk size in bytes for Telegram chunked uploads. */
  telegramChunkSizeBytes: number;
  /** Telegram chat ID where file parts are stored. */
  storageChatId: number;
  /** Whether to attempt gzip compression on each chunk. */
  compressChunkedUploads: boolean;
  /** Minimum chunk size in bytes below which compression is skipped. */
  chunkCompressionMinSizeBytes: number;
}

/** Dependencies required by the upload-file use case factory. */
export interface UploadFileUseCaseDeps {
  /** File repository for CRUD operations on file records. */
  fileRepo: IFileRepository;
  /** Telegram service for forwarding file content to storage. */
  telegramService: ITelegramService;
  /** Chunked storage handler for large file uploads. */
  chunkedStorage: ChunkedStorage;
  /** Application configuration subset. */
  config: UploadFileConfig;
}

/**
 * Reads the first 16 bytes from a file on disk for magic-byte detection.
 *
 * @param tempPath - Absolute path to the temporary file.
 * @returns A buffer containing up to 16 bytes.
 */
const readSignatureBuffer = async (tempPath: string): Promise<Buffer> => {
  const handle = await open(tempPath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/**
 * Maps a persisted file entity to the public upload output DTO.
 *
 * @param file - The persisted file record.
 * @param baseUrl - Server base URL for the download link.
 * @returns The public `UploadOutput` DTO.
 */
const toUploadOutput = (file: File, baseUrl: string): UploadOutput => ({
  publicId: file.publicId,
  fileName: file.fileName,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
  fileType: file.fileType,
  createdAt: file.createdAt instanceof Date ? file.createdAt : new Date(file.createdAt),
  downloadUrl: `${baseUrl}/f/${file.publicId}`,
  fileHash: file.fileHash,
});

/**
 * Creates a factory function for the upload-file use case.
 *
 * Single save path for all upload entry points (multipart, JSON, web-API):
 * 1. Deduplication per policy — `hash` (by content SHA-256), `bucket-key`
 *    (idempotent by bucket + S3 key), or `none` (store unconditionally).
 * 2. Normalises the file name and MIME type based on magic bytes.
 * 3. Validates the file size against Telegram type-specific limits.
 * 4. Chooses a storage strategy — chunked (delegated to ChunkedStorage) or
 *    single-message upload.
 * 5. Persists the file record.
 * 6. Builds and returns the public `UploadOutput` DTO.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting `UploadInput` and returning `UploadOutput`.
 */
export function createUploadFileUseCase(deps: UploadFileUseCaseDeps) {
  return async (input: UploadInput): Promise<UploadOutput> => {
    const dedup = input.dedup ?? 'hash';

    // 1. Deduplication per policy
    if (dedup === 'hash') {
      const existing = await deps.fileRepo.findByHash(input.fileHash);
      if (existing) {
        return toUploadOutput(existing, deps.config.baseUrl);
      }
    } else if (dedup === 'bucket-key') {
      if (!input.bucketId || !input.s3Key) {
        throw new Error('bucket-key dedup requires bucketId and s3Key');
      }
      const existing = await deps.fileRepo.findByBucketAndKey(input.bucketId, input.s3Key);
      if (existing) {
        return toUploadOutput(existing, deps.config.baseUrl);
      }
    }

    // 2. Signature bytes for magic-byte-based extension detection
    const signatureBuffer = input.signatureBuffer ?? (await readSignatureBuffer(input.tempPath));

    const { fileName: finalFileName, mimeType } = ensureExtension(
      input.fileName,
      signatureBuffer,
      input.mimeType,
    );

    // 3. Determine Telegram file type and validate size
    const fileTypeRaw = getFileType(mimeType, finalFileName);
    const fileType = fileTypeRaw === 'application' ? 'document' : fileTypeRaw;

    if (!checkFileSize(input.sizeBytes, fileType)) {
      throw new Error(`File size exceeds ${fileType} limit`);
    }

    const partPrefix = input.partPrefix ?? `direct-${input.fileHash.slice(0, 16)}`;

    // 4. Upload — chunked via ChunkedStorage for files above the threshold,
    // single-message otherwise. The temp file is always cleaned up here so
    // callers never need their own cleanup block.
    try {
      if (input.sizeBytes > deps.config.telegramChunkSizeBytes) {
        const uploadedFile = await deps.chunkedStorage.storeFileInTelegramChunks({
          tempPath: input.tempPath,
          partFileNamePrefix: partPrefix,
          fileName: finalFileName,
          mimeType,
          sizeBytes: input.sizeBytes,
          fileType,
          uploaderId: input.uploaderId ?? 0,
          bucketId: input.bucketId,
          s3Key: input.s3Key,
        });

        return toUploadOutput(uploadedFile, deps.config.baseUrl);
      }

      // 5. Single-message upload path. Pass the temp path (not an open
      // stream) so the telegram service owns file I/O — test doubles that
      // never touch disk keep working, and the use case stays stream-agnostic.
      const forwardResult = await deps.telegramService.forwardToStorage(
        input.tempPath,
        finalFileName,
        fileType,
      );

      const singlePublicId = nanoid();

      const createdFile = await deps.fileRepo.create(
        buildNewFile({
          publicId: singlePublicId,
          telegramFileId: forwardResult.telegramFileId,
          telegramFileUniqueId: forwardResult.telegramFileUniqueId,
          storageChatId: deps.config.storageChatId,
          storageMessageId: forwardResult.storageMessageId,
          fileName: finalFileName,
          mimeType,
          sizeBytes: input.sizeBytes,
          fileType,
          storageBackend: 'telegram',
          uploaderId: input.uploaderId,
          fileHash: input.fileHash,
          bucketId: input.bucketId,
          s3Key: input.s3Key,
        }),
      );

      return toUploadOutput(createdFile, deps.config.baseUrl);
    } finally {
      await cleanupTempFile(input.tempPath);
    }
  };
}
