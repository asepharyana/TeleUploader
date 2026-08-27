import { createReadStream } from 'node:fs';
import { nanoid } from 'nanoid';
import type { File as FileEntity } from '../../../domain/entities/file';
import { buildNewFile } from '../../../domain/entities/file-factory';
import type { ForwardResult } from '../../../domain/ports/telegram-service';
import { config } from '../../../env';
import {
  bucketRepository,
  chunkedStorage,
  fileRepository,
  multipartRepository,
} from '../../../infrastructure/di';
import { botPool } from '../../../infrastructure/telegram/bot-pool';
import logger from '../../../shared/logger/index';
import {
  cleanupTempFile,
  DEFAULT_FILE_TYPE,
  ensureExtension,
  getErrorMessage,
} from '../../../shared/utils/file';
import { streamToTemp } from '../../../shared/utils/temp-stream';
import { verifyBodyHash, verifyPresignedUrl, verifySignature } from '../../s3/auth';
import { S3_CORS_HEADERS, s3Headers } from '../../s3/headers';
import { createGetObjectResponse, type ObjectPartSource } from '../../s3/object-stream';
import { parseRangeHeader, unsatisfiedContentRange } from '../../s3/range';
import {
  bucketVersioningConfigurationXml,
  completeMultipartUploadXml,
  copyObjectResultXml,
  deleteResultXml,
  initiateMultipartUploadXml,
  listBucketResultXml,
  listBucketsXml,
  listBucketV2ResultXml,
  listMultipartUploadsXml,
  listPartsXml,
  parseCompleteMultipartBody,
  parseDeleteObjectsBody,
  s3ErrorResponse,
} from '../../s3/xml';

/**
 * The default S3 region returned when no region is explicitly configured.
 */
const REGION = config.s3DefaultRegion || 'us-east-1';

/**
 * Generates a unique request identifier for S3 responses.
 *
 * @returns A hex string suitable for x-amz-request-id and x-amz-id-2.
 */
const REQUEST_ID = (): string => nanoid(16);

/**
 * Builds a standard S3 response with the appropriate headers.
 *
 * @param body - The XML or empty response body.
 * @param status - HTTP status code.
 * @param reqId - The request identifier for S3 headers.
 * @param extraHeaders - Optional extra response headers.
 * @returns An S3-formatted Response.
 */
