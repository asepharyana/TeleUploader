import type { Bucket } from '../entities/bucket';

/**
 * Repository interface for Bucket entity persistence.
 *
 * Abstracts the bucket CRUD operations currently in `src/db/buckets.ts`.
 */
export interface IBucketRepository {
  /**
   * Create a new bucket with the given name.
   * @param name - The unique bucket name (S3 naming convention).
   * @returns The newly created bucket record.
   */
  create(name: string): Promise<Bucket>;

  /**
   * Find a bucket by its unique name.
   * @param name - The bucket name to look up.
   * @returns The matching bucket, or `null` when not found.
   */
  findByName(name: string): Promise<Bucket | null>;

  /**
   * List all buckets, ordered alphabetically by name.
   * @returns An array of all bucket records.
   */
  list(): Promise<Bucket[]>;

  /**
   * Delete a bucket and cascade-delete all associated files and multipart data.
   * @param name - The name of the bucket to delete.
   * @returns `true` if the bucket was deleted, `false` if it did not exist.
   */
  delete(name: string): Promise<boolean>;

  /**
   * Check whether a bucket with the given name exists.
   * @param name - The bucket name to check.
   * @returns `true` if the bucket exists, `false` otherwise.
   */
  exists(name: string): Promise<boolean>;
}
