import { createReadStream } from 'node:fs';
import { nanoid } from 'nanoid';
import { config } from '../../../config/index';
import { createBucket, deleteBucket, findBucketByName, listBuckets } from '../../../db/buckets';
import {
  countBucketObjects,
  findFileByBucketAndKey,
  listObjectsByPrefix,
  softDeleteFile,
} from '../../../db/files-ext';
import { db, files as fileSchema } from '../../../db/index';
import { botPool } from '../../../infrastructure/telegram/bot-pool';
import logger from '../../../shared/logger/index';
import { cleanupTempFile, ensureExtension, getErrorMessage } from '../../../shared/utils/file';
import {
  createChunkedObjectResponse,
  storeFileInTelegramChunks,
} from '../../../utils/chunked-storage';

/**
 * Route parameters extracted from the URL path.
 */
type RouteParams = { bucket?: string; key?: string };

/**
 * Returns a successful JSON Response.
 *
 * @param data - The JSON-serialisable body.
 * @param status - HTTP status code (default 200).
 * @returns A JSON Response.
 */
const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/**
 * Returns a JSON error Response.
 *
 * @param error - The error message.
 * @param status - HTTP status code.
 * @returns A JSON Response.
 */
const jsonError = (error: string, status: number): Response => Response.json({ error }, { status });

// ─────── Bucket endpoints ───────

/**
 * Lists all buckets together with their object counts.
 *
 * @returns A JSON response with the bucket list.
 */
export const handleListBucketsV1 = async (): Promise<Response> => {
  const buckets = await listBuckets();
  const result = await Promise.all(
    buckets.map(async (b) => ({
      id: b.id,
      name: b.name,
      createdAt: b.createdAt.toISOString(),
      objectCount: await countBucketObjects(b.id),
    })),
  );
  return json({ buckets: result });
};

/**
 * Creates a new bucket.
 *
 * Validates the bucket name format and checks for duplicates before creating.
 *
 * @param req - The incoming HTTP request with a JSON body containing `name`.
 * @returns A JSON response with the created bucket or an error.
 */
export const handleCreateBucketV1 = async (req: Request): Promise<Response> => {
  const body = (await req.json()) as { name?: string };
  if (!body.name || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(body.name)) {
    return jsonError('Invalid bucket name. Use lowercase, 3-63 chars, no underscore', 400);
  }
  const existing = await findBucketByName(body.name);
  if (existing) return jsonError('Bucket already exists', 409);
  const bucket = await createBucket(body.name);
  return json({ id: bucket.id, name: bucket.name }, 201);
};

/**
 * Deletes a bucket by name.
 *
 * Ensures the bucket exists and is empty before deletion.
 *
 * @param _req - The incoming HTTP request (unused).
 * @param params - Route parameters containing the bucket name.
 * @returns A JSON response indicating success or an error.
 */
export const handleDeleteBucketV1 = async (
  _req: Request,
  params: RouteParams,
): Promise<Response> => {
  const bucket = await findBucketByName(params.bucket!);
  if (!bucket) return jsonError('Bucket not found', 404);
  const count = await countBucketObjects(bucket.id);
  if (count > 0) return jsonError('Bucket is not empty', 409);
  await deleteBucket(params.bucket!);
  return json({ success: true });
};

// ─────── Object endpoints ───────

/**
 * Lists objects within a bucket (with prefix filtering and pagination).
 *
 * @param req - The incoming HTTP request with query parameters.
 * @param params - Route parameters containing the bucket name.
 * @returns A JSON response with the object list.
 */
export const handleListObjectsV1 = async (req: Request, params: RouteParams): Promise<Response> => {
  const bucket = await findBucketByName(params.bucket!);
  if (!bucket) return jsonError('Bucket not found', 404);

  const url = new URL(req.url);
  const prefix = url.searchParams.get('prefix') || '';
  const delimiter = url.searchParams.get('delimiter') || '/';
  const maxKeys = Number.parseInt(url.searchParams.get('max-keys') || '1000', 10);
  const continuationToken = url.searchParams.get('continuation-token') || null;

  const { objects, prefixes } = await listObjectsByPrefix(
    bucket.id,
    prefix,
    delimiter,
    maxKeys,
    continuationToken,
  );
  const isTruncated = objects.length > maxKeys;
  const displayObjects = objects.slice(0, maxKeys);

  return json({
    objects: displayObjects.map((o) => ({
      key: o.s3Key,
      fileName: o.fileName,
      mimeType: o.mimeType,
      sizeBytes: Number(o.sizeBytes),
      fileType: o.fileType,
      etag: o.fileHash,
      lastModified:
        o.createdAt instanceof Date
          ? o.createdAt.toISOString()
          : new Date(o.createdAt).toISOString(),
      downloadUrl: `${config.baseUrl}/f/${o.publicId}`,
    })),
    prefixes,
    isTruncated,
    nextContinuationToken: isTruncated ? displayObjects[displayObjects.length - 1]?.s3Key : null,
  });
};

