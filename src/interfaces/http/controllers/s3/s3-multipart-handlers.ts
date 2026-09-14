import { createReadStream } from 'node:fs';
import { nanoid } from 'nanoid';
import { buildNewFile } from '../../../../domain/entities/file-factory';
import type { IMultipartRepository } from '../../../../domain/ports/multipart-repository';
import type { ForwardResult } from '../../../../domain/ports/telegram-service';
import { config } from '../../../../env';
import {
  bucketRepository,
  fileRepository,
  multipartRepository,
} from '../../../../infrastructure/di';
import { botPool } from '../../../../infrastructure/telegram/bot-pool';
import { cleanupTempFile, DEFAULT_FILE_TYPE } from '../../../../shared/utils/file';
import {
  CompletePartSchema,
  clampMaxKeys,
  PartNumberSchema,
  parseOrNull,
} from '../../../../shared/validation/schemas';
import {
  completeMultipartUploadXml,
  initiateMultipartUploadXml,
  listMultipartUploadsXml,
  listPartsXml,
  parseCompleteMultipartBody,
  s3ErrorResponse,
} from '../../../s3/xml';
import { requireUploadOr404, resolveBucketOr404, s3Response } from './s3-common';

type MultipartRepo = IMultipartRepository;

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
export const handleCreateMultipartUpload = async (
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

  // NOTE: IMultipartRepository.create takes 3 args (bucketId, s3Key,
  // initiatedBy). The content-type is intentionally dropped here — the
  // complete step also falls back to 'application/octet-stream' since the
  // in-progress upload record carries no contentType field.
  void headers;
  const uploadId = await (multipartRepository as MultipartRepo).create(bucketRecord.id, key, 's3');

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
export const handleUploadPart = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  req: Request,
  reqId: string,
): Promise<Response> => {
  const uploadId = searchParams.get('uploadId')!;
  // M14: partNumber must be an integer 1–10000 (PartNumberSchema mirrors the
  // old manual check; same InvalidArgument message preserved).
  const partNumber = parseOrNull(PartNumberSchema, searchParams.get('partNumber'));
  if (partNumber === null) {
    return s3ErrorResponse(
      'InvalidArgument',
      'Part number must be an integer between 1 and 10000',
      `/${bucket}/${key}`,
      400,
      reqId,
    );
  }

  // H5: Verify both upload exists AND key matches.
  const multipart = await requireUploadOr404(
    multipartRepository,
    uploadId,
    `/${bucket}/${key}`,
    reqId,
    key,
  );
  if (multipart instanceof Response) return multipart;

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
 * Validates the submitted part list (each part against CompletePartSchema —
 * invalid → InvalidPart 400; all parts present, ascending order), creates
 * the final file record, and marks the upload as completed.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param searchParams - URL query parameters containing uploadId.
 * @param body - The raw XML request body containing the complete part list.
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML CompleteMultipartUpload response.
 */
export const handleCompleteMultipartUpload = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  body: string,
  reqId: string,
): Promise<Response> => {
  const uploadId = searchParams.get('uploadId')!;
  // H5: Verify both upload exists AND key matches (consistent with handleUploadPart)
  const multipart = await requireUploadOr404(
    multipartRepository,
    uploadId,
    `/${bucket}/${key}`,
    reqId,
    key,
  );
  if (multipart instanceof Response) return multipart;

  const rawParts = parseCompleteMultipartBody(body);
  // Validate each submitted part against CompletePartSchema; any invalid
  // part → InvalidPart 400 (approved small fix; previously malformed parts
  // were silently dropped by the regex parser and surfaced as count mismatch).
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (const raw of rawParts) {
    const valid = parseOrNull(CompletePartSchema, raw);
    if (valid === null) {
      return s3ErrorResponse(
        'InvalidPart',
        'One or more specified parts could not be found.',
        `/${bucket}/${key}`,
        400,
        reqId,
      );
    }
    parts.push(valid);
  }
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

  // The upload record carries no content-type, so the assembled object
  // defaults to application/octet-stream.
  const mimeType = 'application/octet-stream';

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
export const handleListMultipartUploads = async (
  bucket: string,
  searchParams: URLSearchParams,
  reqId: string,
): Promise<Response> => {
  const bucketRecord = await resolveBucketOr404(bucketRepository, bucket, `/${bucket}`, reqId);
  if (bucketRecord instanceof Response) return bucketRecord;

  const maxUploads = clampMaxKeys(searchParams.get('max-uploads'));
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
export const handleAbortMultipartUpload = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  reqId: string,
): Promise<Response> => {
  const uploadId = searchParams.get('uploadId')!;
  const multipart = await requireUploadOr404(
    multipartRepository,
    uploadId,
    `/${bucket}/${key}`,
    reqId,
  );
  if (multipart instanceof Response) return multipart;

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
export const handleListParts = async (
  bucket: string,
  key: string,
  searchParams: URLSearchParams,
  reqId: string,
): Promise<Response> => {
  const uploadId = searchParams.get('uploadId')!;
  const multipart = await requireUploadOr404(
    multipartRepository,
    uploadId,
    `/${bucket}/${key}`,
    reqId,
  );
  if (multipart instanceof Response) return multipart;

  const parts = await multipartRepository.listParts(uploadId);
  const maxParts = clampMaxKeys(searchParams.get('max-parts'));

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
