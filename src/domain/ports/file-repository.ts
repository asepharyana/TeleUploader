import type { File, NewFile } from '../entities/file';

/**
 * An S3-synced file record: a File entity guaranteed to have non-null
 * bucketId and s3Key values.
 */
export interface S3FileRecord extends File {
  /** S3 bucket UUID (non-null refinement) */
  bucketId: string;
  /** S3 object key (non-null refinement) */
  s3Key: string;
}

/**
 * Repository interface for File entity persistence.
 *
 * Abstracts all file CRUD operations currently spread across
 * `src/db/files.ts` and `src/db/files-ext.ts`.
 */
export interface IFileRepository {
  /**
   * Find a single file by its SHA-256 content hash.
   * @param hash - The SHA-256 hash to search for.
   * @returns The matching file, or `null` when not found.
   */
  findByHash(hash: string): Promise<File | null>;

  /**
   * Find a single file by its public-facing short identifier.
   * @param publicId - The public ID to look up.
   * @returns The matching file, or `null` when not found.
   */
  findByPublicId(publicId: string): Promise<File | null>;

  /**
   * Find a single file by its Telegram file unique ID (stable across bot tokens).
   * @param telegramFileUniqueId - The Telegram unique file ID.
   * @returns The matching file, or `null` when not found.
   */
  findByUniqueId(telegramFileUniqueId: string): Promise<File | null>;

  /**
   * Find a single file by its S3 bucket and object key.
   * @param bucketId - The bucket UUID.
   * @param s3Key - The S3 object key.
   * @returns The matching file, or `null` when not found.
   */
  findByBucketAndKey(bucketId: string, s3Key: string): Promise<File | null>;

  /**
   * Create a new file record.
   * @param file - The file data (auto-generated fields omitted).
   * @returns The newly created file record with all fields populated.
   */
  create(file: NewFile): Promise<File>;

  /**
   * List objects within a bucket, optionally filtered by prefix and delimiter.
   *
   * When `delimiter` is `"/"`, common prefixes (pseudo-directories) are
   * returned separately and objects whose key continues past the delimiter
   * are omitted from the `objects` array.
   *
   * @param bucketId - The bucket UUID to list from.
   * @param prefix - Key prefix to filter by.
   * @param delimiter - Delimiter character (e.g. `"/"`) or `null` for flat listing.
   * @param maxKeys - Maximum number of object records to return.
   * @param startAfter - Return only keys strictly greater than this value, or `null`.
   * @returns A list of matching S3 file records and discovered common prefixes.
   */
  listByPrefix(
    bucketId: string,
    prefix: string,
    delimiter: string | null,
    maxKeys: number,
    startAfter: string | null,
  ): Promise<{ objects: S3FileRecord[]; prefixes: string[] }>;

  /**
   * Soft-delete a single file by bucket and key.
   * @param bucketId - The bucket UUID.
   * @param s3Key - The S3 object key.
   * @returns `true` if a row was soft-deleted, `false` otherwise.
   */
  softDelete(bucketId: string, s3Key: string): Promise<boolean>;

  /**
   * Soft-delete multiple files within a bucket in batch.
   * @param bucketId - The bucket UUID.
   * @param keys - Array of S3 object keys to delete.
   * @returns The number of rows actually soft-deleted.
   */
  softDeleteBatch(bucketId: string, keys: string[]): Promise<number>;

  /**
   * Count non-deleted objects in a bucket.
   * @param bucketId - The bucket UUID.
   * @returns The object count.
   */
  countByBucket(bucketId: string): Promise<number>;

  /**
   * Find soft-deleted (orphaned) file records in a bucket.
   * @param bucketId - The bucket UUID.
   * @returns An array of orphaned file records.
   */
  findOrphansByBucket(bucketId: string): Promise<File[]>;
}
