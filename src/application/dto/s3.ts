/**
 * A single S3 object as it appears in listing results.
 */
export interface S3ObjectResponse {
  /** The object key (full path within the bucket) */
  key: string;
  /** Stored file name (basename of the key) */
  fileName: string;
  /** MIME type of the stored object */
  mimeType: string;
  /** Object size in bytes */
  sizeBytes: number;
  /** High-level file category */
  fileType: string;
  /** SHA-256 hex digest of the object content */
  etag: string | null;
  /** ISO-8601 timestamp of last modification */
  lastModified: string;
  /** Public download URL */
  downloadUrl: string;
}

/**
 * Response payload for S3 ListObjectsV1 / ListObjectsV2.
 */
export interface S3ListObjectsResponse {
  /** Array of object summaries */
  objects: S3ObjectResponse[];
  /** Common prefixes when a delimiter was used (e.g. "folder/" entries) */
  prefixes: string[];
  /** Whether more results are available */
  isTruncated: boolean;
  /** Token to pass as continuation-token to retrieve the next page */
  nextContinuationToken: string | null;
}

/**
 * Input for the copy-object operation (Web API v1).
 */
export interface S3CopyObjectInput {
  /** Source object key within the same or source bucket */
  sourceKey: string;
  /** Destination bucket name; defaults to the source bucket when omitted */
  destBucket?: string;
  /** Destination object key */
  destKey: string;
}

/**
 * Response payload for the copy-object operation.
 */
export interface S3CopyObjectResponse {
  /** Source object key that was copied */
  sourceKey: string;
  /** Destination object key */
  destKey: string;
  /** Destination bucket name */
  destBucket: string;
}

/**
 * Summary of a multipart upload in listing results.
 */
export interface S3MultipartUploadResponse {
  /** The object key being uploaded */
  key: string;
  /** Upload identifier (nanoid) */
  uploadId: string;
  /** ISO-8601 timestamp when the upload was initiated */
  initiatedAt: Date;
  /** Identifier string of the upload initiator */
  initiatedBy: string;
}

/**
 * Summary of a single part within a multipart upload.
 */
export interface S3MultipartPartResponse {
  /** 1-indexed part number */
  partNumber: number;
  /** ETag of the part content */
  etag: string;
  /** Part size in bytes */
  sizeBytes: number;
  /** ISO-8601 timestamp when the part was stored */
  createdAt: Date;
}
