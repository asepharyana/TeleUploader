import { createReadStream } from 'node:fs';
import { nanoid } from 'nanoid';
import { buildNewFile } from '../../../../domain/entities/file-factory';
import type { ForwardResult } from '../../../../domain/ports/telegram-service';
import { config } from '../../../../env';
import { bucketRepository, chunkedStorage, fileRepository } from '../../../../infrastructure/di';
import { botPool } from '../../../../infrastructure/telegram/bot-pool';
import { cleanupTempFile, DEFAULT_FILE_TYPE, ensureExtension } from '../../../../shared/utils/file';
import { streamToTemp } from '../../../../shared/utils/temp-stream';
import { DeleteObjectsBodySchema, parseOrNull } from '../../../../shared/validation/schemas';
import { verifyBodyHash } from '../../../s3/auth';
import {
  copyObjectResultXml,
  deleteResultXml,
  parseDeleteObjectsBody,
  s3ErrorResponse,
} from '../../../s3/xml';
import { etagOrFallback, resolveBucketOr404, s3Response } from './s3-common';

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
export const streamBodyToTemp = async (
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
export const handlePutObject = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  headers: Record<string, string>,
  req: Request,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await resolveBucketOr404(
    bucketRepository,
    bucket,
    `/${bucket}/${key}`,
    reqId,
  );
  if (bucketRecord instanceof Response) return bucketRecord;

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
export const storeFileFromTemp = async (
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
export const handleCopyObject = async (
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
  // M9: Use stable etag (telegramFileId fallback when fileHash is null) —
  // kept inline (not etagOrFallback) because this variant falls back to
  // telegramFileId while the read/list paths fall back to nanoid(16).
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

  // copyObjectResultXml quotes the etag itself.
  const xml = copyObjectResultXml(etagOrFallback(sourceFile.fileHash), new Date());
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
export const handleDeleteObject = async (
  bucket: string,
  key: string,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await resolveBucketOr404(
    bucketRepository,
    bucket,
    `/${bucket}/${key}`,
    reqId,
  );
  if (bucketRecord instanceof Response) return bucketRecord;

  await fileRepository.softDelete(bucketRecord.id, key);
  return s3Response(null, 204, reqId);
};

/**
 * Handles POST /{bucket}?delete — batch-deletes multiple S3 objects.
 *
 * Parses the XML Delete request body, soft-deletes each key, and returns
 * an XML delete result. The parsed body is validated with
 * DeleteObjectsBodySchema (malformed output → MalformedXML 400; the schema
 * also enforces the M11 S3 limit of 1000 keys).
 *
 * @param bucket - The bucket name.
 * @param body - The raw XML request body.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML response listing deleted keys.
 */
export const handleDeleteObjects = async (
  bucket: string,
  body: string,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await resolveBucketOr404(bucketRepository, bucket, `/${bucket}`, reqId);
  if (bucketRecord instanceof Response) return bucketRecord;

  const parsed = parseOrNull(DeleteObjectsBodySchema, parseDeleteObjectsBody(body));

  // M11: S3 spec limits batch delete to 1000 keys (also enforced by schema)
  if (parsed === null || parsed.keys.length > 1000) {
    return s3ErrorResponse(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against our published schema. Max 1000 keys per request.',
      `/${bucket}`,
      400,
      reqId,
    );
  }
  const { keys, quiet } = parsed;

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
