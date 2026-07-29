import { gzipSync } from 'node:zlib';
import { nanoid } from 'nanoid';
import type { File } from '../../domain/entities/file';
import { buildNewFile } from '../../domain/entities/file-factory';
import type { NewFilePart } from '../../domain/entities/file-part';
import type { MultipartPart } from '../../domain/entities/multipart';
import type { IBucketRepository } from '../../domain/ports/bucket-repository';
import type { IFilePartRepository } from '../../domain/ports/file-part-repository';
import type { IFileRepository, S3FileRecord } from '../../domain/ports/file-repository';
import type { IMultipartRepository } from '../../domain/ports/multipart-repository';
import type { ITelegramService, TelegramFileInfo } from '../../domain/ports/telegram-service';
import {
  computeHash,
  DEFAULT_FILE_TYPE,
  ensureExtension,
  formatCreatedAt,
} from '../../shared/utils/file';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Compression algorithm used for chunked object storage.
 */
type CompressionAlgorithm = 'gzip' | null;

/**
 * A single part source for building a multi-part streaming response.
 * Each part corresponds to a Telegram-stored file chunk.
 */
export interface ObjectPartSource {
  /** Telegram file identifier for retrieving this part. */
  telegramFileId: string;
  /** Telegram CDN URL for downloading this part. */
  telegramUrl: string;
  /** Original size of this part in bytes. */
  sizeBytes: number;
  /** 1-based part number within the object. */
  partNumber: number;
  /** Stored (post-compression) size in bytes, when applicable. */
  storedSizeBytes?: number;
  /** Compression algorithm applied, or null if uncompressed. */
  compressionAlgorithm?: CompressionAlgorithm;
}

/**
 * A regular (direct) S3 object resolved to a Telegram CDN URL.
 */
export interface DirectObjectResult {
  /** Discriminant. */
  type: 'direct';
  /** The resolved file entity. */
  file: File;
  /** Full Telegram CDN URL for downloading the object. */
  telegramUrl: string;
  /** Telegram file metadata. */
  fileInfo: TelegramFileInfo;
}

/**
 * A chunked S3 object stored across multiple Telegram file parts.
 */
export interface ChunkedObjectResult {
  /** Discriminant. */
  type: 'chunked';
  /** The resolved file entity. */
  file: File;
}

/**
 * An S3 object assembled from a completed multipart upload.
 */
export interface MultipartObjectResult {
  /** Discriminant. */
  type: 'multipart';
  /** The resolved file entity. */
  file: File;
  /** Resolved part sources with Telegram CDN URLs. */
  parts: ObjectPartSource[];
}

/**
 * Discriminated union of all possible S3 get-object outcomes.
 */
export type GetObjectResult = DirectObjectResult | ChunkedObjectResult | MultipartObjectResult;

/**
 * Result of an S3 put-object operation.
 */
export interface PutObjectResult {
  /** SHA-256 hex digest of the object content. */
  etag: string;
}

/**
 * Result of an S3 copy-object operation.
 */
export interface CopyObjectResult {
  /** SHA-256 hex digest of the source object content. */
  etag: string;
  /** ISO-8601 timestamp of the copy operation. */
  lastModified: string;
}

/**
 * A single S3 object as returned in listing results.
 */
export interface ListObjectEntry {
  /** The object key (full path within the bucket). */
  key: string;
  /** Object size in bytes. */
  sizeBytes: number;
  /** SHA-256 hex digest or fallback identifier. */
  etag: string;
  /** ISO-8601 timestamp of last modification. */
  lastModified: string;
  /** MIME type of the stored object. */
  mimeType: string;
}

/**
 * Result of an S3 list-objects operation (both V1 and V2).
 */
export interface ListObjectsResult {
  /** Array of object summaries. */
  objects: ListObjectEntry[];
  /** Common prefixes when a delimiter was used. */
  prefixes: string[];
  /** Whether more results are available. */
  isTruncated: boolean;
  /** The last key in the returned page, for use as the next marker. */
  nextMarker: string | null;
}

/**
 * Head-object metadata.
 */
export interface HeadObjectMetadata {
  /** MIME type of the object. */
  contentType: string;
  /** Object size in bytes. */
  contentLength: number;
  /** Entity tag (SHA-256 hex digest or fallback). */
  etag: string;
  /** ISO-8601 timestamp of last modification. */
  lastModified: string;
}

// ─── Config ─────────────────────────────────────────────────────────

