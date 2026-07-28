/**
 * Input for creating a new bucket.
 */
export interface CreateBucketInput {
  /** Bucket name (must match S3 naming rules: 3-63 chars, lowercase, no underscore) */
  name: string;
}

/**
 * Single bucket representation returned by bucket endpoints.
 */
export interface BucketResponse {
  /** Bucket UUID */
  id: string;
  /** Bucket name */
  name: string;
  /** ISO-8601 timestamp of when the bucket was created */
  createdAt: string;
  /** Number of non-deleted objects in the bucket */
  objectCount?: number;
}

/**
 * Response payload for the list-buckets endpoint.
 */
export interface BucketListResponse {
  /** Array of buckets */
  buckets: BucketResponse[];
}

/**
 * Response payload for bucket creation.
 */
export interface CreateBucketResponse {
  /** Bucket UUID */
  id: string;
  /** Bucket name */
  name: string;
}

/**
 * Response payload for bucket deletion.
 */
export interface DeleteBucketResponse {
  /** Whether the deletion succeeded */
  success: boolean;
}
