import { createReadStream } from 'node:fs';
import { nanoid } from 'nanoid';
import type { File as FileEntity } from '../../domain/entities/file';
import { buildNewFile } from '../../domain/entities/file-factory';
import type { NewFilePart } from '../../domain/entities/file-part';
import type { IFilePartRepository } from '../../domain/ports/file-part-repository';
import type { IFileRepository } from '../../domain/ports/file-repository';
import type { ITelegramService } from '../../domain/ports/telegram-service';
import { config } from '../../env';
import { createGetObjectResponse, type ObjectPartSource } from '../../interfaces/s3/object-stream';
import type { RangeParseResult } from '../../interfaces/s3/range';
import { type CompressionAlgorithm, maybeCompressChunk } from '../../shared/utils/compress';
import { computeHash } from '../../shared/utils/file';
import { asSafeChunkSize } from '../../shared/utils/validation';

/**
 * Metadata about a single uploaded chunk (part) stored in Telegram.
 */
export interface ChunkedUploadPart {
  /** 1-based part number within the file */
  partNumber: number;
  /** Telegram file_id for retrieving this part */
  telegramFileId: string;
  /** Telegram unique file_id (stable across bot tokens) */
  telegramFileUniqueId: string;
  /** Message ID within the storage chat */
  storageMessageId: number;
  /** Original (pre-compression) size in bytes */
  sizeBytes: number;
  /** Stored (post-compression) size in bytes */
  storedSizeBytes: number;
  /** Compression algorithm applied, or null */
  compressionAlgorithm: CompressionAlgorithm;
  /** ETag (SHA-256 hash) of the original chunk */
  etag: string;
}

/**
 * Result of uploading a file in Telegram chunks.
 */
export interface ChunkedUploadResult {
  /** Ordered list of uploaded parts */
  parts: ChunkedUploadPart[];
  /** SHA-256 hash of the complete file content */
  fileHash: string;
  /** Total file size in bytes */
  totalSizeBytes: number;
}

/**
 * Input parameters for storing a file via chunked Telegram uploads.
 */
export interface ChunkedFileInput {
  /** Path to the temporary file on disk */
  tempPath: string;
  /** Prefix for generated part file names */
  partFileNamePrefix: string;
  /** Original file name */
  fileName: string;
  /** MIME type of the file */
  mimeType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** File type classification (e.g. "document", "video") */
  fileType: string;
  /** Telegram user ID of the uploader */
  uploaderId: number;
  /** S3 bucket ID if the file is also tracked in S3, or null */
  bucketId?: string | null;
  /** S3 object key if the file is also tracked in S3, or null */
  s3Key?: string | null;
}

/**
 * Manages chunked storage of large files in Telegram.
 *
 * Large files are split into smaller chunks, each uploaded as a separate
 * Telegram document. File and part metadata is persisted through the
 * provided repository interfaces.
 *
 * Injects dependencies via constructor — can be used with any
 * {@link IFileRepository}, {@link IFilePartRepository}, and
 * {@link ITelegramService} implementation.
 */
export class ChunkedStorage {
  /**
   * @param fileRepository - Repository for File entity persistence.
   * @param filePartRepository - Repository for FilePart entity persistence.
   * @param telegramService - Service for Telegram API interactions.
   */
  constructor(
    private readonly fileRepository: IFileRepository,
    private readonly filePartRepository: IFilePartRepository,
    private readonly telegramService: ITelegramService,
  ) {}

