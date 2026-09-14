import { config } from '../../../../env';
import logger from '../../../../shared/logger/index';
import { getErrorMessage } from '../../../../shared/utils/file';
import { verifyPresignedUrl, verifySignature } from '../../../s3/auth';
import { S3_CORS_HEADERS } from '../../../s3/headers';
import { s3ErrorResponse } from '../../../s3/xml';
import {
  handleCreateBucket,
  handleDeleteBucket,
  handleGetBucketVersioning,
  handleHeadBucket,
  handleListBuckets,
} from './s3-bucket-handlers';
import { REGION, REQUEST_ID, s3Response } from './s3-common';
import { handleListObjectsV1, handleListObjectsV2 } from './s3-listing';
import {
  handleAbortMultipartUpload,
  handleCompleteMultipartUpload,
  handleCreateMultipartUpload,
  handleListMultipartUploads,
  handleListParts,
  handleUploadPart,
} from './s3-multipart-handlers';
import { handleGetObject, handleHeadObject } from './s3-object-read';
import { handleDeleteObject, handleDeleteObjects, handlePutObject } from './s3-object-write';

/**
 * Builds an S3 OPTIONS preflight response with CORS headers.
 *
 * @returns A 204 No Content Response.
 */
export const s3OptionsResponse = (): Response =>
  new Response(null, { status: 204, headers: S3_CORS_HEADERS });

/**
 * Parses an S3 pathname into bucket and key components.
 *
 * Supports path-style URLs such as `/bucket-name/key/with/prefix`.
 *
 * @param pathname - The URL pathname.
 * @returns An object with the extracted bucket and key (both may be null).
 */
export const parseS3Path = (pathname: string): { bucket: string | null; key: string | null } => {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { bucket: null, key: null };
  if (parts.length === 1) return { bucket: parts[0], key: null };
  // Decode URI components to match virtual-hosted behavior (H10)
  const key = parts
    .slice(1)
    .map((segment) => decodeURIComponent(segment))
    .join('/');
  return { bucket: parts[0], key };
};

/**
 * Converts a Request's headers into a plain key-value record (all keys
 * lowercased) for SigV4 signature verification.
 *
 * @param req - The incoming HTTP request.
 * @returns A record of lowercased header key-value pairs.
 */
export const headersToRecord = (req: Request): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) {
    record[key.toLowerCase()] = value;
  }
  return record;
};

/**
 * Main S3 request dispatcher.
 *
 * Parses the request (method, path, query parameters, headers), validates
 * the SigV4 signature or presigned URL, and dispatches to the appropriate
 * bucket, object, or multipart operation handler.
 *
 * Supports both path-style (`/bucket/key`) and virtual-hosted-style
 * (`bucket.example.com/key`) addressing.
 *
 * @param req - The incoming S3 HTTP request.
 * @param virtualHostBucket - When the request was routed through a
 *                            virtual-hosted domain, the extracted bucket
 *                            name; otherwise `null`.
 * @returns An S3-formatted Response.
 */