const s3Response = (
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
 * Builds an S3 OPTIONS preflight response with CORS headers.
 *
 * @returns A 204 No Content Response.
 */
const s3OptionsResponse = (): Response =>
  new Response(null, { status: 204, headers: S3_CORS_HEADERS });

/**
 * Parses an S3 pathname into bucket and key components.
 *
 * Supports path-style URLs such as `/bucket-name/key/with/prefix`.
 *
 * @param pathname - The URL pathname.
 * @returns An object with the extracted bucket and key (both may be null).
 */
const parseS3Path = (pathname: string): { bucket: string | null; key: string | null } => {
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
const headersToRecord = (req: Request): Record<string, string> => {
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

// ─────── Bucket Operations ───────

/**
 * Handles GET / — lists all buckets as an S3 ListAllMyBuckets XML response.
 *
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML response with the bucket list.
 */
const handleListBuckets = async (reqId: string): Promise<Response> => {
  const buckets = await bucketRepository.list();
  const xml = listBucketsXml(buckets, reqId);
  return s3Response(xml, 200, reqId, { 'content-type': 'application/xml' });
};

/**
 * Handles PUT /{bucket} — creates a new S3 bucket.
 *
 * Validates the bucket name format and checks for duplicates.
 *
 * @param bucketName - The requested bucket name.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML response indicating success or failure.
 */
const handleCreateBucket = async (bucketName: string, reqId: string): Promise<Response> => {
  // M13: Stricter bucket validation — no consecutive dots, no IP format, no xn-- prefix
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName) ||
    bucketName.includes('..') ||
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bucketName) ||
    bucketName.startsWith('xn--')
  ) {
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
const handleHeadBucket = async (bucketName: string, reqId: string): Promise<Response> => {
  const bucket = await bucketRepository.findByName(bucketName);
  if (!bucket) {
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucketName}`,
      404,
      reqId,
    );
  }
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
const handleDeleteBucket = async (bucketName: string, reqId: string): Promise<Response> => {
  const bucket = await bucketRepository.findByName(bucketName);
  if (!bucket) {
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucketName}`,
      404,
      reqId,
    );
  }
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
const handleGetBucketVersioning = async (bucketName: string, reqId: string): Promise<Response> => {
  const bucket = await bucketRepository.findByName(bucketName);
  if (!bucket) {
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucketName}`,
      404,
      reqId,
    );
  }
  return s3Response(bucketVersioningConfigurationXml(), 200, reqId, {
    'content-type': 'application/xml',
  });
};

// ─────── Conditional Headers Helper ──────

/**
 * S3-compatible response for 304 Not Modified.
 */
const notModifiedResponse = (
  reqId: string,
  etag: string,
  mimeType: string,
  sizeBytes: number,
  lastModified: Date,
): Response =>
  new Response(null, {
    status: 304,
    headers: s3Headers(reqId, {
      etag,
      'content-type': mimeType,
      'content-length': String(sizeBytes),
      'last-modified': lastModified.toUTCString(),
      'x-amz-version-id': 'null',
    }),
  });

/**
 * S3-compatible response for 412 Precondition Failed.
 */
const preconditionFailedResponse = (path: string, reqId: string): Response =>
  s3ErrorResponse(
    'PreconditionFailed',
    'At least one of the pre-conditions you specified did not hold.',
    path,
    412,
    reqId,
  );

/**
 * Checks conditional headers (If-Match, If-None-Match, If-Modified-Since,
 * If-Unmodified-Since) and returns a prepared Response if the condition
 * is not satisfied, or `null` to let the request proceed.
 *
 * @returns A 304 / 412 Response when a condition fails, or `null` to continue.
 */
const checkConditionalHeaders = (
  headers: Record<string, string>,
  file: {
    mimeType: string;
    sizeBytes: number;
    fileHash: string | null;
    createdAt: Date | string | number;
  },
  path: string,
  reqId: string,
): Response | null => {
  const etag = `"${file.fileHash || nanoid(16)}"`;
  const lastModified = file.createdAt instanceof Date ? file.createdAt : new Date(file.createdAt);

  // If-Match
  const ifMatch = headers['if-match'];
  if (ifMatch && ifMatch !== '*' && ifMatch !== etag) {
    return preconditionFailedResponse(path, reqId);
  }

  // If-None-Match
  const ifNoneMatch = headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    return notModifiedResponse(reqId, etag, file.mimeType, file.sizeBytes, lastModified);
  }

  // If-Modified-Since
  const ifModifiedSince = headers['if-modified-since'];
  if (ifModifiedSince) {
    const since = new Date(ifModifiedSince);
    if (!Number.isNaN(since.getTime()) && lastModified.getTime() <= since.getTime()) {
      return notModifiedResponse(reqId, etag, file.mimeType, file.sizeBytes, lastModified);
    }
  }

  // If-Unmodified-Since
  const ifUnmodifiedSince = headers['if-unmodified-since'];
  if (ifUnmodifiedSince) {
    const since = new Date(ifUnmodifiedSince);
    if (!Number.isNaN(since.getTime()) && lastModified.getTime() > since.getTime()) {
      return preconditionFailedResponse(path, reqId);
    }
  }

  return null;
};

// ─────── Object Operations ───────

/**
 * Handles GET /{bucket}/{key} — retrieves an S3 object.
 *
 * Supports chunked objects (streaming multi-part response), multipart
 * objects (assembled from a completed multipart upload), and regular
 * Telegram-stored objects (proxy streaming or 302 redirect depending
 * on configuration). HTTP Range headers are respected when present.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param _searchParams - URL query parameters (unused for GET).
 * @param headers - The request headers (used for Range and etag checks).
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 response with the object content or an error.
 */
const handleGetObject = async (
  bucket: string,
  key: string,
  _searchParams: URLSearchParams,
  headers: Record<string, string>,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await bucketRepository.findByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  const file = await fileRepository.findByBucketAndKey(bucketRecord.id, key);
  if (!file)
    return s3ErrorResponse(
      'NoSuchKey',
      'The specified key does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  // H3: Conditional headers — If-Match / If-None-Match / If-Modified-Since / If-Unmodified-Since
  const conditionResult = checkConditionalHeaders(headers, file, `/${bucket}/${key}`, reqId);
  if (conditionResult) {
    return conditionResult;
  }

  // Chunked storage object
  if (file.storageBackend === 'chunked') {
    const totalSize = Number(file.sizeBytes);
    const range = parseRangeHeader(headers.range || null, totalSize);
    if (range.type === 'invalid') {
      return s3ErrorResponse(
        'InvalidRange',
        'The requested range is not satisfiable.',
        `/${bucket}/${key}`,
        416,
        reqId,
        {
          'content-range': unsatisfiedContentRange(totalSize),
        },
      );
    }
    try {
      return await chunkedStorage.createChunkedObjectResponse({ file, range, reqId });
    } catch (error) {
      logger.warn('Chunked object content fetch failed', { key, error: getErrorMessage(error) });
      return s3ErrorResponse(
        'InternalError',
        'Failed to fetch object content from storage',
        `/${bucket}/${key}`,
        502,
        reqId,
      );
    }
  }

  // Multipart upload assembled object
  if (file.multipartUploadId) {
    return handleGetMultipartObject(file, bucket, key, headers, reqId);
  }

  // Regular Telegram object
  const fileInfo = await botPool.getFileInfo(file.telegramFileId);
  const telegramUrl = `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`;

  const totalSize = file.sizeBytes;
  const range = parseRangeHeader(headers.range || null, totalSize);
  if (range.type === 'invalid') {
    return s3ErrorResponse(
      'InvalidRange',
      'The requested range is not satisfiable.',
      `/${bucket}/${key}`,
      416,
      reqId,
      {
        'content-range': unsatisfiedContentRange(totalSize),
      },
    );
  }

  // H1: Always proxy S3 GETs to avoid leaking the Telegram bot token
  // in redirect URLs. The 302 redirect path is removed because the
  // URL contains the bot_token — exposing it to clients is a security risk.

  const part: ObjectPartSource = {
    telegramFileId: file.telegramFileId,
    telegramUrl,
    sizeBytes: file.sizeBytes,
    partNumber: 1,
  };

  try {
    return await createGetObjectResponse({
      reqId,
      contentType: file.mimeType,
      etag: file.fileHash || '',
      lastModified: file.createdAt instanceof Date ? file.createdAt : new Date(file.createdAt),
      totalSize: file.sizeBytes,
      parts: [part],
      range,
    });
  } catch (error) {
    logger.warn('Telegram content fetch failed', {
      fileId: file.telegramFileId,
      error: getErrorMessage(error),
    });
    return s3ErrorResponse(
      'InternalError',
      'Failed to fetch object content from storage',
      `/${bucket}/${key}`,
      502,
      reqId,
    );
  }
};

/**
 * Handles GET for objects assembled from a completed multipart upload.
 *
 * Resolves the Telegram CDN URLs for each part and builds a multi-part
 * streaming response, respecting HTTP Range headers.
 *
 * @param file - The file entity with a `multipartUploadId` reference.
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param headers - The request headers (for Range parsing).
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 response streaming the assembled object content.
 */
const handleGetMultipartObject = async (
  file: FileEntity,
  bucket: string,
  key: string,
  headers: Record<string, string>,
  reqId: string,
): Promise<Response> => {
  const uploadId = file.multipartUploadId!;
  const parts = await multipartRepository.listParts(uploadId);

  if (parts.length === 0) {
    return s3ErrorResponse(
      'InternalError',
      'Multipart object has no parts.',
      `/${bucket}/${key}`,
      500,
      reqId,
    );
  }

  const totalSize = parts.reduce((sum, p) => sum + Number(p.sizeBytes), 0);
  const range = parseRangeHeader(headers.range || null, totalSize);
  if (range.type === 'invalid') {
    return s3ErrorResponse(
      'InvalidRange',
      'The requested range is not satisfiable.',
      `/${bucket}/${key}`,
      416,
      reqId,
      {
        'content-range': unsatisfiedContentRange(totalSize),
      },
    );
  }

  const sources: ObjectPartSource[] = [];
  // Resolve all part CDN URLs concurrently (independent getFile calls) so
  // assembly latency is ~1 round-trip instead of N.
  sources.push(
    ...(await Promise.all(
      parts.map(async (part) => {
        const fileInfo = await botPool.getFileInfo(part.telegramFileId);
        return {
          telegramFileId: part.telegramFileId,
          telegramUrl: `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`,
          sizeBytes: part.sizeBytes,
          partNumber: part.partNumber,
        };
      }),
    )),
  );

  // H1: Always proxy — never expose bot token in redirect URL

  try {
    return await createGetObjectResponse({
      reqId,
      contentType: file.mimeType,
      etag: file.fileHash || parts.map((p) => p.etag).join('-'),
      lastModified: file.createdAt instanceof Date ? file.createdAt : new Date(file.createdAt),
      totalSize,
      parts: sources,
      range,
    });
  } catch (error) {
    logger.warn('Telegram multipart content fetch failed', {
      uploadId: file.multipartUploadId,
      error: getErrorMessage(error),
    });
    return s3ErrorResponse(
      'InternalError',
      'Failed to fetch object content from storage',
      `/${bucket}/${key}`,
      502,
      reqId,
    );
  }
};

/**
 * Handles HEAD /{bucket}/{key} — returns object metadata without the body.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 response with object metadata headers.
 */
const handleHeadObject = async (
  bucket: string,
  key: string,
  headers: Record<string, string>,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await bucketRepository.findByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  const file = await fileRepository.findByBucketAndKey(bucketRecord.id, key);
  if (!file)
    return s3ErrorResponse(
      'NoSuchKey',
      'The specified key does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  // H3: Conditional headers for HEAD — If-Match / If-None-Match / If-Modified-Since / If-Unmodified-Since
  const headConditionResult = checkConditionalHeaders(headers, file, `/${bucket}/${key}`, reqId);
  if (headConditionResult) {
    return headConditionResult;
  }

  return s3Response(null, 200, reqId, {
    'content-type': file.mimeType,
    'content-length': String(file.sizeBytes),
    etag: `"${file.fileHash || nanoid(16)}"`,
    'last-modified':
      file.createdAt instanceof Date ? file.createdAt.toUTCString() : new Date().toUTCString(),
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000',
    'x-amz-version-id': 'null',
  });
};

/**
 * Streams the request body to a temporary file while computing its SHA-256
 * and MD5 hashes.
 *
 * Unlike `req.arrayBuffer()`, this approach uses O(1) memory regardless of
 * file size, making it safe for multi-GB Docker registry layer blobs.
 *
 * MD5 is computed alongside SHA-256 so that Content-MD5 verification (when
 * the header is present) does not need to re-read the entire file.
 *
 * @param body - The ReadableStream from the HTTP request body.
 * @returns The temp file path, SHA-256 hash, MD5 hash (base64), total size, and signature bytes.
 */
const streamBodyToTemp = async (
  body: ReadableStream<Uint8Array> | null,
): Promise<{
  tempPath: string;
  fileHash: string;
  md5Hash?: string;
  sizeBytes: number;
  signatureBuffer: Buffer;
}> => {
  const reader = (
    body ??
    new ReadableStream({
      start(c) {
        c.close();
      },
    })
  ).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  return streamToTemp(reader, { computeMd5: true, prefix: '/tmp/filedrop-s3-' });
};

/**
 * Handles PUT /{bucket}/{key} — uploads an S3 object.
 *
 * Streams the request body directly to a temporary file to avoid buffering
 * the entire payload in memory. This is essential for supporting large
 * Docker registry layer blobs (100MB–2GB+).
 *
 * Supports regular binary uploads, copy-object via `x-amz-copy-source`,
 * and tag operations. Large files are stored as chunked objects (across
 * multiple Telegram messages), while smaller files use a single Telegram
 * message.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param searchParams - URL query parameters.
 * @param headers - The request headers.
 * @param req - The incoming HTTP request with the object body.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 response with the object etag or an error.
 */
const handlePutObject = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  headers: Record<string, string>,
  req: Request,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await bucketRepository.findByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  // Tag operations are idempotent no-ops
  if (searchParams.has('tagging')) {
    return s3Response(null, 204, reqId);
  }

  // Copy-object path
  const copySource = headers['x-amz-copy-source'];
  if (copySource) {
    return handleCopyObject(bucket, key, copySource, headers, bucketRecord.id, reqId);
  }

  // Stream body to temp file — O(1) memory, safe for multi-GB blobs
  const contentType = headers['content-type'] || 'application/octet-stream';
  const streamed = await streamBodyToTemp(req.body);

  // H4: Verify body hash against x-amz-content-sha256
  const bodyHashError = verifyBodyHash(streamed.fileHash, headers);
  if (bodyHashError) {
    await cleanupTempFile(streamed.tempPath);
    return s3ErrorResponse(
      bodyHashError.errorCode || 'BadDigest',
      'The x-amz-content-sha256 you specified did not match what we received.',
      `/${bucket}/${key}`,
      400,
      reqId,
    );
  }

  // Content-Length validation: ensure actual body size matches header
  const contentLengthHeader = headers['content-length'];
  if (contentLengthHeader) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength !== streamed.sizeBytes) {
      await cleanupTempFile(streamed.tempPath);
      return s3ErrorResponse(
        'IncompleteBody',
        'You did not provide the number of bytes specified by the Content-Length HTTP header.',
        `/${bucket}/${key}`,
        400,
        reqId,
      );
    }
  }

  // Content-MD5 validation: use pre-computed MD5 from streaming (no OOM re-read)
  const contentMd5 = headers['content-md5'];
  if (contentMd5 && contentMd5 !== streamed.md5Hash) {
    await cleanupTempFile(streamed.tempPath);
    return s3ErrorResponse(
      'BadDigest',
      'The Content-MD5 you specified did not match what we received.',
      `/${bucket}/${key}`,
      400,
      reqId,
    );
  }

  // M12: Reject oversized bodies
  if (streamed.sizeBytes > config.maxRequestBodyBytes) {
    await cleanupTempFile(streamed.tempPath);
    return s3ErrorResponse(
      'EntityTooLarge',
      'Your proposed upload exceeds the maximum allowed object size.',
      `/${bucket}/${key}`,
      400,
      reqId,
    );
  }

  // Idempotent PUT: if the object already exists, skip upload
  try {
    const existing = await fileRepository.findByBucketAndKey(bucketRecord.id, key);
    if (existing) {
      await cleanupTempFile(streamed.tempPath);
      return s3Response(null, 200, reqId, { etag: `"${streamed.fileHash}"` });
    }

    return await storeFileFromTemp(streamed, key, bucketRecord, contentType, reqId);
  } catch (error) {
    await cleanupTempFile(streamed.tempPath);
    throw error;
  }
};

/**
 * Stores a streamed file to Telegram storage as an S3 object.
 *
 * Accepts the result of `streamBodyToTemp` (temp path + hash + size) instead
 * of a raw Buffer, enabling O(1) memory usage for multi-GB Docker layer blobs.
 *
 * Handles both chunked (large files) and single-message (small files) paths.
 *
 * @param streamed - The streamed file result (temp path, hash, size, signature).
 * @param key - The S3 object key.
 * @param bucketRecord - The resolved bucket record (id and name).
 * @param contentType - The MIME type from the request Content-Type header.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 response with the etag of the stored object.
 */
const storeFileFromTemp = async (
  streamed: { tempPath: string; fileHash: string; sizeBytes: number; signatureBuffer: Buffer },
  key: string,
  bucketRecord: { id: string; name: string },
  contentType: string,
  reqId: string,
): Promise<Response> => {
  const fileName = key.split('/').pop() || 'file';
  const { fileName: finalFileName, mimeType } = ensureExtension(
    fileName,
    streamed.signatureBuffer,
    contentType,
  );

  const bucketId = bucketRecord.id;
  const partFileNamePrefix = `s3-${bucketRecord.name}-${key.replace(/\//g, '_')}`;

  if (streamed.sizeBytes > config.telegramChunkSizeBytes) {
    const file = await chunkedStorage.storeFileInTelegramChunks({
      tempPath: streamed.tempPath,
      partFileNamePrefix,
      fileName: finalFileName,
      mimeType,
      sizeBytes: streamed.sizeBytes,
      fileType: DEFAULT_FILE_TYPE,
      uploaderId: 0,
      bucketId,
      s3Key: key,
    });
    await cleanupTempFile(streamed.tempPath);
    return s3Response(null, 200, reqId, { etag: `"${file.fileHash}"` });
  }

  const fileStream = createReadStream(streamed.tempPath);
  let forwardResult: ForwardResult;
  try {
    forwardResult = await botPool.forwardToStorage(fileStream, partFileNamePrefix, 'document');
  } catch (error) {
    fileStream.destroy();
    throw error;
  }
  fileStream.destroy();

  const publicId = nanoid();

  await fileRepository.create(
    buildNewFile({
      publicId,
      telegramFileId: forwardResult.telegramFileId,
      telegramFileUniqueId: forwardResult.telegramFileUniqueId,
      storageChatId: config.storageChatId,
      storageMessageId: forwardResult.storageMessageId,
      fileName: finalFileName,
      mimeType,
      sizeBytes: streamed.sizeBytes,
      fileType: DEFAULT_FILE_TYPE,
      uploaderId: 0,
      fileHash: streamed.fileHash,
      bucketId,
      s3Key: key,
      storageBackend: 'telegram',
    }),
  );

  await cleanupTempFile(streamed.tempPath);

  return s3Response(null, 200, reqId, { etag: `"${streamed.fileHash}"` });
};

/**
 * Handles PUT /{bucket}/{key} with an `x-amz-copy-source` header.
 *
 * Creates a new file record referencing the same Telegram-stored data as
 * the source object. Chunked source objects are not supported for copy.
 *
 * @param _destBucket - The destination bucket name (unused — bucket record
 *                      already resolved).
 * @param destKey - The destination object key.
 * @param rawCopySource - The raw `x-amz-copy-source` header value.
 * @param headers - The request headers (for conditional copy checks).
 * @param destBucketId - The UUID of the destination bucket.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML response with the copy result or an error.
 */
const handleCopyObject = async (
  _destBucket: string,
  destKey: string,
  rawCopySource: string,
  headers: Record<string, string>,
  destBucketId: string,
  reqId: string,
): Promise<Response> => {
  const copySource = decodeURIComponent(rawCopySource);
  const sourcePath = copySource.startsWith('/') ? copySource.slice(1) : copySource;
  const parts = sourcePath.split('/');
  const sourceBucket = parts[0];
  const sourceKey = parts.slice(1).join('/');

  const sourceBucketRecord = await bucketRepository.findByName(sourceBucket);
  if (!sourceBucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      copySource,
      404,
      reqId,
    );

  const sourceFile = await fileRepository.findByBucketAndKey(sourceBucketRecord.id, sourceKey);
  if (!sourceFile)
    return s3ErrorResponse(
      'NoSuchKey',
      'The specified key does not exist.',
      copySource,
      404,
      reqId,
    );

  // Chunked objects cannot be copied yet
  if (sourceFile.storageBackend === 'chunked') {
    return s3ErrorResponse(
      'NotImplemented',
      'Copying chunked objects is not yet implemented.',
      copySource,
      501,
      reqId,
    );
  }

  // Conditional copy: if-match / if-none-match checks
  // M9: Use stable etag (telegramFileId fallback when fileHash is null)
  const sourceEtag = sourceFile.fileHash || sourceFile.telegramFileId;
  const ifMatch = headers['x-amz-copy-source-if-match'];
  const ifNoneMatch = headers['x-amz-copy-source-if-none-match'];
  if (ifMatch && ifMatch !== '*' && ifMatch !== `"${sourceEtag}"`) {
    return s3ErrorResponse(
      'PreconditionFailed',
      'The preconditions you specified did not hold.',
      copySource,
      412,
      reqId,
    );
  }
  if (ifNoneMatch && ifNoneMatch === `"${sourceEtag}"`) {
    return s3ErrorResponse(
      'PreconditionFailed',
      'The preconditions you specified did not hold.',
      copySource,
      412,
      reqId,
    );
  }

  const publicId = nanoid();

  await fileRepository.create(
    buildNewFile({
      publicId,
      telegramFileId: sourceFile.telegramFileId,
      telegramFileUniqueId: sourceFile.telegramFileUniqueId,
      storageChatId: sourceFile.storageChatId,
      storageMessageId: sourceFile.storageMessageId,
      fileName: sourceFile.fileName,
      mimeType: sourceFile.mimeType,
      sizeBytes: sourceFile.sizeBytes,
      fileType: sourceFile.fileType,
      uploaderId: 0,
      fileHash: sourceFile.fileHash,
      bucketId: destBucketId,
      s3Key: destKey,
      storageBackend: 'telegram',
    }),
  );

  const xml = copyObjectResultXml(sourceFile.fileHash || nanoid(16), new Date());
  return s3Response(xml, 200, reqId, { 'content-type': 'application/xml' });
};

/**
 * Handles DELETE /{bucket}/{key} — soft-deletes an S3 object.
 *
 * @param bucket - The bucket name.
 * @param key - The object key to delete.
 * @param reqId - The request identifier for S3 headers.
 * @returns A 204 response on success, or an S3 XML error.
 */
const handleDeleteObject = async (
  bucket: string,
  key: string,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await bucketRepository.findByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  await fileRepository.softDelete(bucketRecord.id, key);
  return s3Response(null, 204, reqId);
};

/**
 * Handles POST /{bucket}?delete — batch-deletes multiple S3 objects.
 *
 * Parses the XML Delete request body, soft-deletes each key, and returns
 * an XML delete result.
 *
 * @param bucket - The bucket name.
 * @param body - The raw XML request body.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML response listing deleted keys.
 */
const handleDeleteObjects = async (
  bucket: string,
  body: string,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await bucketRepository.findByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}`,
      404,
      reqId,
    );

  const { keys, quiet } = parseDeleteObjectsBody(body);

  // M11: S3 spec limits batch delete to 1000 keys
  if (keys.length > 1000) {
    return s3ErrorResponse(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema. Max 1000 keys per request.',
      `/${bucket}`,
      400,
      reqId,
    );
  }

  const deletedKeys: string[] = [];
  const errors: Array<{ key: string; code: string; message: string }> = [];
  for (const key of keys) {
    const ok = await fileRepository.softDelete(bucketRecord.id, key);
    if (ok) {
      deletedKeys.push(key);
    } else {
      // Per S3 spec, deleting a non-existent key is idempotent — report as success
      deletedKeys.push(key);
    }
  }
  const xml = quiet ? deleteResultXml([], []) : deleteResultXml(deletedKeys, errors);
  return s3Response(xml, 200, reqId, { 'content-type': 'application/xml' });
};

// ─────── Object Listing ───────

/**
 * Handles GET /{bucket} (ListObjectsV1 with query parameters).
 *
 * @param bucket - The bucket name.
 * @param searchParams - URL query parameters (prefix, delimiter, max-keys,
 *                       marker, encoding-type).
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML ListBucketResult response.
 */
const handleListObjectsV1 = async (
  bucket: string,
  searchParams: URLSearchParams,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await bucketRepository.findByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}`,
      404,
      reqId,
    );

  const prefix = searchParams.get('prefix') || '';
  const delimiter = searchParams.get('delimiter') || null;
  const maxKeys = Math.max(
    1,
    Math.min(Number.parseInt(searchParams.get('max-keys') || '1000', 10), 1000),
  );
  const marker = searchParams.get('marker') || null;
  const encodingType = searchParams.get('encoding-type') || null;

  const { objects, prefixes: commonPrefixes } = await fileRepository.listByPrefix(
    bucketRecord.id,
    prefix,
    delimiter,
    maxKeys,
    marker,
  );

  const isTruncated = objects.length > maxKeys;
  const displayObjects = objects.slice(0, maxKeys);
  const nextMarker = isTruncated
    ? (displayObjects[displayObjects.length - 1]?.s3Key ?? null)
    : null;

  const xml = listBucketResultXml(
    bucket,
    displayObjects.map(mapFileToListEntry),
    commonPrefixes,
    isTruncated,
    marker,
    maxKeys,
    prefix,
    delimiter,
    nextMarker,
    reqId,
    encodingType,
  );

  return s3Response(xml, 200, reqId, { 'content-type': 'application/xml' });
};

/** Shape of an S3 list entry object. */
type S3ListEntry = {
  key: string;
  sizeBytes: number;
  etag: string;
  lastModified: Date;
  mimeType: string;
};

/**
 * Maps a File entity to an S3 list entry object.
 *
 * @param file - The file entity from the repository.
 * @returns An S3 list entry with key, size, etag, last modified, and MIME type.
 */
const mapFileToListEntry = (file: FileEntity): S3ListEntry => ({
  key: file.s3Key ?? '',
  sizeBytes: file.sizeBytes,
  etag: file.fileHash || nanoid(16),
  lastModified: file.createdAt instanceof Date ? file.createdAt : new Date(),
  mimeType: file.mimeType,
});

/**
 * Handles GET /{bucket}?list-type=2 (ListObjectsV2).
 *
 * @param bucket - The bucket name.
 * @param searchParams - URL query parameters (prefix, delimiter, max-keys,
 *                       continuation-token, start-after, encoding-type).
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML ListBucketV2Result response.
 */
const handleListObjectsV2 = async (
  bucket: string,
  searchParams: URLSearchParams,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await bucketRepository.findByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}`,
      404,
      reqId,
    );

  const prefix = searchParams.get('prefix') || '';
  const delimiter = searchParams.get('delimiter') || null;
  const maxKeys = Math.min(Number.parseInt(searchParams.get('max-keys') || '1000', 10), 1000);
  const continuationToken = searchParams.get('continuation-token') || null;
  const startAfter = searchParams.get('start-after') || null;
  const encodingType = searchParams.get('encoding-type') || null;

  const { objects, prefixes: commonPrefixes } = await fileRepository.listByPrefix(
    bucketRecord.id,
    prefix,
    delimiter,
    maxKeys,
    continuationToken || startAfter,
  );

  const isTruncated = objects.length > maxKeys;
  const displayObjects = objects.slice(0, maxKeys);
  const nextContinuationToken = isTruncated
    ? (displayObjects[displayObjects.length - 1]?.s3Key ?? null)
    : null;

  const xml = listBucketV2ResultXml(
    bucket,
    displayObjects.map(mapFileToListEntry),
    commonPrefixes,
    isTruncated,
    maxKeys,
    prefix,
    delimiter,
    continuationToken,
    nextContinuationToken,
    displayObjects.length,
    reqId,
    encodingType,
  );

  return s3Response(xml, 200, reqId, { 'content-type': 'application/xml' });
};

// ─────── Multipart Upload ───────

/**
 * Handles POST /{bucket}/{key}?uploads — initiates a multipart upload.
 *
 * @param bucket - The bucket name.
 * @param key - The object key being uploaded.
 * @param _searchParams - URL query parameters (unused).
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML InitiateMultipartUpload response.
 */
const handleCreateMultipartUpload = async (
  bucket: string,
  key: string,
  _searchParams: URLSearchParams,
  headers: Record<string, string>,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await bucketRepository.findByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  const contentType = headers['content-type'] || null;
  const uploadId = await multipartRepository.create(bucketRecord.id, key, 's3', contentType);

  const xml = initiateMultipartUploadXml(bucket, key, uploadId);
  return s3Response(xml, 200, reqId, { 'content-type': 'application/xml' });
};

/**
 * Handles PUT /{bucket}/{key}?uploadId=&partNumber= — uploads a single
 * part of a multipart upload.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param searchParams - URL query parameters containing uploadId and
 *                       partNumber.
 * @param req - The incoming HTTP request with the part body.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 response with the part etag, or an error.
 */
const handleUploadPart = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  req: Request,
  reqId: string,
): Promise<Response> => {
  const uploadId = searchParams.get('uploadId')!;
  // M14: Validate partNumber is actually an integer, not NaN
  const partNumberRaw = searchParams.get('partNumber')!;
  const partNumber = Number.parseInt(partNumberRaw, 10);
  if (
    !Number.isFinite(partNumber) ||
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > 10000
  ) {
    return s3ErrorResponse(
      'InvalidArgument',
      'Part number must be an integer between 1 and 10000',
      `/${bucket}/${key}`,
      400,
      reqId,
    );
  }

  const multipart = await multipartRepository.findById(uploadId);
  if (!multipart || multipart.s3Key !== key) {
    return s3ErrorResponse(
      'NoSuchUpload',
      'The specified upload does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );
  }

  // Stream the part body to temp — O(1) memory, safe for large parts
  const tempPath = `/tmp/filedrop-mp-${nanoid()}`;
  const writer = Bun.file(tempPath).writer();
  const reader = (
    req.body ??
    new ReadableStream({
      start(c) {
        c.close();
      },
    })
  ).getReader();
  const hasher = new Bun.CryptoHasher('sha256');
  let sizeBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      sizeBytes += chunk.byteLength;
      hasher.update(chunk);
      writer.write(chunk);
    }
    await writer.end();
  } catch (error) {
    try {
      writer.end();
    } catch {
      // ignore during error path
    }
    await cleanupTempFile(tempPath);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (sizeBytes > config.telegramChunkSizeBytes) {
    await cleanupTempFile(tempPath);
    return s3ErrorResponse(
      'EntityTooLarge',
      `Your proposed upload part size (${sizeBytes} bytes) exceeds the maximum allowed part size (${config.telegramChunkSizeBytes} bytes) for this storage backend. Use smaller part sizes.`,
      `/${bucket}/${key}`,
      400,
      reqId,
    );
  }

  // M4: Ensure temp file cleanup even if forwardToStorage fails
  let forwardResult: ForwardResult;
  try {
    forwardResult = await botPool.forwardToStorage(
      createReadStream(tempPath),
      `mp-${uploadId}-part-${partNumber}`,
      'document',
    );
  } catch (error) {
    await cleanupTempFile(tempPath);
    throw error;
  }
  await cleanupTempFile(tempPath);

  const etag = hasher.digest('hex');
  await multipartRepository.insertPart({
    uploadId,
    partNumber,
    telegramFileId: forwardResult.telegramFileId,
    telegramFileUniqueId: forwardResult.telegramFileUniqueId,
    storageMessageId: forwardResult.storageMessageId,
    sizeBytes,
    etag,
  });

  return s3Response(null, 200, reqId, { etag: `"${etag}"` });
};

/**
 * Handles POST /{bucket}/{key}?uploadId= — completes a multipart upload.
 *
 * Validates the submitted part list (all parts present, ascending order),
 * creates the final file record, and marks the upload as completed.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param searchParams - URL query parameters containing uploadId.
 * @param body - The raw XML request body containing the complete part list.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML CompleteMultipartUpload response.
 */
const handleCompleteMultipartUpload = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  body: string,
  reqId: string,
): Promise<Response> => {
  const uploadId = searchParams.get('uploadId')!;
  const multipart = await multipartRepository.findById(uploadId);
  // H5: Verify both upload exists AND key matches (consistent with handleUploadPart)
  if (!multipart || multipart.s3Key !== key) {
    return s3ErrorResponse(
      'NoSuchUpload',
      'The specified upload does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );
  }

  const parts = parseCompleteMultipartBody(body);
  const storedParts = await multipartRepository.listParts(uploadId);

  // Validate ascending part order
  const partNumbers = parts.map((p) => p.partNumber);
  if (partNumbers.length > 1 && partNumbers.some((n, i) => i > 0 && n <= partNumbers[i - 1])) {
    return s3ErrorResponse(
      'InvalidPartOrder',
      'The list of parts was not in ascending order.',
      `/${bucket}/${key}`,
      400,
      reqId,
    );
  }

  // H8: Verify count AND part numbers AND etags match stored parts
  if (parts.length !== storedParts.length) {
    return s3ErrorResponse(
      'InvalidPart',
      'One or more specified parts could not be found.',
      `/${bucket}/${key}`,
      400,
      reqId,
    );
  }

  // Build a map for O(1) part number lookup
  const storedByNumber = new Map<number, (typeof storedParts)[0]>();
  for (const sp of storedParts) {
    storedByNumber.set(sp.partNumber, sp);
  }

  for (const clientPart of parts) {
    const stored = storedByNumber.get(clientPart.partNumber);
    if (!stored || stored.etag !== clientPart.etag) {
      return s3ErrorResponse(
        'InvalidPart',
        'One or more specified parts could not be found. The etag or part number does not match.',
        `/${bucket}/${key}`,
        400,
        reqId,
      );
    }
  }

  const totalSize = storedParts.reduce((sum, p) => sum + Number(p.sizeBytes), 0);
  const combinedEtag = storedParts.map((p) => p.etag).join('-');

  const publicId = nanoid();

  // M7: Use stored content-type from the multipart record if available
  const mimeType = multipart.contentType || 'application/octet-stream';

  await fileRepository.create(
    buildNewFile({
      publicId,
      telegramFileId: storedParts[0]!.telegramFileId,
      telegramFileUniqueId: storedParts[0]!.telegramFileUniqueId,
      storageChatId: config.storageChatId,
      storageMessageId: storedParts[0]!.storageMessageId,
      fileName: key.split('/').pop() || 'file',
      mimeType,
      sizeBytes: totalSize,
      fileType: DEFAULT_FILE_TYPE,
      uploaderId: 0,
      bucketId: multipart.bucketId,
      s3Key: key,
      storageBackend: 'telegram',
      multipartUploadId: uploadId,
    }),
  );

  await multipartRepository.complete(uploadId);

  const location = `${config.baseUrl}/${bucket}/${key}`;
  const xml = completeMultipartUploadXml(bucket, key, combinedEtag, location);

  return s3Response(xml, 200, reqId, { 'content-type': 'application/xml' });
};

/**
 * Handles GET /{bucket}?uploads — lists in-progress multipart uploads.
 *
 * @param bucket - The bucket name.
 * @param searchParams - URL query parameters (max-uploads, key-marker).
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML ListMultipartUploadsResult response.
 */
const handleListMultipartUploads = async (
  bucket: string,
  searchParams: URLSearchParams,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await bucketRepository.findByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}`,
      404,
      reqId,
    );

  const maxUploads = Math.min(Number.parseInt(searchParams.get('max-uploads') || '1000', 10), 1000);
  const keyMarker = searchParams.get('key-marker') || null;
  const { uploads, isTruncated, nextKeyMarker } = await multipartRepository.listByBucket(
    bucketRecord.id,
    maxUploads,
    keyMarker,
  );

  const xml = listMultipartUploadsXml(
    bucket,
    uploads.map((u) => ({
      key: u.s3Key,
      uploadId: u.uploadId,
      initiatedAt: u.initiatedAt,
      initiatedBy: u.initiatedBy,
    })),
    maxUploads,
    isTruncated,
    nextKeyMarker,
    reqId,
  );

  return s3Response(xml, 200, reqId, { 'content-type': 'application/xml' });
};