/** Subset of application configuration consumed by the s3-object use cases. */
export interface S3ObjectConfig {
  /** Maximum chunk size in bytes for Telegram chunked uploads. */
  telegramChunkSizeBytes: number;
  /** Whether gzip compression is enabled for chunked uploads. */
  compressChunkedUploads: boolean;
  /** Minimum chunk size in bytes below which compression is skipped. */
  chunkCompressionMinSizeBytes: number;
  /** Telegram chat ID where file parts are stored. */
  storageChatId: number;
  /** Server base URL for constructing download links. */
  baseUrl: string;
  /** Whether to proxy S3 GET requests through the server. */
  proxyS3Get: boolean;
}

/** Dependencies required by the s3-object use case factories. */
export interface S3ObjectDeps {
  /** Bucket repository for bucket lookups. */
  bucketRepo: IBucketRepository;
  /** File repository for object CRUD operations. */
  fileRepo: IFileRepository;
  /** File-part repository for chunked upload part records. */
  filePartRepo: IFilePartRepository;
  /** Multipart repository for resolving multipart-upload objects. */
  multipartRepo: IMultipartRepository;
  /** Telegram service for uploading and resolving file metadata. */
  telegramService: ITelegramService;
  /** Application configuration subset. */
  config: S3ObjectConfig;
}

// ─── Helpers ────────────────────────────────────────────────────────

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
 * Optionally gzip-compresses a chunk if compression is enabled and the chunk
 * is large enough to benefit from it.
 *
 * @param chunk - The raw chunk buffer.
 * @param compress - Whether compression is enabled.
 * @param compressionMinSizeBytes - Minimum chunk size to attempt compression.
 * @returns The (possibly compressed) buffer and the algorithm used.
 */
const maybeCompressChunk = (
  chunk: Buffer,
  compress: boolean,
  compressionMinSizeBytes: number,
): { bytes: Buffer; compressionAlgorithm: CompressionAlgorithm } => {
  if (!compress || chunk.byteLength < compressionMinSizeBytes) {
    return { bytes: chunk, compressionAlgorithm: null };
  }

  const gzipped = gzipSync(chunk);
  if (gzipped.byteLength >= chunk.byteLength) {
    return { bytes: chunk, compressionAlgorithm: null };
  }

  return { bytes: gzipped, compressionAlgorithm: 'gzip' };
};

/**
 * Metadata for a single uploaded chunk/part during S3 put-object.
 */
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

/** Result of uploading an object in multiple Telegram chunks. */
interface ChunkedUploadResult {
  /** Metadata for each uploaded part. */
  parts: UploadedPart[];
  /** SHA-256 hex digest of the complete object content. */
  fileHash: string;
  /** Total object size in bytes (sum of all original chunks). */
  totalSizeBytes: number;
}

/**
 * Uploads a buffer to Telegram in chunks, returning metadata for all parts.
 *
 * @param buffer - The full object buffer.
 * @param partFileNamePrefix - Prefix used for each chunk's file name in Telegram.
 * @param chunkSizeBytes - Maximum size of each chunk in bytes.
 * @param compress - Whether gzip compression is enabled.
 * @param compressionMinSizeBytes - Minimum chunk size to attempt compression.
 * @param telegramService - The Telegram service to forward each chunk.
 * @returns The aggregated chunked upload result.
 */
const uploadInChunks = async (
  buffer: Buffer,
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
  let offset = 0;

  while (offset < buffer.byteLength) {
    const chunk = buffer.subarray(offset, offset + safeChunkSize);
    if (chunk.byteLength === 0) break;

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

    offset += safeChunkSize;
  }

  return {
    parts,
    fileHash: hasher.digest('hex'),
    totalSizeBytes,
  };
};

/**
 * Resolves a list of multipart parts to their Telegram CDN URLs.
 *
 * @param parts - The stored multipart parts.
 * @param telegramService - The Telegram service for resolving file metadata.
 * @returns An array of resolved part sources.
 */
const resolveMultipartParts = async (
  parts: MultipartPart[],
  telegramService: ITelegramService,
): Promise<ObjectPartSource[]> => {
  const sources: ObjectPartSource[] = [];
  for (const part of parts) {
    const fileInfo = await telegramService.getFileInfo(part.telegramFileId);
    sources.push({
      telegramFileId: part.telegramFileId,
      telegramUrl: `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`,
      sizeBytes: part.sizeBytes,
      partNumber: part.partNumber,
    });
  }
  return sources;
};

/**
 * Formats a `createdAt` value into an HTTP Last-Modified header value.
 *
 * @param date - The date to format.
 * @returns The UTC string representation.
 */
