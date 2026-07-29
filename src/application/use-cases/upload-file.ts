import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { buildNewFile } from '../../domain/entities/file-factory';
import type { IFileRepository } from '../../domain/ports/file-repository';
import type { ITelegramService } from '../../domain/ports/telegram-service';
import type { ChunkedStorage } from '../../infrastructure/telegram/chunked-storage';
import { checkFileSize, ensureExtension, getFileType } from '../../shared/utils/file';
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
 * Creates a factory function for the upload-file use case.
 *
 * The returned use case:
 * 1. Checks for an existing file with the same SHA-256 hash (deduplication).
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
    // 1. Check deduplication by content hash
    const existing = await deps.fileRepo.findByHash(input.fileHash);
    if (existing) {
      return {
        publicId: existing.publicId,
        fileName: existing.fileName,
        mimeType: existing.mimeType,
        sizeBytes: existing.sizeBytes,
        fileType: existing.fileType,
        createdAt:
          existing.createdAt instanceof Date ? existing.createdAt : new Date(existing.createdAt),
        downloadUrl: `${deps.config.baseUrl}/f/${existing.publicId}`,
      };
    }

    // 2. Read signature bytes for magic-byte-based extension detection
    const signatureBuffer = await readSignatureBuffer(input.tempPath);

    const { fileName: finalFileName, mimeType } = ensureExtension(
      input.fileName,
      signatureBuffer,
      input.mimeType,
    );

    // 3. Determine Telegram file type and validate size
    const fileType = getFileType(mimeType, finalFileName);

    if (!checkFileSize(input.sizeBytes, fileType)) {
      throw new Error(`File size exceeds ${fileType} limit`);
    }

    // 4. Upload — chunked via ChunkedStorage for files above the threshold
    if (input.sizeBytes > deps.config.telegramChunkSizeBytes) {
      const uploadedFile = await deps.chunkedStorage.storeFileInTelegramChunks({
        tempPath: input.tempPath,
        partFileNamePrefix: `direct-${input.fileHash.slice(0, 16)}`,
        fileName: finalFileName,
        mimeType,
        sizeBytes: input.sizeBytes,
        fileType,
        uploaderId: input.uploaderId ?? 0,
        bucketId: input.bucketId,
        s3Key: input.s3Key,
      });

      return {
        publicId: uploadedFile.publicId,
        fileName: uploadedFile.fileName,
        mimeType: uploadedFile.mimeType,
        sizeBytes: uploadedFile.sizeBytes,
        fileType: uploadedFile.fileType,
        createdAt: uploadedFile.createdAt,
        downloadUrl: `${deps.config.baseUrl}/f/${uploadedFile.publicId}`,
      };
    }

    // 5. Single-message upload path
    const forwardResult = await deps.telegramService.forwardToStorage(
      createReadStream(input.tempPath),
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

    return {
      publicId: createdFile.publicId,
      fileName: createdFile.fileName,
      mimeType: createdFile.mimeType,
      sizeBytes: createdFile.sizeBytes,
      fileType: createdFile.fileType,
      createdAt: createdFile.createdAt,
      downloadUrl: `${deps.config.baseUrl}/f/${createdFile.publicId}`,
    };
  };
}
