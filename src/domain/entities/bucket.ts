/**
 * Core domain entity representing an S3-compatible storage bucket.
 * Buckets group objects for the S3-compatible API layer.
 */
export interface Bucket {
  /** Primary key, UUID */
  id: string;
  /** Bucket name (unique, max 63 chars, S3 naming convention) */
  name: string;
  /** Record creation timestamp */
  createdAt: Date;
  /** Record last-updated timestamp */
  updatedAt: Date;
}
