import type { Bucket } from '../../domain/entities/bucket';
import type { IBucketRepository } from '../../domain/ports/bucket-repository';
import type { IFileRepository } from '../../domain/ports/file-repository';

/**
 * S3 bucket name validation regex.
 *
 * Bucket names must be 3-63 characters, start/end with a lowercase letter or
 * digit, and contain only lowercase letters, digits, dots, and hyphens.
 */
const BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Error type for bucket-level application errors that carry an S3-compatible
 * error code and an HTTP status suggestion.
 */
export class BucketError extends Error {
  /** S3-compatible error code (e.g. "NoSuchBucket", "BucketAlreadyExists"). */
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
    this.name = 'BucketError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Describes a bucket entry returned by the list-buckets use case,
 * enriched with the current count of non-deleted objects.
 */
export interface BucketWithCount {
  /** The bucket domain entity. */
  bucket: Bucket;
  /** Number of non-deleted objects in the bucket. */
  objectCount: number;
}

/** Dependencies required by the manage-bucket use case factories. */
export interface ManageBucketDeps {
  /** Bucket repository for CRUD operations. */
  bucketRepo: IBucketRepository;
  /** File repository for counting and checking objects within buckets. */
  fileRepo: IFileRepository;
}

/**
 * Creates a use case that lists all buckets together with their object counts.
 *
 * @param deps - The injected dependencies.
 * @returns An async function that returns a list of buckets with counts.
 */
export function createListBucketsUseCase(deps: ManageBucketDeps) {
  return async (): Promise<BucketWithCount[]> => {
    const buckets = await deps.bucketRepo.list();
    const results = await Promise.all(
      buckets.map(async (bucket) => ({
        bucket,
        objectCount: await deps.fileRepo.countByBucket(bucket.id),
      })),
    );
    return results;
  };
}

/**
 * Creates a use case that retrieves a single bucket by its name.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting a bucket name and returning the
 *          bucket, or `null` when not found.
 */
export function createGetBucketUseCase(deps: ManageBucketDeps) {
  return async (name: string): Promise<Bucket | null> => {
    return deps.bucketRepo.findByName(name);
  };
}

/**
 * Creates a use case that creates a new bucket.
 *
 * Validates the bucket name format and checks for duplicates before
 * persisting.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting a bucket name and returning the
 *          newly created bucket.
 * @throws {BucketError} When the name is invalid or the bucket already exists.
 */
export function createCreateBucketUseCase(deps: ManageBucketDeps) {
  return async (name: string): Promise<Bucket> => {
    if (!BUCKET_NAME_REGEX.test(name)) {
      throw new BucketError(
        'InvalidBucketName',
        'The specified bucket is not valid.',
        400,
      );
    }

    const existing = await deps.bucketRepo.findByName(name);
    if (existing) {
      throw new BucketError(
        'BucketAlreadyExists',
        'The requested bucket name is not available.',
        409,
      );
    }

    return deps.bucketRepo.create(name);
  };
}

/**
 * Creates a use case that deletes a bucket.
 *
 * Ensures the bucket exists and is empty (no non-deleted objects) before
 * proceeding with deletion.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting a bucket name. Returns `true` when
 *          the bucket was deleted, throws when the bucket is missing or
 *          not empty.
 * @throws {BucketError} When the bucket does not exist or is not empty.
 */
export function createDeleteBucketUseCase(deps: ManageBucketDeps) {
  return async (name: string): Promise<boolean> => {
    const bucket = await deps.bucketRepo.findByName(name);
    if (!bucket) {
      throw new BucketError(
        'NoSuchBucket',
        'The specified bucket does not exist.',
        404,
      );
    }

    const objectCount = await deps.fileRepo.countByBucket(bucket.id);
    if (objectCount > 0) {
      throw new BucketError(
        'BucketNotEmpty',
        'The bucket you tried to delete is not empty.',
        409,
      );
    }

    return deps.bucketRepo.delete(name);
  };
}

/**
 * Creates a use case that checks whether a bucket exists.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting a bucket name and returning `true`
 *          when the bucket exists.
 */
export function createBucketExistsUseCase(deps: ManageBucketDeps) {
  return async (name: string): Promise<boolean> => {
    return deps.bucketRepo.exists(name);
  };
}