  /**
   * Upload a file to Telegram in chunks and return chunk metadata.
   *
   * Reads the file from disk in fixed-size chunks, compresses each chunk
   * if beneficial, and forwards each chunk to Telegram storage.
   *
   * @param input - Upload parameters including temp path, chunk size, and compression settings.
   * @returns Metadata about all uploaded chunks and the file hash.
   */
  async uploadFileInTelegramChunks(input: {
    tempPath: string;
    partFileNamePrefix: string;
    chunkSizeBytes: number;
    compress: boolean;
    compressionMinSizeBytes: number;
  }): Promise<ChunkedUploadResult> {
    const chunkSizeBytes = asSafeChunkSize(input.chunkSizeBytes);
    const hasher = new Bun.CryptoHasher('sha256');
    const parts: ChunkedUploadPart[] = [];
    let totalSizeBytes = 0;
    let partNumber = 0;

    const stream = createReadStream(input.tempPath, { highWaterMark: chunkSizeBytes });

    for await (const data of stream) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
      if (chunk.byteLength === 0) continue;

      partNumber += 1;
      totalSizeBytes += chunk.byteLength;
      hasher.update(chunk);

      const { bytes, compressionAlgorithm } = maybeCompressChunk(
        chunk,
        input.compress,
        input.compressionMinSizeBytes,
      );
      const forwardResult = await this.telegramService.forwardToStorage(
        bytes,
        `${input.partFileNamePrefix}.part-${partNumber}`,
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
  }

  /**
   * Upload a file to Telegram in chunks and persist file + part records.
   *
   * Combines chunk upload ({@link uploadFileInTelegramChunks}) with
   * repository persistence for both the File and FilePart entities.
   *
   * @param input - The file metadata and upload parameters.
   * @returns The persisted File entity.
   */
  async storeFileInTelegramChunks(input: ChunkedFileInput): Promise<FileEntity> {
    const upload = await this.uploadFileInTelegramChunks({
      tempPath: input.tempPath,
      partFileNamePrefix: input.partFileNamePrefix,
      chunkSizeBytes: config.telegramChunkSizeBytes,
      compress: config.compressChunkedUploads,
      compressionMinSizeBytes: config.chunkCompressionMinSizeBytes,
    });

    const firstPart = upload.parts[0];
    if (!firstPart) {
      throw new Error('Chunked upload produced no parts');
    }

    const publicId = nanoid();

    const file = await this.fileRepository.create(
      buildNewFile({
        publicId,
        telegramFileId: firstPart.telegramFileId,
        telegramFileUniqueId: firstPart.telegramFileUniqueId,
        storageChatId: config.storageChatId,
        storageMessageId: firstPart.storageMessageId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: upload.totalSizeBytes,
        fileType: input.fileType,
        storageBackend: 'chunked',
        uploaderId: input.uploaderId,
        fileHash: upload.fileHash,
        bucketId: input.bucketId,
        s3Key: input.s3Key,
        partCount: upload.parts.length,
      }),
    );

    const fileParts: NewFilePart[] = upload.parts.map((part) => ({
      fileId: file.id,
      partNumber: part.partNumber,
      telegramFileId: part.telegramFileId,
      telegramFileUniqueId: part.telegramFileUniqueId,
      storageChatId: config.storageChatId,
      storageMessageId: part.storageMessageId,
      sizeBytes: part.sizeBytes,
      storedSizeBytes: part.storedSizeBytes,
      compressionAlgorithm: part.compressionAlgorithm,
      etag: part.etag,
    }));

    await this.filePartRepository.insert(fileParts);
    return file;
  }

  /**
   * Build a list of object-part sources for reconstructing a chunked file.
   *
   * Queries the file-part repository and enriches each part with
   * the Telegram download URL by calling {@link ITelegramService.getFileInfo}.
   *
   * @param file - The File entity whose parts should be resolved.
   * @returns An ordered list of object part sources ready for streaming.
   */
  async buildChunkedObjectSources(file: FileEntity): Promise<ObjectPartSource[]> {
    const parts = await this.filePartRepository.listByFileId(file.id);

    // Resolve every part's Telegram CDN URL concurrently (each is an independent
    // getFile call) so total resolution time is ~1 round-trip, not N.
    const partInfos = await Promise.all(
      parts.map(async (part) => {
        const fileInfo = await this.telegramService.getFileInfo(part.telegramFileId);
        return {
          part,
          url: `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`,
        };
      }),
    );

    return partInfos.map(({ part, url }) => ({
      telegramFileId: part.telegramFileId,
      telegramUrl: url,
      sizeBytes: part.sizeBytes,
      storedSizeBytes: part.storedSizeBytes,
      compressionAlgorithm: part.compressionAlgorithm,
      partNumber: part.partNumber,
    }));
  }

  /**
   * Create an HTTP Response that streams a chunked file's content.
   *
   * Supports HTTP range requests for partial content delivery.
   * The response is constructed by reassembling parts in order and
   * optionally decompressing gzip-compressed parts.
   *
   * @param input - Parameters including the file entity, range, and request ID.
   * @returns A Response object streaming the requested byte range.
   */
  async createChunkedObjectResponse(input: {
    file: FileEntity;
    range: RangeParseResult;
    reqId: string;
  }): Promise<Response> {
    const parts = await this.buildChunkedObjectSources(input.file);
    if (parts.length === 0) {
      throw new Error('Chunked object has no parts');
    }

    return createGetObjectResponse({
      reqId: input.reqId,
      contentType: input.file.mimeType,
      etag: input.file.fileHash || parts.map((p) => p.telegramFileId).join('-'),
      lastModified:
        input.file.createdAt instanceof Date
          ? input.file.createdAt
          : new Date(input.file.createdAt),
      totalSize: Number(input.file.sizeBytes),
      parts,
      range: input.range,
    });
  }
}