/**
 * Uploads an object to a bucket (Web API V1).
 *
 * Accepts multipart/form-data with a `file` field and optional `key` field.
 *
 * @param req - The incoming HTTP request with a multipart body.
 * @param params - Route parameters containing the bucket name.
 * @returns A JSON response with the object metadata.
 */
export const handleUploadObjectV1 = async (
  req: Request,
  params: RouteParams,
): Promise<Response> => {
  const bucket = await findBucketByName(params.bucket!);
  if (!bucket) return jsonError('Bucket not found', 404);

  const formData = await req.formData();
  const file = formData.get('file');

  if (!file || !(file instanceof File)) {
    return jsonError('No file provided', 400);
  }

  const key = (formData.get('key') as string) || file.name;
  const tempPath = `/tmp/filedrop-web-${nanoid()}`;
  const writer = Bun.file(tempPath).writer();
  const reader = file.stream().getReader();
  const hasher = new Bun.CryptoHasher('sha256');
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
  } catch (error) {
    writer.end();
    await cleanupTempFile(tempPath);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const hash = hasher.digest('hex');
  const signatureBuffer = Buffer.concat(signatureChunks, signatureBytes);
  const { fileName: finalFileName, mimeType } = ensureExtension(
    key.split('/').pop() || 'file',
    signatureBuffer,
    file.type || 'application/octet-stream',
  );

  const partFileNamePrefix = `s3-${bucket.name}-${key.replace(/\//g, '_')}`;

  if (sizeBytes > config.telegramChunkSizeBytes) {
    const uploadedFile = await storeFileInTelegramChunks({
      tempPath,
      partFileNamePrefix,
      fileName: finalFileName,
      mimeType,
      sizeBytes,
      fileType: 'document',
      uploaderId: 0,
      bucketId: bucket.id,
      s3Key: key,
    });
    await cleanupTempFile(tempPath);
    return json(
      {
        key,
        size: sizeBytes,
        etag: hash,
        downloadUrl: `${config.baseUrl}/f/${uploadedFile.publicId}`,
      },
      201,
    );
  }

  const forwardResult = await botPool.forwardToStorage(
    createReadStream(tempPath),
    partFileNamePrefix,
    'document',
  );

  const publicId = nanoid();

  await db.insert(fileSchema).values({
    publicId,
    telegramFileId: forwardResult.telegramFileId,
    telegramFileUniqueId: forwardResult.telegramFileUniqueId,
    storageChatId: config.storageChatId,
    storageMessageId: forwardResult.storageMessageId,
    fileName: finalFileName,
    mimeType,
    sizeBytes,
    fileType: 'document',
    uploaderId: 0,
    fileHash: hash,
    bucketId: bucket.id,
    s3Key: key,
    storageBackend: 'telegram',
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await cleanupTempFile(tempPath);

  return json(
    { key, size: sizeBytes, etag: hash, downloadUrl: `${config.baseUrl}/f/${publicId}` },
    201,
  );
};

/**
 * Deletes an object from a bucket (soft delete).
 *
 * @param _req - The incoming HTTP request (unused).
 * @param params - Route parameters containing the bucket name and object key.
 * @returns A JSON response indicating success.
 */
export const handleDeleteObjectV1 = async (
  _req: Request,
  params: RouteParams,
): Promise<Response> => {
  const bucket = await findBucketByName(params.bucket!);
  if (!bucket) return jsonError('Bucket not found', 404);
  await softDeleteFile(bucket.id, params.key!);
  return json({ success: true });
};

/**
 * Downloads (or redirects to) an object from a bucket.
 *
 * For chunked objects, builds a streaming response. For regular Telegram
 * objects, issues a 302 redirect to the Telegram CDN URL.
 *
 * @param _req - The incoming HTTP request (unused).
 * @param params - Route parameters containing the bucket name and object key.
 * @returns A redirect or streaming response, or a JSON error.
 */
export const handleDownloadObjectV1 = async (
  _req: Request,
  params: RouteParams,
): Promise<Response> => {
  const bucket = await findBucketByName(params.bucket!);
  if (!bucket) return jsonError('Bucket not found', 404);

  const file = await findFileByBucketAndKey(bucket.id, params.key!);
  if (!file) return jsonError('Object not found', 404);

  if (file.storageBackend === 'chunked') {
    const range = { type: 'none' as const };
    return createChunkedObjectResponse({ file, range, reqId: '' });
  }

  const fileInfo = await botPool.getFileInfo(file.telegramFileId);
  const redirectUrl = `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`;

  return new Response(null, { status: 302, headers: { Location: redirectUrl } });
};

/**
 * Copies an object from one location to another within the same or a
 * different bucket.
 *
 * Creates a new file record referencing the same Telegram-stored data as
 * the source object.
 *
 * @param req - The incoming HTTP request with a JSON body specifying source
 *              and destination keys and the destination bucket.
 * @param params - Route parameters containing the source bucket name.
 * @returns A JSON response with the copy result, or an error.
 */
export const handleCopyObjectV1 = async (req: Request, params: RouteParams): Promise<Response> => {
  const body = (await req.json()) as {
    sourceKey?: string;
    destBucket?: string;
    destKey?: string;
  };

  if (!body.sourceKey || !body.destKey) {
    return jsonError('sourceKey and destKey are required', 400);
  }

  const destBucketName = body.destBucket || params.bucket!;
  const sourceBucket = await findBucketByName(params.bucket!);
  const destBucket = await findBucketByName(destBucketName);

  if (!sourceBucket || !destBucket) return jsonError('Bucket not found', 404);

  const sourceFile = await findFileByBucketAndKey(sourceBucket.id, body.sourceKey);
  if (!sourceFile) return jsonError('Source object not found', 404);

  if (sourceFile.storageBackend === 'chunked') {
    return json({ error: 'Copying chunked objects is not implemented' }, 501);
  }

  const publicId = nanoid();

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
    bucketId: destBucket.id,
    s3Key: body.destKey,
    storageBackend: 'telegram',
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return json({ sourceKey: body.sourceKey, destKey: body.destKey, destBucket: destBucketName });
};

/**
 * Main Web API V1 request router.
 *
 * Parses the request path and method, then dispatches to the appropriate
 * handler function for bucket and object operations.
 *
 * @param req - The incoming HTTP request.
 * @returns A JSON response from the matched handler, or 404.
 */
export const handleWebApiV1 = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/^\/api\/v1/, '');
  const parts = pathname.split('/').filter(Boolean);
  const method = req.method;

  try {
    // GET /api/v1/buckets
    if (parts.length === 1 && parts[0] === 'buckets' && method === 'GET') {
      return await handleListBucketsV1();
    }

    // POST /api/v1/buckets
    if (parts.length === 1 && parts[0] === 'buckets' && method === 'POST') {
      return await handleCreateBucketV1(req);
    }

    // DELETE /api/v1/buckets/{name}
    if (parts.length === 2 && parts[0] === 'buckets' && method === 'DELETE') {
      return await handleDeleteBucketV1(req, { bucket: parts[1] });
    }

    // GET /api/v1/buckets/{name}/objects
    if (
      parts.length === 3 &&
      parts[0] === 'buckets' &&
      parts[2] === 'objects' &&
      method === 'GET'
    ) {
      return await handleListObjectsV1(req, { bucket: parts[1] });
    }

    // POST /api/v1/buckets/{name}/upload
    if (
      parts.length === 3 &&
      parts[0] === 'buckets' &&
      parts[2] === 'upload' &&
      method === 'POST'
    ) {
      return await handleUploadObjectV1(req, { bucket: parts[1] });
    }

    // POST /api/v1/buckets/{name}/copy
    if (parts.length === 3 && parts[0] === 'buckets' && parts[2] === 'copy' && method === 'POST') {
      return await handleCopyObjectV1(req, { bucket: parts[1] });
    }

    // DELETE /api/v1/buckets/{name}/{key+}
    if (parts.length >= 3 && parts[0] === 'buckets' && method === 'DELETE') {
      const bucket = parts[1];
      const key = parts.slice(2).join('/');
      return await handleDeleteObjectV1(req, { bucket, key });
    }

    // GET /api/v1/buckets/{name}/download/{key+}
    if (
      parts.length >= 4 &&
      parts[0] === 'buckets' &&
      parts[2] === 'download' &&
      method === 'GET'
    ) {
      const bucket = parts[1];
      const key = parts.slice(3).join('/');
      return await handleDownloadObjectV1(req, { bucket, key });
    }

    return jsonError('Not found', 404);
  } catch (error: unknown) {
    logger.error('Web API error', { path: pathname, error: getErrorMessage(error) });
    return jsonError('Internal server error', 500);
  }
};
