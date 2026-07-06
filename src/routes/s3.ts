import { createReadStream } from 'node:fs';
import { nanoid } from 'nanoid';
import { createBucket, deleteBucket, findBucketByName, listBuckets } from '../db/buckets';
import {
  countBucketObjects,
  findFileByBucketAndKey,
  listObjectsByPrefix,
  softDeleteFile,
} from '../db/files-ext';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  findMultipartUpload,
  insertMultipartPart,
  listMultipartParts,
} from '../db/multipart';
import type { File } from '../db/schema';
import { config } from '../env';
import { cleanupTempFile, computeHash, ensureExtension, getErrorMessage } from '../utils/file';
import logger from '../utils/logger';
import { verifyPresignedUrl, verifySignature } from '../utils/s3/auth';
import {
  completeMultipartUploadXml,
  copyObjectResultXml,
  deleteResultXml,
  initiateMultipartUploadXml,
  listBucketResultXml,
  listBucketsXml,
  listBucketV2ResultXml,
  listPartsXml,
  parseCompleteMultipartBody,
  parseDeleteObjectsBody,
  s3ErrorResponse,
} from '../utils/s3/xml';
import { forwardToStorage, getFileInfo } from '../utils/telegram';

const REGION = config.s3DefaultRegion || 'us-east-1';
const REQUEST_ID = () => nanoid(16);

const parseS3Path = (pathname: string): { bucket: string | null; key: string | null } => {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { bucket: null, key: null };
  if (parts.length === 1) return { bucket: parts[0], key: null };
  return { bucket: parts[0], key: parts.slice(1).join('/') };
};

const headersToRecord = (req: Request): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) {
    record[key.toLowerCase()] = value;
  }
  return record;
};

// ─────── Main Dispatcher ───────

export const handleS3Request = async (req: Request): Promise<Response> => {
  const method = req.method;
  const url = new URL(req.url);
  const pathname = url.pathname;
  const { bucket, key } = parseS3Path(pathname);
  const headers = headersToRecord(req);
  const searchParams = url.searchParams;
  const reqId = REQUEST_ID();

  // Presigned URLs: only supported for GET (verified in handleGetObject)
  if (searchParams.has('X-Amz-Signature')) {
    if (method !== 'GET') {
      return s3ErrorResponse(
        'AccessDenied',
        'Presigned URLs only supported for GET',
        pathname,
        403,
        reqId,
      );
    }
  } else {
    const authResult = await verifySignature(
      method,
      req.url,
      headers,
      null,
      config.s3AccessKey,
      config.s3SecretKey,
      REGION,
    );
    if (!authResult.isValid) {
      return s3ErrorResponse(
        authResult.errorCode || 'AccessDenied',
        'Authentication required',
        pathname,
        403,
        reqId,
      );
    }
  }

  try {
    // Root: ListBuckets
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

    // Bucket-level operations
    if (!key) {
      if (method === 'GET') {
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
          return new Response(null, { status: 204 });
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

    // Object-level: multipart checks
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

    // Standard object operations
    if (method === 'GET')
      return handleGetObject(bucket, key, searchParams, headers, req.url, reqId);
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

const handleListBuckets = async (reqId: string): Promise<Response> => {
  const buckets = await listBuckets();
  const xml = listBucketsXml(buckets, reqId);
  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml', 'x-amz-request-id': reqId },
  });
};

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
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': reqId } });
};

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
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': reqId } });
};

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
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': reqId } });
};

// ─────── Object Operations ───────