/**
 * Handles DELETE /{bucket}/{key}?uploadId= — aborts a multipart upload.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param searchParams - URL query parameters containing uploadId.
 * @param reqId - The request identifier for S3 headers.
 * @returns A 204 response on success, or an S3 XML error.
 */
const handleAbortMultipartUpload = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  reqId: string,
): Promise<Response> => {
  const uploadId = searchParams.get('uploadId')!;
  const multipart = await multipartRepository.findById(uploadId);
  if (!multipart) {
    return s3ErrorResponse(
      'NoSuchUpload',
      'The specified upload does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );
  }

  await multipartRepository.abort(uploadId);
  return s3Response(null, 204, reqId);
};

/**
 * Handles GET /{bucket}/{key}?uploadId= — lists uploaded parts of a
 * multipart upload.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param searchParams - URL query parameters containing uploadId and
 *                       optional max-parts.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML ListPartsResult response.
 */
const handleListParts = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  reqId: string,
): Promise<Response> => {
  const uploadId = searchParams.get('uploadId')!;
  const multipart = await multipartRepository.findById(uploadId);
  if (!multipart) {
    return s3ErrorResponse(
      'NoSuchUpload',
      'The specified upload does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );
  }

  const parts = await multipartRepository.listParts(uploadId);
  const maxParts = Math.min(Number.parseInt(searchParams.get('max-parts') || '1000', 10), 1000);

  const xml = listPartsXml(
    bucket,
    key,
    uploadId,
    parts.map((p) => ({
      partNumber: p.partNumber,
      etag: p.etag,
      sizeBytes: p.sizeBytes,
      createdAt: p.createdAt,
    })),
    maxParts,
    false,
    reqId,
  );

  return s3Response(xml, 200, reqId, { 'content-type': 'application/xml' });
};
