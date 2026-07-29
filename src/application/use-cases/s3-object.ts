import type { File } from '../../domain/entities/file';
import type { IBucketRepository } from '../../domain/ports/bucket-repository';
import type { IFilePartRepository } from '../../domain/ports/file-part-repository';
import type { IFileRepository } from '../../domain/ports/file-repository';
import type { IMultipartRepository } from '../../domain/ports/multipart-repository';
import type { ITelegramService, TelegramFileInfo } from '../../domain/ports/telegram-service';
import type { CompressionAlgorithm } from '../../shared/utils/compress';

// ─── Types ──────────────────────────────────────────────────────────

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
