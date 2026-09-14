import { bucketRepository, fileRepository } from '../../../../infrastructure/di';
import { BucketNameSchema, parseOrNull } from '../../../../shared/validation/schemas';
import { bucketVersioningConfigurationXml, listBucketsXml, s3ErrorResponse } from '../../../s3/xml';
import { resolveBucketOr404, s3Response } from './s3-common';

// ─────── Bucket Operations ───────

/**
 * Handles GET / — lists all buckets as an S3 ListAllMyBuckets XML response.
 *
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML response with the bucket list.
 */
export const handleListBuckets = async (reqId: string): Promise<Response> => {
  const buckets = await bucketRepository.list();
  const xml = listBucketsXml(buckets, reqId);
  return s3Response(xml, 200, reqId, { 'content-type': 'application/xml' });
};

/**
 * Handles PUT /{bucket} — creates a new S3 bucket.
 *
 * Validates the bucket name format (BucketNameSchema, incl. the stricter M13
 * rules: no consecutive dots, no IP format, no `xn--` prefix) and checks for
 * duplicates.
 *
 * @param bucketName - The requested bucket name.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML response indicating success or failure.
 */
export const handleCreateBucket = async (bucketName: string, reqId: string): Promise<Response> => {
  if (parseOrNull(BucketNameSchema, bucketName) === null) {
    return s3ErrorResponse(
      'InvalidBucketName',
      'The specified bucket is not valid.',
      `/${bucketName}`,
      400,
      reqId,
    );
  }
  const existing = await bucketRepository.findByName(bucketName);
  if (existing) {
    return s3ErrorResponse(
      'BucketAlreadyExists',
      'The requested bucket name is not available.',
      `/${bucketName}`,
      409,
      reqId,
    );
  }
  await bucketRepository.create(bucketName);
  return s3Response(null, 200, reqId);
};

/**
 * Handles HEAD /{bucket} — checks whether a bucket exists.
 *
 * @param bucketName - The bucket name to check.
 * @param reqId - The request identifier for S3 headers.
 * @returns A 200 response when the bucket exists, or an S3 XML error.
 */
export const handleHeadBucket = async (bucketName: string, reqId: string): Promise<Response> => {
  const bucket = await resolveBucketOr404(bucketRepository, bucketName, `/${bucketName}`, reqId);
  if (bucket instanceof Response) return bucket;
  return s3Response(null, 200, reqId);
};

/**
 * Handles DELETE /{bucket} — deletes a bucket.
 *
 * Fails with `BucketNotEmpty` if the bucket still contains objects.
 *
 * @param bucketName - The bucket name to delete.
 * @param reqId - The request identifier for S3 headers.
 * @returns A 204 response on success, or an S3 XML error.
 */
export const handleDeleteBucket = async (bucketName: string, reqId: string): Promise<Response> => {
  const bucket = await resolveBucketOr404(bucketRepository, bucketName, `/${bucketName}`, reqId);
  if (bucket instanceof Response) return bucket;
  const objCount = await fileRepository.countByBucket(bucket.id);
  if (objCount > 0) {
    return s3ErrorResponse(
      'BucketNotEmpty',
      'The bucket you tried to delete is not empty.',
      `/${bucketName}`,
      409,
      reqId,
    );
  }
  await bucketRepository.delete(bucketName);
  return s3Response(null, 204, reqId);
};

/**
 * Handles GET /{bucket}?versioning — returns the bucket versioning
 * configuration (always disabled in this implementation).
 *
 * @param bucketName - The bucket name.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML response with the versioning configuration.
 */
export const handleGetBucketVersioning = async (
  bucketName: string,
  reqId: string,
): Promise<Response> => {
  const bucket = await resolveBucketOr404(bucketRepository, bucketName, `/${bucketName}`, reqId);
  if (bucket instanceof Response) return bucket;
  return s3Response(bucketVersioningConfigurationXml(), 200, reqId, {
    'content-type': 'application/xml',
  });
};
