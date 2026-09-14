import type { File as FileEntity } from '../../../../domain/entities/file';
import {
  bucketRepository,
  chunkedStorage,
  fileRepository,
  multipartRepository,
} from '../../../../infrastructure/di';
import { botPool } from '../../../../infrastructure/telegram/bot-pool';
import { buildTelegramFileUrl } from '../../../../infrastructure/telegram/file-url';
import logger from '../../../../shared/logger/index';
import { getErrorMessage } from '../../../../shared/utils/file';
import { s3Headers } from '../../../s3/headers';
import { createGetObjectResponse, type ObjectPartSource } from '../../../s3/object-stream';
import { parseRangeHeader } from '../../../s3/range';
import { s3ErrorResponse } from '../../../s3/xml';
import { etagOrFallback, invalidRangeResponse, resolveBucketOr404, s3Response } from './s3-common';

// ─────── Conditional Headers Helper ──────

/**
 * S3-compatible response for 304 Not Modified.
 */
export const notModifiedResponse = (
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
export const preconditionFailedResponse = (path: string, reqId: string): Response =>
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
export const checkConditionalHeaders = (
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
  const etag = `"${etagOrFallback(file.fileHash)}"`;
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
export const handleGetObject = async (
  bucket: string,
  key: string,
  _searchParams: URLSearchParams,
  headers: Record<string, string>,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await resolveBucketOr404(
    bucketRepository,
    bucket,
    `/${bucket}/${key}`,
    reqId,
  );
  if (bucketRecord instanceof Response) return bucketRecord;

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
      return invalidRangeResponse(`/${bucket}/${key}`, totalSize, reqId);
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
  const telegramUrl = buildTelegramFileUrl(fileInfo.file_path, fileInfo.bot_token);

  const totalSize = file.sizeBytes;
  const range = parseRangeHeader(headers.range || null, totalSize);
  if (range.type === 'invalid') {
    return invalidRangeResponse(`/${bucket}/${key}`, totalSize, reqId);
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
export const handleGetMultipartObject = async (
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
    return invalidRangeResponse(`/${bucket}/${key}`, totalSize, reqId);
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
          telegramUrl: buildTelegramFileUrl(fileInfo.file_path, fileInfo.bot_token),
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
export const handleHeadObject = async (
  bucket: string,
  key: string,
  headers: Record<string, string>,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await resolveBucketOr404(
    bucketRepository,
    bucket,
    `/${bucket}/${key}`,
    reqId,
  );
  if (bucketRecord instanceof Response) return bucketRecord;

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
    etag: `"${etagOrFallback(file.fileHash)}"`,
    'last-modified':
      file.createdAt instanceof Date ? file.createdAt.toUTCString() : new Date().toUTCString(),
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000',
    'x-amz-version-id': 'null',
  });
};
