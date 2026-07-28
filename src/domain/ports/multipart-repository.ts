import type { MultipartUpload, MultipartPart } from '../entities/multipart';

/**
 * Repository interface for S3 multipart upload persistence.
 *
 * Abstracts the multipart upload operations currently in `src/db/multipart.ts`.
 * Manages both multipart upload sessions and their individual parts.
 */
export interface IMultipartRepository {
  /**
   * Initiate a new multipart upload session.
   * @param bucketId - The UUID of the target bucket.
   * @param s3Key - The S3 object key being uploaded.
   * @param initiatedBy - Identifier of the entity that initiated the upload.
   * @returns The newly generated upload ID (nanoid).
   */
  create(bucketId: string, s3Key: string, initiatedBy: string): Promise<string>;

  /**
   * Find an in-progress multipart upload by its upload ID.
   * @param uploadId - The upload identifier.
   * @returns The matching upload, or `null` if not found or not in progress.
   */
  findById(uploadId: string): Promise<MultipartUpload | null>;

  /**
   * Mark a multipart upload as completed.
   * @param uploadId - The upload identifier to complete.
   */
  complete(uploadId: string): Promise<void>;

  /**
   * Mark a multipart upload as aborted.
   * @param uploadId - The upload identifier to abort.
   */
  abort(uploadId: string): Promise<void>;

  /**
   * Insert a single part record for a multipart upload.
   * @param part - The part data (auto-generated fields omitted).
   */
  insertPart(part: Omit<MultipartPart, 'id' | 'createdAt'>): Promise<void>;

  /**
   * List all parts for a multipart upload, ordered by part number.
   * @param uploadId - The upload identifier.
   * @returns An array of multipart parts.
   */
  listParts(uploadId: string): Promise<MultipartPart[]>;

  /**
   * List in-progress multipart uploads within a bucket, with pagination.
   *
   * Results are ordered by S3 key and initiation timestamp.
   *
   * @param bucketId - The UUID of the bucket.
   * @param maxUploads - Maximum number of uploads to return (clamped 1-1000).
   * @param keyMarker - Return only uploads whose S3 key is strictly greater than this, or `null`.
   * @returns A list of uploads and pagination metadata.
   */
  listByBucket(
    bucketId: string,
    maxUploads: number,
    keyMarker: string | null,
  ): Promise<{
    uploads: MultipartUpload[];
    isTruncated: boolean;
    nextKeyMarker: string | null;
  }>;
}
