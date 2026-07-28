import { nanoid } from 'nanoid';
import type { MultipartUpload } from '../../domain/entities/multipart';
import type { IBucketRepository } from '../../domain/ports/bucket-repository';
import type { IFileRepository } from '../../domain/ports/file-repository';
import type { IMultipartRepository } from '../../domain/ports/multipart-repository';
import type { ITelegramService } from '../../domain/ports/telegram-service';
import { computeHash } from '../../shared/utils/file';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * A single part reference as submitted in a complete-multipart-upload request.
 */
export interface CompletePartInput {
  /** 1-based part number. */
  partNumber: number;
  /** ETag returned when the part was uploaded. */
  etag: string;
}

/**
 * Result of initiating a multipart upload.
 */
export interface InitiateMultipartResult {
  /** The generated upload identifier (nanoid). */
  uploadId: string;
  /** The bucket name. */
  bucket: string;
  /** The S3 object key. */
  key: string;
}

/**
 * Result of uploading a single part.
 */
export interface UploadPartResult {
  /** ETag of the uploaded part (SHA-256 hex digest). */
  etag: string;
}

/**
 * Result of completing a multipart upload.
 */
export interface CompleteMultipartResult {
  /** Public-facing unique identifier of the created file record. */
  publicId: string;
  /** The S3 location URL of the completed object. */
  location: string;
  /** Combined ETag (all part etags joined by hyphens). */
  etag: string;
  /** Total object size in bytes. */
  sizeBytes: number;
}

/**
 * Summary of a single part within a multipart upload used in listing results.
 */
export interface PartSummary {
  /** 1-based part number. */
  partNumber: number;
  /** ETag of the part content. */
  etag: string;
  /** Part size in bytes. */
  sizeBytes: number;
  /** ISO-8601 timestamp when the part was stored. */
  createdAt: Date;
}

/**
 * Result of listing multipart uploads within a bucket.
 */
export interface ListMultipartUploadsResult {
  /** Array of in-progress upload summaries. */
  uploads: MultipartUpload[];
  /** Whether more results are available. */
  isTruncated: boolean;
  /** Marker for the next page, or null when not truncated. */
  nextKeyMarker: string | null;
}

// ─── Config ─────────────────────────────────────────────────────────

/** Subset of application configuration consumed by the multipart use cases. */
export interface MultipartConfig {
  /** Maximum chunk size in bytes for Telegram uploads (part size limit). */
  telegramChunkSizeBytes: number;
  /** Telegram chat ID where part data is stored. */
  storageChatId: number;
  /** Server base URL for constructing location URLs. */
  baseUrl: string;
}

/** Dependencies required by the multipart upload use case factories. */
export interface MultipartDeps {
  /** Bucket repository for bucket lookups. */
  bucketRepo: IBucketRepository;
  /** File repository for creating the final file record on completion. */
  fileRepo: IFileRepository;
  /** Multipart repository for managing upload sessions and parts. */
  multipartRepo: IMultipartRepository;
  /** Telegram service for forwarding part data to storage. */
  telegramService: ITelegramService;
  /** Application configuration subset. */
  config: MultipartConfig;
}

// ─── Use Case Factories ─────────────────────────────────────────────

/**
 * Creates a use case that initiates an S3 multipart upload.
 *
 * Validates the bucket exists and creates a new multipart upload session.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting bucket name and object key, returning
 *          the upload initiation result, or `null` when the bucket is not found.
 */
export function createInitiateMultipartUploadUseCase(deps: MultipartDeps) {
  return async (bucketName: string, key: string): Promise<InitiateMultipartResult | null> => {
    const bucket = await deps.bucketRepo.findByName(bucketName);
    if (!bucket) return null;

    const uploadId = await deps.multipartRepo.create(bucket.id, key, 's3');

    return { uploadId, bucket: bucketName, key };
  };
}

/**
 * Creates a use case that uploads a single part of a multipart upload.
 *
 * Validates the part number range (1-10000), checks the upload session exists
 * and matches the expected key, checks part size against the configured limit,
 * forwards the part data to Telegram storage, and persists the part record.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting upload details and part data, returning
 *          the part ETag, or `null` when the upload session is not found.
 */
export function createUploadPartUseCase(deps: MultipartDeps) {
  return async (input: {
    /** Bucket name for the multipart upload. */
    bucketName: string;
    /** S3 object key for the multipart upload. */
    key: string;
    /** Upload identifier returned by initiate. */
    uploadId: string;
    /** 1-based part number (1-10000). */
    partNumber: number;
    /** Raw part data. */
    body: Buffer;
  }): Promise<UploadPartResult | null> => {
    if (input.partNumber < 1 || input.partNumber > 10000) {
      throw new MultipartError(
        'InvalidArgument',
        'Part number must be an integer between 1 and 10000',
        400,
      );
    }

    const multipart = await deps.multipartRepo.findById(input.uploadId);
    if (!multipart || multipart.s3Key !== input.key) {
      return null;
    }

    if (input.body.byteLength > deps.config.telegramChunkSizeBytes) {
      throw new MultipartError(
        'EntityTooLarge',
        `Your proposed upload part size (${input.body.byteLength} bytes) exceeds the maximum allowed part size (${deps.config.telegramChunkSizeBytes} bytes) for this storage backend. Use smaller part sizes.`,
        400,
      );
    }

    const forwardResult = await deps.telegramService.forwardToStorage(
      input.body,
      `mp-${input.uploadId}-part-${input.partNumber}`,
      'document',
    );

    const etag = computeHash(input.body);

    await deps.multipartRepo.insertPart({
      uploadId: input.uploadId,
      partNumber: input.partNumber,
      telegramFileId: forwardResult.telegramFileId,
      telegramFileUniqueId: forwardResult.telegramFileUniqueId,
      storageMessageId: forwardResult.storageMessageId,
      sizeBytes: input.body.byteLength,
      etag,
    });

    return { etag: `"${etag}"` };
  };
}

