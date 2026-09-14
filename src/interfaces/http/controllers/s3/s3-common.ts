import { nanoid } from 'nanoid';
import type { Bucket } from '../../../../domain/entities/bucket';
import type { MultipartUpload } from '../../../../domain/entities/multipart';
import type { IBucketRepository } from '../../../../domain/ports/bucket-repository';
import type { IMultipartRepository } from '../../../../domain/ports/multipart-repository';
import { config } from '../../../../env';
import { s3Headers } from '../../../s3/headers';
import { unsatisfiedContentRange } from '../../../s3/range';
import { s3ErrorResponse } from '../../../s3/xml';

/**
 * The default S3 region returned when no region is explicitly configured.
 */
export const REGION = config.s3DefaultRegion || 'us-east-1';

/**
 * Generates a unique request identifier for S3 responses.
 *
 * @returns A hex string suitable for x-amz-request-id and x-amz-id-2.
 */
export const REQUEST_ID = (): string => nanoid(16);

/**
 * Builds a standard S3 response with the appropriate headers.
 *
 * @param body - The XML or empty response body.
 * @param status - HTTP status code.
 * @param reqId - The request identifier for S3 headers.
 * @param extraHeaders - Optional extra response headers.
 * @returns An S3-formatted Response.
 */
export const s3Response = (
  body: string | null,
  status: number,
  reqId: string,
  extraHeaders: Record<string, string> = {},
): Response => {
  // Add content-type for empty 200-series responses (not 204 which has no body)
  if (
    body === null &&
    status >= 200 &&
    status < 300 &&
    status !== 204 &&
    !extraHeaders['content-type']
  ) {
    extraHeaders['content-type'] = 'application/xml';
  }
  return new Response(body, { status, headers: s3Headers(reqId, extraHeaders) });
};

/**
 * Resolves a bucket by name, returning a `NoSuchBucket` S3 error when missing.
 *
 * Replaces the ~10 identical `findByName` + `NoSuchBucket` blocks previously
 * inlined in every bucket/object/listing/multipart handler.
 *
 * @param bucketRepo - The bucket repository to look up.
 * @param bucket - The bucket name from the request path.
 * @param path - The request path for the S3 error resource.
 * @param reqId - The request identifier for S3 headers.
 * @returns The bucket record, or an S3 error Response when not found.
 */
export const resolveBucketOr404 = async (
  bucketRepo: IBucketRepository,
  bucket: string,
  path: string,
  reqId: string,
): Promise<Bucket | Response> => {
  const bucketRecord = await bucketRepo.findByName(bucket);
  if (!bucketRecord) {
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      path,
      404,
      reqId,
    );
  }
  return bucketRecord;
};

/**
 * Resolves an in-progress multipart upload, returning a `NoSuchUpload` S3
 * error when missing.
 *
 * Replaces the 5 identical `findById` + `NoSuchUpload` blocks previously
 * inlined in the multipart handlers. Pass `key` for the H5 key-match check
 * (UploadPart / CompleteMultipartUpload); omit it for Abort / ListParts,
 * which historically only checked existence.
 *
 * @param multipartRepo - The multipart repository to look up.
 * @param uploadId - The upload identifier from `?uploadId=`.
 * @param path - The request path for the S3 error resource.
 * @param reqId - The request identifier for S3 headers.
 * @param key - Optional object key the upload must belong to.
 * @returns The upload record, or an S3 error Response when not found.
 */
export const requireUploadOr404 = async (
  multipartRepo: IMultipartRepository,
  uploadId: string,
  path: string,
  reqId: string,
  key?: string,
): Promise<MultipartUpload | Response> => {
  const multipart = await multipartRepo.findById(uploadId);
  if (!multipart || (key !== undefined && multipart.s3Key !== key)) {
    return s3ErrorResponse(
      'NoSuchUpload',
      'The specified upload does not exist.',
      path,
      404,
      reqId,
    );
  }
  return multipart;
};

/**
 * Returns the stable S3 etag for a file, falling back to a random ID when
 * the record has no content hash yet.
 *
 * Replaces the 4 inline `file.fileHash || nanoid(16)` fallbacks (conditional
 * headers, HeadObject, copy result, list entries). Callers add quotes where
 * the transport needs them. The copy-source check keeps its own inline
 * `telegramFileId` variant (M9) with a comment at the call site.
 *
 * @param fileHash - The stored SHA-256 content hash (may be null).
 * @returns The hash, or a random 16-char fallback.
 */
export const etagOrFallback = (fileHash: string | null): string => fileHash || nanoid(16);

/**
 * Builds the shared 416 response for unsatisfiable Range requests.
 *
 * Replaces the 3 identical `InvalidRange` blocks (chunked GET, regular GET,
 * multipart GET).
 *
 * @param path - The request path for the S3 error resource.
 * @param totalSize - The total object size for the Content-Range header.
 * @param reqId - The request identifier for S3 headers.
 * @returns A 416 S3 error Response.
 */
export const invalidRangeResponse = (path: string, totalSize: number, reqId: string): Response =>
  s3ErrorResponse('InvalidRange', 'The requested range is not satisfiable.', path, 416, reqId, {
    'content-range': unsatisfiedContentRange(totalSize),
  });
