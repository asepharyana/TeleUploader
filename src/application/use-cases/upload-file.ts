import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { buildNewFile } from '../../domain/entities/file-factory';
import type { NewFilePart } from '../../domain/entities/file-part';
import type { IFilePartRepository } from '../../domain/ports/file-part-repository';
import type { IFileRepository } from '../../domain/ports/file-repository';
import type { ITelegramService } from '../../domain/ports/telegram-service';
import { type CompressionAlgorithm, maybeCompressChunk } from '../../shared/utils/compress';
import { checkFileSize, computeHash, ensureExtension, getFileType } from '../../shared/utils/file';
import type { UploadInput, UploadOutput } from '../dto/upload';

/** Metadata for a single uploaded chunk/part. */
interface UploadedPart {
  /** 1-based part number. */
  partNumber: number;
  /** Telegram file identifier for this part. */
  telegramFileId: string;
  /** Telegram unique file identifier (stable across bot tokens). */
  telegramFileUniqueId: string;
  /** Message ID within the storage chat. */
  storageMessageId: number;
  /** Original size of the chunk in bytes before compression. */
  sizeBytes: number;
  /** Stored (post-compression) size in bytes. */
  storedSizeBytes: number;
  /** Compression algorithm applied, or null if uncompressed. */
  compressionAlgorithm: CompressionAlgorithm;
  /** SHA-256 hash of the original chunk content. */
  etag: string;
}

/** Result of uploading a file in multiple Telegram chunks. */
interface ChunkedUploadResult {
  /** Metadata for each uploaded part. */
  parts: UploadedPart[];
  /** SHA-256 hex digest of the complete file content. */
  fileHash: string;
  /** Total file size in bytes (sum of all original chunks). */
  totalSizeBytes: number;
}

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
  /** File-part repository for chunked file metadata. */
  filePartRepo: IFilePartRepository;
  /** Telegram service for forwarding file content to storage. */
  telegramService: ITelegramService;
  /** Application configuration subset. */
  config: UploadFileConfig;
}

/**
 * Validates the configured chunk size and returns it as a safe integer.
 *
 * @param chunkSizeBytes - The configured chunk size in bytes.
 * @returns The same value if it is a positive safe integer.
 */
const asSafeChunkSize = (chunkSizeBytes: number): number => {
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new Error('Invalid Telegram chunk size');
  }
  return chunkSizeBytes;
};

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
 * Reads a file from disk in chunks, forwards each chunk to Telegram storage,
 * and returns metadata for all uploaded parts together with the total file
 * hash.
 *
 * @param tempPath - Absolute path to the temporary file on disk.
 * @param partFileNamePrefix - Prefix used for each chunk's file name in Telegram.
 * @param chunkSizeBytes - Maximum size of each chunk in bytes.
 * @param compress - Whether gzip compression is enabled.
 * @param compressionMinSizeBytes - Minimum chunk size to attempt compression.
 * @param telegramService - The Telegram service to forward each chunk.
 * @returns The aggregated chunked upload result.
 */
const uploadFileInTelegramChunks = async (
  tempPath: string,
  partFileNamePrefix: string,
  chunkSizeBytes: number,
  compress: boolean,
  compressionMinSizeBytes: number,
  telegramService: ITelegramService,
): Promise<ChunkedUploadResult> => {
  const safeChunkSize = asSafeChunkSize(chunkSizeBytes);
  const hasher = new Bun.CryptoHasher('sha256');
  const parts: UploadedPart[] = [];
  let totalSizeBytes = 0;
  let partNumber = 0;

  const stream = createReadStream(tempPath, { highWaterMark: safeChunkSize });

  for await (const data of stream) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
    if (chunk.byteLength === 0) continue;

    partNumber += 1;
    totalSizeBytes += chunk.byteLength;
    hasher.update(chunk);

    const { bytes, compressionAlgorithm } = maybeCompressChunk(
      chunk,
      compress,
      compressionMinSizeBytes,
    );

    const forwardResult = await telegramService.forwardToStorage(
      bytes,
      `${partFileNamePrefix}.part-${partNumber}`,
      'document',
    );

    parts.push({
      partNumber,
      telegramFileId: forwardResult.telegramFileId,
      telegramFileUniqueId: forwardResult.telegramFileUniqueId,
      storageMessageId: forwardResult.storageMessageId,
      sizeBytes: chunk.byteLength,
      storedSizeBytes: bytes.byteLength,
      compressionAlgorithm,
      etag: computeHash(chunk),
    });
  }

  return {
    parts,
    fileHash: hasher.digest('hex'),
    totalSizeBytes,
  };
};

/**
 * Creates a factory function for the upload-file use case.
 *
 * The returned use case:
 * 1. Checks for an existing file with the same SHA-256 hash (deduplication).
 * 2. Normalises the file name and MIME type based on magic bytes.
 * 3. Validates the file size against Telegram type-specific limits.
 * 4. Chooses a storage strategy — chunked (for files exceeding the chunk
 *    threshold) or single-message upload.
 * 5. Persists the file record (and, for chunked uploads, part records).
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

    // 4. Upload — chunked for files above the threshold, single otherwise
    if (input.sizeBytes > deps.config.telegramChunkSizeBytes) {
      // Chunked upload path
      const chunkResult = await uploadFileInTelegramChunks(
        input.tempPath,
        `direct-${input.fileHash.slice(0, 16)}`,
        deps.config.telegramChunkSizeBytes,
        deps.config.compressChunkedUploads,
        deps.config.chunkCompressionMinSizeBytes,
        deps.telegramService,
      );

      const firstPart = chunkResult.parts[0];
      if (!firstPart) {
        throw new Error('Chunked upload produced no parts');
      }

      const fileId = nanoid();
      const publicId = nanoid();

      const newFile = await deps.fileRepo.create(
        buildNewFile({
          publicId,
          telegramFileId: firstPart.telegramFileId,
          telegramFileUniqueId: firstPart.telegramFileUniqueId,
          storageChatId: deps.config.storageChatId,
          storageMessageId: firstPart.storageMessageId,
          fileName: finalFileName,
          mimeType,
          sizeBytes: chunkResult.totalSizeBytes,
          fileType,
          storageBackend: 'chunked',
          uploaderId: input.uploaderId,
          fileHash: chunkResult.fileHash,
          bucketId: input.bucketId,
          s3Key: input.s3Key,
          partCount: chunkResult.parts.length,
        }),
      );

      const fileParts: NewFilePart[] = chunkResult.parts.map((part) => ({
        fileId,
        partNumber: part.partNumber,
        telegramFileId: part.telegramFileId,
        telegramFileUniqueId: part.telegramFileUniqueId,
        storageChatId: deps.config.storageChatId,
        storageMessageId: part.storageMessageId,
        sizeBytes: part.sizeBytes,
        storedSizeBytes: part.storedSizeBytes,
        compressionAlgorithm: part.compressionAlgorithm,
        etag: part.etag,
      }));

      await deps.filePartRepo.insert(fileParts);

      return {
        publicId: newFile.publicId,
        fileName: newFile.fileName,
        mimeType: newFile.mimeType,
        sizeBytes: newFile.sizeBytes,
        fileType: newFile.fileType,
        createdAt: newFile.createdAt,
        downloadUrl: `${deps.config.baseUrl}/f/${newFile.publicId}`,
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