const formatLastModified = (date: Date | string | number): string => {
  return date instanceof Date ? date.toUTCString() : new Date(date).toUTCString();
};

// ─── Use Case Factories ─────────────────────────────────────────────

/**
 * Creates a use case that resolves an S3 object for retrieval (GET).
 *
 * Looks up the bucket and file by key, then determines the storage type:
 * - **direct**: regular Telegram-stored object — resolves the Telegram CDN URL.
 * - **chunked**: object stored across multiple Telegram file parts.
 * - **multipart**: object assembled from a completed multipart upload — resolves
 *   the Telegram CDN URLs for each part.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting bucket name and object key, returning
 *          a discriminated union of possible results, or `null` when the
 *          bucket or file is not found.
 */
export function createGetObjectUseCase(deps: S3ObjectDeps) {
  return async (bucketName: string, key: string): Promise<GetObjectResult | null> => {
    const bucket = await deps.bucketRepo.findByName(bucketName);
    if (!bucket) return null;

    const file = await deps.fileRepo.findByBucketAndKey(bucket.id, key);
    if (!file) return null;

    // Chunked storage — return the entity; the caller resolves parts via
    // chunked-storage helpers.
    if (file.storageBackend === 'chunked') {
      return { type: 'chunked', file };
    }

    // Multipart upload object — resolve part Telegram URLs
    if (file.multipartUploadId) {
      const parts = await deps.multipartRepo.listParts(file.multipartUploadId);
      const resolvedParts = await resolveMultipartParts(parts, deps.telegramService);
      return { type: 'multipart', file, parts: resolvedParts };
    }

    // Regular direct object — resolve Telegram CDN URL
    const fileInfo = await deps.telegramService.getFileInfo(file.telegramFileId);
    const telegramUrl = `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`;

    return { type: 'direct', file, telegramUrl, fileInfo };
  };
}

/**
 * Creates a use case that retrieves S3 object metadata (HEAD).
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting bucket name and object key, returning
 *          metadata or `null` when the bucket or file is not found.
 */
export function createHeadObjectUseCase(deps: S3ObjectDeps) {
  return async (bucketName: string, key: string): Promise<HeadObjectMetadata | null> => {
    const bucket = await deps.bucketRepo.findByName(bucketName);
    if (!bucket) return null;

    const file = await deps.fileRepo.findByBucketAndKey(bucket.id, key);
    if (!file) return null;

    return {
      contentType: file.mimeType,
      contentLength: file.sizeBytes,
      etag: file.fileHash || nanoid(16),
      lastModified: formatLastModified(file.createdAt),
    };
  };
}

/**
 * Creates a use case that stores an S3 object (PUT).
 *
 * Handles both chunked (large) and single-message (small) upload paths,
 * deduplicates by bucket+key (idempotent PUT), and persists the file
 * record and (for chunked storage) part records.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting bucket name, key, body buffer, and
 *          content type, returning the etag of the stored object. Returns
 *          `null` when the bucket is not found.
 */