export const handleS3Request = async (
  req: Request,
  virtualHostBucket: string | null = null,
): Promise<Response> => {
  const method = req.method;
  const url = new URL(req.url);
  const pathname = url.pathname;
  const { bucket, key } = virtualHostBucket
    ? {
        bucket: virtualHostBucket,
        key: pathname === '/' ? null : decodeURIComponent(pathname.slice(1)),
      }
    : parseS3Path(pathname);
  const headers = headersToRecord(req);
  const searchParams = url.searchParams;
  const reqId = REQUEST_ID();

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return s3OptionsResponse();
  }

  // SigV4 authentication
  const isPresigned = searchParams.has('X-Amz-Signature');
  const authResult = isPresigned
    ? await verifyPresignedUrl({
        url: req.url,
        method,
        headers,
        s3AccessKey: config.s3AccessKey,
        s3SecretKey: config.s3SecretKey,
        region: REGION,
      })
    : await verifySignature(
        method,
        req.url,
        headers,
        null,
        config.s3AccessKey,
        config.s3SecretKey,
        REGION,
      );

  if (!authResult.isValid) {
    const status = authResult.errorCode === 'NotImplemented' ? 501 : 403;
    const message =
      authResult.errorCode === 'NotImplemented'
        ? 'aws-chunked streaming payloads are not supported.'
        : isPresigned
          ? 'Presigned URL verification failed'
          : 'Authentication required';
    return s3ErrorResponse(
      authResult.errorCode || 'AccessDenied',
      message,
      pathname,
      status,
      reqId,
    );
  }

  try {
    // ── Root: ListBuckets / Service-level operations ──
    if (!bucket) {
      if (method === 'GET') {
        return handleListBuckets(reqId);
      }
      return s3ErrorResponse(
        'MethodNotAllowed',
        'The specified method is not allowed against this resource.',
        '/',
        405,
        reqId,
      );
    }

    // ── Bucket-level operations ──
    if (!key) {
      if (method === 'GET') {
        if (searchParams.has('versioning')) {
          return handleGetBucketVersioning(bucket, reqId);
        }
        if (searchParams.has('uploads')) {
          return handleListMultipartUploads(bucket, searchParams, reqId);
        }
        const listType = searchParams.get('list-type');
        if (listType === '2') {
          return handleListObjectsV2(bucket, searchParams, reqId);
        }
        return handleListObjectsV1(bucket, searchParams, reqId);
      }
      if (method === 'PUT') return handleCreateBucket(bucket, reqId);
      if (method === 'HEAD') return handleHeadBucket(bucket, reqId);
      if (method === 'DELETE') return handleDeleteBucket(bucket, reqId);
      if (method === 'POST') {
        if (searchParams.has('delete')) {
          const body = await req.text();
          return handleDeleteObjects(bucket, body, reqId);
        }
        if (searchParams.has('tagging')) {
          return s3Response(null, 204, reqId);
        }
      }
      return s3ErrorResponse(
        'MethodNotAllowed',
        'The specified method is not allowed against this resource.',
        `/${bucket}`,
        405,
        reqId,
      );
    }

    // ── Object-level: Multipart operations ──
    if (searchParams.has('uploads') && method === 'POST') {
      return handleCreateMultipartUpload(bucket, key, searchParams, headers, reqId);
    }
    if (searchParams.has('uploadId') && searchParams.has('partNumber') && method === 'PUT') {
      return handleUploadPart(bucket, key, searchParams, req, reqId);
    }
    if (searchParams.has('uploadId') && method === 'POST') {
      const body = await req.text();
      return handleCompleteMultipartUpload(bucket, key, searchParams, body, reqId);
    }
    if (searchParams.has('uploadId') && method === 'DELETE') {
      return handleAbortMultipartUpload(bucket, key, searchParams, reqId);
    }
    if (searchParams.has('uploadId') && method === 'GET') {
      return handleListParts(bucket, key, searchParams, reqId);
    }

    // ── Standard object operations ──
    if (method === 'GET') return handleGetObject(bucket, key, searchParams, headers, reqId);
    if (method === 'HEAD') return handleHeadObject(bucket, key, headers, reqId);
    if (method === 'PUT') return handlePutObject(bucket, key, searchParams, headers, req, reqId);
    if (method === 'DELETE') return handleDeleteObject(bucket, key, reqId);

    return s3ErrorResponse(
      'MethodNotAllowed',
      'The specified method is not allowed against this resource.',
      `/${bucket}/${key}`,
      405,
      reqId,
    );
  } catch (error: unknown) {
    logger.error('S3 operation error', { bucket, key, error: getErrorMessage(error) });
    return s3ErrorResponse(
      'InternalError',
      'We encountered an internal error. Please try again.',
      pathname,
      500,
      reqId,
    );
  }
};