const handleGetObject = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  headers: Record<string, string>,
  requestUrl: string,
  reqId: string,
): Promise<Response> => {
  if (searchParams.has('X-Amz-Signature')) {
    const presignedResult = await verifyPresignedUrl({
      url: requestUrl,
      method: 'GET',
      headers,
      s3AccessKey: config.s3AccessKey,
      s3SecretKey: config.s3SecretKey,
      region: REGION,
    });
    if (!presignedResult.isValid) {
      return s3ErrorResponse(
        presignedResult.errorCode || 'AccessDenied',
        'Presigned URL verification failed',
        `/${bucket}/${key}`,
        403,
        reqId,
      );
    }
  }

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

  if (file.multipartUploadId) {
    return handleGetMultipartObject(file, bucket, key, reqId);
  }

  const fileInfo = await getFileInfo(file.telegramFileId);
  const redirectUrl = `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`;

  // Proxy the content from Telegram CDN so real S3 clients get the body directly.
  if (!config.proxyS3Get) {
    // Legacy 302 redirect path (when proxy is disabled)
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl, 'x-amz-request-id': reqId },
    });
  }

  const tgResponse = await fetch(redirectUrl);
  if (!tgResponse.ok) {
    logger.warn('Telegram content fetch failed', {
      status: tgResponse.status,
      fileId: file.telegramFileId,
    });
    return s3ErrorResponse(
      'InternalError',
      'Failed to fetch object content from storage',
      `/${bucket}/${key}`,
      502,
      reqId,
    );
  }

  return new Response(tgResponse.body, {
    status: 200,
    headers: {
      'content-type': file.mimeType,
      'content-length': String(file.sizeBytes),
      etag: `"${file.fileHash || ''}"`,
      'last-modified':
        file.createdAt instanceof Date
          ? file.createdAt.toUTCString()
          : new Date(file.createdAt).toUTCString(),
      'x-amz-request-id': reqId,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000',
    },
  });
};

const handleGetMultipartObject = async (
  file: File,
  bucket: string,
  key: string,
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

  const fileInfo = await getFileInfo(parts[0].telegramFileId);
  const redirectUrl = `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`;

  if (!config.proxyS3Get) {
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl, 'x-amz-request-id': reqId },
    });
  }

  const tgResponse = await fetch(redirectUrl);
  if (!tgResponse.ok) {
    logger.warn('Telegram multipart content fetch failed', {
      status: tgResponse.status,
      uploadId: file.multipartUploadId,
    });
    return s3ErrorResponse(
      'InternalError',
      'Failed to fetch object content from storage',
      `/${bucket}/${key}`,
      502,
      reqId,
    );
  }

  const totalSize = parts.reduce((sum, p) => sum + p.sizeBytes, 0);
  return new Response(tgResponse.body, {
    status: 200,
    headers: {
      'content-type': file.mimeType,
      'content-length': String(totalSize || file.sizeBytes),
      etag: `"${file.fileHash || ''}"`,
      'last-modified':
        file.createdAt instanceof Date
          ? file.createdAt.toUTCString()
          : new Date(file.createdAt).toUTCString(),
      'x-amz-request-id': reqId,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000',
    },
  });
};

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

  return new Response(null, {
    status: 200,
    headers: {
      'content-type': file.mimeType,
      'content-length': String(file.sizeBytes),
      etag: `"${file.fileHash || nanoid(16)}"`,
      'last-modified':
        file.createdAt instanceof Date ? file.createdAt.toUTCString() : new Date().toUTCString(),
      'x-amz-request-id': reqId,
    },
  });
};

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

  if (searchParams.has('tagging')) {
    return new Response(null, { status: 204 });
  }

  const copySource = headers['x-amz-copy-source'];
  if (copySource) {
    return handleCopyObject(bucket, key, copySource, bucketRecord.id, reqId);
  }

  // Read raw body — S3 clients send raw binary, not multipart/form-data
  const body = await req.arrayBuffer();
  const fileBuffer = Buffer.from(body);
  const contentType = headers['content-type'] || 'application/octet-stream';
  const hash = computeHash(fileBuffer);

  const existing = await findFileByBucketAndKey(bucketRecord.id, key);
  if (existing) {
    return new Response(null, {
      status: 200,
      headers: { etag: `"${hash}"`, 'x-amz-request-id': reqId },
    });
  }

  return await storeFileToTelegram(fileBuffer, hash, key, bucketRecord, contentType, reqId);
};