export function createPutObjectUseCase(deps: S3ObjectDeps) {
  return async (
    bucketName: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<PutObjectResult | null> => {
    const bucket = await deps.bucketRepo.findByName(bucketName);
    if (!bucket) return null;

    const hash = computeHash(body);

    // Idempotent PUT: if the object already exists, skip upload
    const existing = await deps.fileRepo.findByBucketAndKey(bucket.id, key);
    if (existing) {
      return { etag: `"${hash}"` };
    }

    const fileName = key.split('/').pop() || 'file';
    const signatureBuffer = body.subarray(0, 16);
    const { fileName: finalFileName, mimeType } = ensureExtension(
      fileName,
      signatureBuffer,
      contentType,
    );

    const partFileNamePrefix = `s3-${bucket.name}-${key.replace(/\//g, '_')}`;
    const {
      telegramChunkSizeBytes,
      compressChunkedUploads,
      chunkCompressionMinSizeBytes,
      storageChatId,
    } = deps.config;

    if (body.byteLength > telegramChunkSizeBytes) {
      // Chunked upload path
      const chunkResult = await uploadInChunks(
        body,
        partFileNamePrefix,
        telegramChunkSizeBytes,
        compressChunkedUploads,
        chunkCompressionMinSizeBytes,
        deps.telegramService,
      );

      const firstPart = chunkResult.parts[0];
      if (!firstPart) {
        throw new Error('Chunked upload produced no parts');
      }

      const fileId = nanoid();
      const publicId = nanoid();

      await deps.fileRepo.create(
        buildNewFile({
          publicId,
          telegramFileId: firstPart.telegramFileId,
          telegramFileUniqueId: firstPart.telegramFileUniqueId,
          storageChatId,
          storageMessageId: firstPart.storageMessageId,
          fileName: finalFileName,
          mimeType,
          sizeBytes: chunkResult.totalSizeBytes,
          fileType: DEFAULT_FILE_TYPE,
          fileHash: chunkResult.fileHash,
          bucketId: bucket.id,
          s3Key: key,
          storageBackend: 'chunked',
          partCount: chunkResult.parts.length,
        }),
      );

      const fileParts: NewFilePart[] = chunkResult.parts.map((part) => ({
        fileId,
        partNumber: part.partNumber,
        telegramFileId: part.telegramFileId,
        telegramFileUniqueId: part.telegramFileUniqueId,
        storageChatId,
        storageMessageId: part.storageMessageId,
        sizeBytes: part.sizeBytes,
        storedSizeBytes: part.storedSizeBytes,
        compressionAlgorithm: part.compressionAlgorithm,
        etag: part.etag,
      }));

      await deps.filePartRepo.insert(fileParts);

      return { etag: `"${chunkResult.fileHash}"` };
    }

    // Single-message upload path
    const forwardResult = await deps.telegramService.forwardToStorage(
      body,
      partFileNamePrefix,
      'document',
    );

    const publicId = nanoid();

    await deps.fileRepo.create(
      buildNewFile({
        publicId,
        telegramFileId: forwardResult.telegramFileId,
        telegramFileUniqueId: forwardResult.telegramFileUniqueId,
        storageChatId,
        storageMessageId: forwardResult.storageMessageId,
        fileName: finalFileName,
        mimeType,
        sizeBytes: body.byteLength,
        fileType: DEFAULT_FILE_TYPE,
        fileHash: hash,
        bucketId: bucket.id,
        s3Key: key,
        storageBackend: 'telegram',
        partCount: null,
      }),
    );

    return { etag: `"${hash}"` };
  };
}

/**
 * Creates a use case that copies an S3 object to a new key (PUT with
 * x-amz-copy-source).
 *
 * Creates a new file record referencing the same Telegram-stored data.
 * Chunked source objects are not supported for copy.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting source + destination identifiers and
 *          optional precondition headers, returning the copy result or
 *          `null` when a required bucket or file is not found.
 */
export function createCopyObjectUseCase(deps: S3ObjectDeps) {
  return async (input: {
    /** Source bucket name. */
    sourceBucket: string;
    /** Source object key. */
    sourceKey: string;
    /** Destination bucket UUID (must already exist). */
    destBucketId: string;
    /** Destination object key. */
    destKey: string;
    /** Optional if-match precondition (raw etag value, without surrounding quotes). */
    ifMatch?: string | null;
    /** Optional if-none-match precondition (raw etag value, without surrounding quotes). */
    ifNoneMatch?: string | null;
  }): Promise<CopyObjectResult | null> => {
    const sourceBucket = await deps.bucketRepo.findByName(input.sourceBucket);
    if (!sourceBucket) return null;

    const sourceFile = await deps.fileRepo.findByBucketAndKey(sourceBucket.id, input.sourceKey);
    if (!sourceFile) return null;

    if (sourceFile.storageBackend === 'chunked') {
      throw new ObjectError(
        'NotImplemented',
        'Copying chunked objects is not yet implemented.',
        501,
      );
    }

    // Conditional copy: if-match / if-none-match checks
    const sourceEtag = sourceFile.fileHash;
    if (input.ifMatch && sourceEtag && input.ifMatch !== sourceEtag) {
      throw new ObjectError(
        'PreconditionFailed',
        'The preconditions you specified did not hold.',
        412,
      );
    }
    if (input.ifNoneMatch && sourceEtag && input.ifNoneMatch === sourceEtag) {
      throw new ObjectError(
        'PreconditionFailed',
        'The preconditions you specified did not hold.',
        412,
      );
    }

    const publicId = nanoid();

    await deps.fileRepo.create(
      buildNewFile({
        publicId,
        telegramFileId: sourceFile.telegramFileId,
        telegramFileUniqueId: sourceFile.telegramFileUniqueId,
        storageChatId: sourceFile.storageChatId,
        storageMessageId: sourceFile.storageMessageId,
        fileName: sourceFile.fileName,
        mimeType: sourceFile.mimeType,
        sizeBytes: sourceFile.sizeBytes,
        fileType: sourceFile.fileType,
        fileHash: sourceFile.fileHash,
        archiveTelegramFileId: sourceFile.archiveTelegramFileId,
        archiveStorageMessageId: sourceFile.archiveStorageMessageId,
        archiveFileName: sourceFile.archiveFileName,
        archiveEntryName: sourceFile.archiveEntryName,
        archiveMimeType: sourceFile.archiveMimeType,
        archiveSizeBytes: sourceFile.archiveSizeBytes,
        bucketId: input.destBucketId,
        s3Key: input.destKey,
        storageBackend: 'telegram',
        partCount: null,
      }),
    );

    return {
      etag: sourceEtag || nanoid(16),
      lastModified: new Date().toISOString(),
    };
  };
}

/**
 * Error type for S3 object-level application errors.
 */
export class ObjectError extends Error {
  /** S3-compatible error code. */
  readonly code: string;
  /** Suggested HTTP status code. */
  readonly status: number;

  /**
   * @param code - The S3 error code.
   * @param message - Human-readable error description.
   * @param status - Suggested HTTP status.
   */
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ObjectError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Creates a use case that soft-deletes an S3 object (DELETE).
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting bucket name and object key, returning
 *          `true` if a row was soft-deleted. Returns `null` when the bucket
 *          is not found.
 */
export function createDeleteObjectUseCase(deps: S3ObjectDeps) {
  return async (bucketName: string, key: string): Promise<boolean | null> => {
    const bucket = await deps.bucketRepo.findByName(bucketName);
    if (!bucket) return null;
    return deps.fileRepo.softDelete(bucket.id, key);
  };
}

/**
 * Creates a use case that batch-deletes multiple S3 objects (POST with
 * ?delete).
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting bucket name and an array of keys,
 *          returning the array of keys that were actually deleted. Returns
 *          `null` when the bucket is not found.
 */
export function createDeleteObjectsUseCase(deps: S3ObjectDeps) {
  return async (bucketName: string, keys: string[]): Promise<string[] | null> => {
    const bucket = await deps.bucketRepo.findByName(bucketName);
    if (!bucket) return null;

    const deletedKeys: string[] = [];
    for (const key of keys) {
      const ok = await deps.fileRepo.softDelete(bucket.id, key);
      if (ok) deletedKeys.push(key);
    }
    return deletedKeys;
  };
}

/**
 * Creates a use case that lists objects within a bucket (ListObjectsV1/V2).
 *
 * Supports prefix filtering, delimiter-based pseudo-directory grouping, and
 * pagination via marker/startAfter.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting query parameters and returning the
 *          listing result, or `null` when the bucket is not found.
 */
export function createListObjectsUseCase(deps: S3ObjectDeps) {
  return async (input: {
    /** Bucket name to list from. */
    bucketName: string;
    /** Key prefix to filter by (empty string for no filter). */
    prefix: string;
    /** Delimiter character (e.g. "/") or null for flat listing. */
    delimiter: string | null;
    /** Maximum number of object records to return (clamped to 1000). */
    maxKeys: number;
    /** Return only keys strictly greater than this value, or null. */
    startAfter: string | null;
  }): Promise<ListObjectsResult | null> => {
    const bucket = await deps.bucketRepo.findByName(input.bucketName);
    if (!bucket) return null;

    const clampedMaxKeys = Math.min(input.maxKeys, 1000);

    const { objects, prefixes } = await deps.fileRepo.listByPrefix(
      bucket.id,
      input.prefix,
      input.delimiter,
      clampedMaxKeys,
      input.startAfter,
    );

    const isTruncated = objects.length > clampedMaxKeys;
    const displayObjects = objects.slice(0, clampedMaxKeys);
    const nextMarker = isTruncated
      ? (displayObjects[displayObjects.length - 1]?.s3Key ?? null)
      : null;

    return {
      objects: displayObjects.map((o: S3FileRecord) => ({
        key: o.s3Key,
        sizeBytes: o.sizeBytes,
        etag: o.fileHash || nanoid(16),
        lastModified: formatCreatedAt(o.createdAt),
        mimeType: o.mimeType,
      })),
      prefixes,
      isTruncated,
      nextMarker,
    };
  };
}

/**
 * Creates a use case that checks whether an object exists and is accessible
 * within a bucket.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting a bucket ID and object key,
 *          returning the file entity or null.
 */
export function createFindObjectUseCase(deps: Pick<S3ObjectDeps, 'fileRepo'>) {
  return async (bucketId: string, key: string): Promise<File | null> => {
    return deps.fileRepo.findByBucketAndKey(bucketId, key);
  };
}