/**
 * Error type for multipart-level application errors.
 */
export class MultipartError extends Error {
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
    this.name = 'MultipartError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Creates a use case that completes an S3 multipart upload.
 *
 * Validates the submitted part list (all parts must be present and in ascending
 * order), creates the final file record referencing the first part's Telegram
 * data, marks the upload session as completed, and returns the combined result.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting upload details and submitted parts,
 *          returning the completion result, or `null` when the upload session
 *          is not found.
 */
export function createCompleteMultipartUploadUseCase(deps: MultipartDeps) {
  return async (input: {
    /** Bucket name for the multipart upload. */
    bucketName: string;
    /** S3 object key for the multipart upload. */
    key: string;
    /** Upload identifier. */
    uploadId: string;
    /** Parts submitted by the client (in ascending part number order). */
    parts: CompletePartInput[];
  }): Promise<CompleteMultipartResult | null> => {
    const multipart = await deps.multipartRepo.findById(input.uploadId);
    if (!multipart) return null;

    const storedParts = await deps.multipartRepo.listParts(input.uploadId);

    // Validate ascending part order
    const partNumbers = input.parts.map((p) => p.partNumber);
    if (partNumbers.length > 1 && partNumbers.some((n, i) => i > 0 && n <= partNumbers[i - 1])) {
      throw new MultipartError(
        'InvalidPartOrder',
        'The list of parts was not in ascending order.',
        400,
      );
    }

    // Validate part count matches
    if (input.parts.length !== storedParts.length) {
      throw new MultipartError(
        'InvalidPart',
        'One or more specified parts could not be found.',
        400,
      );
    }

    const totalSize = storedParts.reduce((sum, p) => sum + p.sizeBytes, 0);
    const firstPart = storedParts[0];
    if (!firstPart) {
      throw new MultipartError('InternalError', 'Multipart object has no parts.', 500);
    }

    const publicId = nanoid();

    await deps.fileRepo.create({
      publicId,
      telegramFileId: firstPart.telegramFileId,
      telegramFileUniqueId: firstPart.telegramFileUniqueId,
      storageChatId: deps.config.storageChatId,
      storageMessageId: firstPart.storageMessageId,
      fileName: input.key.split('/').pop() || 'file',
      mimeType: 'application/octet-stream',
      sizeBytes: totalSize,
      fileType: 'document',
      uploaderId: 0,
      fileHash: null,
      archiveTelegramFileId: null,
      archiveStorageMessageId: null,
      archiveFileName: null,
      archiveEntryName: null,
      archiveMimeType: null,
      archiveSizeBytes: null,
      bucketId: multipart.bucketId,
      s3Key: input.key,
      storageBackend: 'telegram',
      isDeleted: false,
      multipartUploadId: input.uploadId,
      partCount: null,
    });

    await deps.multipartRepo.complete(input.uploadId);

    const location = `${deps.config.baseUrl}/${input.bucketName}/${input.key}`;
    const combinedEtag = storedParts.map((p) => p.etag).join('-');

    return {
      publicId,
      location,
      etag: combinedEtag,
      sizeBytes: totalSize,
    };
  };
}

/**
 * Creates a use case that aborts an S3 multipart upload.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting an upload identifier, returning `true`
 *          when the upload was aborted, or `null` when the upload session
 *          is not found.
 */
export function createAbortMultipartUploadUseCase(deps: MultipartDeps) {
  return async (uploadId: string): Promise<boolean | null> => {
    const multipart = await deps.multipartRepo.findById(uploadId);
    if (!multipart) return null;

    await deps.multipartRepo.abort(uploadId);
    return true;
  };
}

/**
 * Creates a use case that lists in-progress multipart uploads within a bucket.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting query parameters and returning the
 *          listing result, or `null` when the bucket is not found.
 */
export function createListMultipartUploadsUseCase(deps: MultipartDeps) {
  return async (input: {
    /** Bucket name to list uploads from. */
    bucketName: string;
    /** Maximum number of uploads to return (clamped 1-1000). */
    maxUploads: number;
    /** Return only uploads whose S3 key is strictly greater than this, or null. */
    keyMarker: string | null;
  }): Promise<ListMultipartUploadsResult | null> => {
    const bucket = await deps.bucketRepo.findByName(input.bucketName);
    if (!bucket) return null;

    return deps.multipartRepo.listByBucket(bucket.id, input.maxUploads, input.keyMarker);
  };
}

/**
 * Creates a use case that lists parts of a specific multipart upload.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting an upload identifier and returning the
 *          list of parts, or `null` when the upload session is not found.
 */
export function createListPartsUseCase(deps: MultipartDeps) {
  return async (uploadId: string): Promise<PartSummary[] | null> => {
    const multipart = await deps.multipartRepo.findById(uploadId);
    if (!multipart) return null;

    const parts = await deps.multipartRepo.listParts(uploadId);

    return parts.map((p) => ({
      partNumber: p.partNumber,
      etag: p.etag,
      sizeBytes: p.sizeBytes,
      createdAt: p.createdAt,
    }));
  };
}