const storeFileToTelegram = async (
  buffer: Buffer,
  hash: string,
  key: string,
  bucketRecord: { id: string; name: string },
  contentType: string,
  reqId: string,
): Promise<Response> => {
  const tempPath = `/tmp/teleuploader-s3-${nanoid()}`;
  await Bun.write(tempPath, buffer);

  const signatureBuffer = buffer.subarray(0, 16);
  const fileName = key.split('/').pop() || 'file';
  const { fileName: finalFileName, mimeType } = ensureExtension(
    fileName,
    signatureBuffer,
    contentType,
  );

  const forwardResult = await forwardToStorage(
    createReadStream(tempPath),
    `s3-${bucketRecord.name}-${key.replace(/\//g, '_')}`,
    'document',
  );

  const publicId = nanoid();
  const { db, files: fileSchema } = await import('../db/index');

  await db.insert(fileSchema).values({
    publicId,
    telegramFileId: forwardResult.telegramFileId,
    telegramFileUniqueId: forwardResult.telegramFileUniqueId,
    storageChatId: config.storageChatId,
    storageMessageId: forwardResult.storageMessageId,
    fileName: finalFileName,
    mimeType,
    sizeBytes: buffer.byteLength,
    fileType: 'document',
    uploaderId: 0,
    fileHash: hash,
    bucketId: bucketRecord.id,
    s3Key: key,
    storageBackend: 'telegram',
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await cleanupTempFile(tempPath);

  return new Response(null, {
    status: 200,
    headers: { etag: `"${hash}"`, 'x-amz-request-id': reqId },
  });
};

const handleCopyObject = async (
  _destBucket: string,
  destKey: string,
  copySource: string,
  destBucketId: string,
  reqId: string,
): Promise<Response> => {
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

  const publicId = nanoid();
  const { db, files: fileSchema } = await import('../db/index');

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
  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml', 'x-amz-request-id': reqId },
  });
};

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
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': reqId } });
};

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

  const { keys } = parseDeleteObjectsBody(body);
  const deletedKeys: string[] = [];
  for (const key of keys) {
    const ok = await softDeleteFile(bucketRecord.id, key);
    if (ok) deletedKeys.push(key);
  }
  const xml = deleteResultXml(deletedKeys, []);
  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml', 'x-amz-request-id': reqId },
  });
};

// ─────── Object Listing ───────

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
  const maxKeys = Math.min(parseInt(searchParams.get('max-keys') || '1000', 10), 1000);
  const marker = searchParams.get('marker') || null;

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
  );

  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml', 'x-amz-request-id': reqId },
  });
};

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
  const maxKeys = Math.min(parseInt(searchParams.get('max-keys') || '1000', 10), 1000);
  const continuationToken = searchParams.get('continuation-token') || null;
  const startAfter = searchParams.get('start-after') || null;

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
  );

  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml', 'x-amz-request-id': reqId },
  });
};

// ─────── Multipart Upload ───────

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
  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml', 'x-amz-request-id': reqId },
  });
};

const handleUploadPart = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  req: Request,
  reqId: string,
): Promise<Response> => {
  const uploadId = searchParams.get('uploadId')!;
  const partNumber = parseInt(searchParams.get('partNumber')!, 10);

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

  const body = await req.arrayBuffer();
  const buffer = Buffer.from(body);

  const tempPath = `/tmp/teleuploader-mp-${nanoid()}`;
  await Bun.write(tempPath, buffer);

  const forwardResult = await forwardToStorage(
    createReadStream(tempPath),
    `mp-${uploadId}-part-${partNumber}`,
    'document',
  );

  await cleanupTempFile(tempPath);

  const etag = computeHash(buffer);
  await insertMultipartPart({
    uploadId,
    partNumber,
    telegramFileId: forwardResult.telegramFileId,
    telegramFileUniqueId: forwardResult.telegramFileUniqueId,
    storageMessageId: forwardResult.storageMessageId,
    sizeBytes: buffer.byteLength,
    etag,
  });

  return new Response(null, {
    status: 200,
    headers: { etag: `"${etag}"`, 'x-amz-request-id': reqId },
  });
};

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
  const { db, files: fileSchema } = await import('../db/index');

  await db.insert(fileSchema).values({
    publicId,
    telegramFileId: storedParts[0].telegramFileId,
    telegramFileUniqueId: storedParts[0].telegramFileUniqueId,
    storageChatId: config.storageChatId,
    storageMessageId: storedParts[0].storageMessageId,
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

  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml', 'x-amz-request-id': reqId },
  });
};

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
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': reqId } });
};

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
  const maxParts = Math.min(parseInt(searchParams.get('max-parts') || '1000', 10), 1000);

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

  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml', 'x-amz-request-id': reqId },
  });
};
