import { createReadStream } from 'node:fs';
import { nanoid } from 'nanoid';
import {
  createBucket,
  deleteBucket,
  findBucketByName,
  listBuckets,
} from '../../../db/buckets';
import {
  countBucketObjects,
  findFileByBucketAndKey,
  listObjectsByPrefix,
  softDeleteFile,
} from '../../../db/files-ext';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  findMultipartUpload,
  insertMultipartPart,
  listMultipartParts,
  listMultipartUploadsByBucket,
} from '../../../db/multipart';
import type { File } from '../../../db/schema';
import { config } from '../../../config/index';
import {
  createChunkedObjectResponse,
  storeFileInTelegramChunks,
} from '../../../utils/chunked-storage';
import {
  cleanupTempFile,
  computeHash,
  ensureExtension,
  getErrorMessage,
} from '../../../shared/utils/file';
import logger from '../../../shared/logger/index';
import { verifyPresignedUrl, verifySignature } from '../../../utils/s3/auth';
import { S3_CORS_HEADERS, s3Headers } from '../../../utils/s3/headers';
import { createGetObjectResponse, type ObjectPartSource } from '../../../utils/s3/object-stream';
import { parseRangeHeader, unsatisfiedContentRange } from '../../../utils/s3/range';
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
} from '../../../utils/s3/xml';
import { forwardToStorage, getFileInfo } from '../../../utils/telegram';

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
): Response => new Response(body, { status, headers: s3Headers(reqId, extraHeaders) });

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
  return { bucket: parts[0], key: parts.slice(1).join('/') };
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
      return handleCreateMultipartUpload(bucket, key, searchParams, reqId);
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
    if (method === 'HEAD') return handleHeadObject(bucket, key, reqId);
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
  const buckets = await listBuckets();
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
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)) {
    return s3ErrorResponse(
      'InvalidBucketName',
      'The specified bucket is not valid.',
      `/${bucketName}`,
      400,
      reqId,
    );
  }
  const existing = await findBucketByName(bucketName);
  if (existing) {
    return s3ErrorResponse(
      'BucketAlreadyExists',
      'The requested bucket name is not available.',
      `/${bucketName}`,
      409,
      reqId,
    );
  }
  await createBucket(bucketName);
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
  const bucket = await findBucketByName(bucketName);
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
  const bucket = await findBucketByName(bucketName);
  if (!bucket) {
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucketName}`,
      404,
      reqId,
    );
  }
  const objCount = await countBucketObjects(bucket.id);
  if (objCount > 0) {
    return s3ErrorResponse(
      'BucketNotEmpty',
      'The bucket you tried to delete is not empty.',
      `/${bucketName}`,
      409,
      reqId,
    );
  }
  await deleteBucket(bucketName);
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
  const bucket = await findBucketByName(bucketName);
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
  const bucketRecord = await findBucketByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  const file = await findFileByBucketAndKey(bucketRecord.id, key);
  if (!file)
    return s3ErrorResponse(
      'NoSuchKey',
      'The specified key does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

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
      return await createChunkedObjectResponse({ file, range, reqId });
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
  const fileInfo = await getFileInfo(file.telegramFileId);
  const redirectUrl = `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`;

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

  if (!config.proxyS3Get) {
    // Legacy 302 redirect path (when proxy is disabled)
    return s3Response(null, 302, reqId, { location: redirectUrl });
  }

  const part: ObjectPartSource = {
    telegramFileId: file.telegramFileId,
    telegramUrl: redirectUrl,
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
  file: File,
  bucket: string,
  key: string,
  headers: Record<string, string>,
  reqId: string,
): Promise<Response> => {
  const uploadId = file.multipartUploadId!;
  const parts = await listMultipartParts(uploadId);

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
  for (const part of parts) {
    const fileInfo = await getFileInfo(part.telegramFileId);
    sources.push({
      telegramFileId: part.telegramFileId,
      telegramUrl: `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`,
      sizeBytes: part.sizeBytes,
      partNumber: part.partNumber,
    });
  }

  if (!config.proxyS3Get) {
    return s3Response(null, 302, reqId, { location: sources[0]?.telegramUrl ?? '' });
  }

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
const handleHeadObject = async (bucket: string, key: string, reqId: string): Promise<Response> => {
  const bucketRecord = await findBucketByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  const file = await findFileByBucketAndKey(bucketRecord.id, key);
  if (!file)
    return s3ErrorResponse(
      'NoSuchKey',
      'The specified key does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  return s3Response(null, 200, reqId, {
    'content-type': file.mimeType,
    'content-length': String(file.sizeBytes),
    etag: `"${file.fileHash || nanoid(16)}"`,
    'last-modified':
      file.createdAt instanceof Date ? file.createdAt.toUTCString() : new Date().toUTCString(),
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000',
  });
};

/**
 * Streams the request body to a temporary file while computing its SHA-256 hash.
 *
 * Unlike `req.arrayBuffer()`, this approach uses O(1) memory regardless of
 * file size, making it safe for multi-GB Docker registry layer blobs.
 *
 * @param body - The ReadableStream from the HTTP request body.
 * @returns The temp file path, SHA-256 hash, total size, and signature bytes.
 */
const streamBodyToTemp = async (
  body: ReadableStream<Uint8Array> | null,
): Promise<{
  tempPath: string;
  fileHash: string;
  sizeBytes: number;
  signatureBuffer: Buffer;
}> => {
  const tempPath = `/tmp/filedrop-s3-${nanoid()}`;
  const writer = Bun.file(tempPath).writer();
  const hasher = new Bun.CryptoHasher('sha256');
  const reader = (body ?? new ReadableStream({ start(c) { c.close() } })).getReader();
  const SIGNATURE_BYTES = 16;
  const signatureChunks: Buffer[] = [];
  let signatureBytes = 0;
  let sizeBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      sizeBytes += chunk.byteLength;
      hasher.update(chunk);
      writer.write(chunk);

      if (signatureBytes < SIGNATURE_BYTES) {
        const remaining = SIGNATURE_BYTES - signatureBytes;
        const sigChunk = chunk.subarray(0, remaining);
        signatureChunks.push(sigChunk);
        signatureBytes += sigChunk.byteLength;
      }
    }

    writer.end();

    return {
      tempPath,
      fileHash: hasher.digest('hex'),
      sizeBytes,
      signatureBuffer: Buffer.concat(signatureChunks, signatureBytes),
    };
  } catch (error) {
    writer.end();
    await cleanupTempFile(tempPath);
    throw error;
  } finally {
    reader.releaseLock();
  }
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
  const bucketRecord = await findBucketByName(bucket);
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

  // Idempotent PUT: if the object already exists, skip upload
  const existing = await findFileByBucketAndKey(bucketRecord.id, key);
  if (existing) {
    await cleanupTempFile(streamed.tempPath);
    return s3Response(null, 200, reqId, { etag: `"${streamed.fileHash}"` });
  }

  return await storeFileFromTemp(streamed, key, bucketRecord, contentType, reqId);
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
    const file = await storeFileInTelegramChunks({
      tempPath: streamed.tempPath,
      partFileNamePrefix,
      fileName: finalFileName,
      mimeType,
      sizeBytes: streamed.sizeBytes,
      fileType: 'document',
      uploaderId: 0,
      bucketId,
      s3Key: key,
    });
    await cleanupTempFile(streamed.tempPath);
    return s3Response(null, 200, reqId, { etag: `"${file.fileHash}"` });
  }

  const forwardResult = await forwardToStorage(
    createReadStream(streamed.tempPath),
    partFileNamePrefix,
    'document',
  );

  const publicId = nanoid();
  const { db, files: fileSchema } = await import('../../../db/index');

  await db.insert(fileSchema).values({
    publicId,
    telegramFileId: forwardResult.telegramFileId,
    telegramFileUniqueId: forwardResult.telegramFileUniqueId,
    storageChatId: config.storageChatId,
    storageMessageId: forwardResult.storageMessageId,
    fileName: finalFileName,
    mimeType,
    sizeBytes: streamed.sizeBytes,
    fileType: 'document',
    uploaderId: 0,
    fileHash: streamed.fileHash,
    bucketId,
    s3Key: key,
    storageBackend: 'telegram',
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

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

  const sourceBucketRecord = await findBucketByName(sourceBucket);
  if (!sourceBucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      copySource,
      404,
      reqId,
    );

  const sourceFile = await findFileByBucketAndKey(sourceBucketRecord.id, sourceKey);
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
  const ifMatch = headers['x-amz-copy-source-if-match'];
  const ifNoneMatch = headers['x-amz-copy-source-if-none-match'];
  if (ifMatch && sourceFile.fileHash && ifMatch !== `"${sourceFile.fileHash}"`) {
    return s3ErrorResponse(
      'PreconditionFailed',
      'The preconditions you specified did not hold.',
      copySource,
      412,
      reqId,
    );
  }
  if (ifNoneMatch && sourceFile.fileHash && ifNoneMatch === `"${sourceFile.fileHash}"`) {
    return s3ErrorResponse(
      'PreconditionFailed',
      'The preconditions you specified did not hold.',
      copySource,
      412,
      reqId,
    );
  }

  const publicId = nanoid();
  const { db, files: fileSchema } = await import('../../../db/index');

  await db.insert(fileSchema).values({
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
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

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
  const bucketRecord = await findBucketByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  await softDeleteFile(bucketRecord.id, key);
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
  const bucketRecord = await findBucketByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}`,
      404,
      reqId,
    );

  const { keys, quiet } = parseDeleteObjectsBody(body);
  const deletedKeys: string[] = [];
  for (const key of keys) {
    const ok = await softDeleteFile(bucketRecord.id, key);
    if (ok) deletedKeys.push(key);
  }
  const xml = quiet ? deleteResultXml([], []) : deleteResultXml(deletedKeys, []);
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
  const bucketRecord = await findBucketByName(bucket);
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
  const marker = searchParams.get('marker') || null;
  const encodingType = searchParams.get('encoding-type') || null;

  const { objects, prefixes: commonPrefixes } = await listObjectsByPrefix(
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
    displayObjects.map((o) => ({
      key: o.s3Key ?? '',
      sizeBytes: o.sizeBytes,
      etag: o.fileHash || nanoid(16),
      lastModified: o.createdAt instanceof Date ? o.createdAt : new Date(),
      mimeType: o.mimeType,
    })),
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
  const bucketRecord = await findBucketByName(bucket);
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

  const { objects, prefixes: commonPrefixes } = await listObjectsByPrefix(
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
    displayObjects.map((o) => ({
      key: o.s3Key ?? '',
      sizeBytes: o.sizeBytes,
      etag: o.fileHash || nanoid(16),
      lastModified: o.createdAt instanceof Date ? o.createdAt : new Date(),
      mimeType: o.mimeType,
    })),
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
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await findBucketByName(bucket);
  if (!bucketRecord)
    return s3ErrorResponse(
      'NoSuchBucket',
      'The specified bucket does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );

  const uploadId = await createMultipartUpload(bucketRecord.id, key, 's3');

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
  const partNumber = Number.parseInt(searchParams.get('partNumber')!, 10);
  if (partNumber < 1 || partNumber > 10000) {
    return s3ErrorResponse(
      'InvalidArgument',
      'Part number must be an integer between 1 and 10000',
      `/${bucket}/${key}`,
      400,
      reqId,
    );
  }

  const multipart = await findMultipartUpload(uploadId);
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
  const reader = (req.body ?? new ReadableStream({ start(c) { c.close() } })).getReader();
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
    writer.end();
  } catch (error) {
    writer.end();
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

  const forwardResult = await forwardToStorage(
    createReadStream(tempPath),
    `mp-${uploadId}-part-${partNumber}`,
    'document',
  );

  await cleanupTempFile(tempPath);

  const etag = hasher.digest('hex');
  await insertMultipartPart({
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
  const multipart = await findMultipartUpload(uploadId);
  if (!multipart) {
    return s3ErrorResponse(
      'NoSuchUpload',
      'The specified upload does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );
  }

  const parts = parseCompleteMultipartBody(body);
  const storedParts = await listMultipartParts(uploadId);

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

  if (parts.length !== storedParts.length) {
    return s3ErrorResponse(
      'InvalidPart',
      'One or more specified parts could not be found.',
      `/${bucket}/${key}`,
      400,
      reqId,
    );
  }

  const totalSize = storedParts.reduce((sum, p) => sum + p.sizeBytes, 0);

  const publicId = nanoid();
  const { db, files: fileSchema } = await import('../../../db/index');

  await db.insert(fileSchema).values({
    publicId,
    telegramFileId: storedParts[0]!.telegramFileId,
    telegramFileUniqueId: storedParts[0]!.telegramFileUniqueId,
    storageChatId: config.storageChatId,
    storageMessageId: storedParts[0]!.storageMessageId,
    fileName: key.split('/').pop() || 'file',
    mimeType: 'application/octet-stream',
    sizeBytes: totalSize,
    fileType: 'document',
    uploaderId: 0,
    bucketId: multipart.bucketId,
    s3Key: key,
    storageBackend: 'telegram',
    isDeleted: false,
    multipartUploadId: uploadId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await completeMultipartUpload(uploadId);

  const location = `${config.baseUrl}/${bucket}/${key}`;
  const combinedEtag = storedParts.map((p) => p.etag).join('-');
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
  const bucketRecord = await findBucketByName(bucket);
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
  const { uploads, isTruncated, nextKeyMarker } = await listMultipartUploadsByBucket(
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
  const multipart = await findMultipartUpload(uploadId);
  if (!multipart) {
    return s3ErrorResponse(
      'NoSuchUpload',
      'The specified upload does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );
  }

  await abortMultipartUpload(uploadId);
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
  const multipart = await findMultipartUpload(uploadId);
  if (!multipart) {
    return s3ErrorResponse(
      'NoSuchUpload',
      'The specified upload does not exist.',
      `/${bucket}/${key}`,
      404,
      reqId,
    );
  }

  const parts = await listMultipartParts(uploadId);
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