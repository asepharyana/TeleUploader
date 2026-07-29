import { createWriteStream } from 'node:fs';
import { nanoid } from 'nanoid';
import { config } from '../../../env';
import { chunkedStorage, fileRepository, uploadBatcher } from '../../../infrastructure/di';
import type { PreparedUpload } from '../../../infrastructure/telegram/upload-batcher';
import logger from '../../../shared/logger/index';
import { metricsCollector } from '../../../shared/metrics/index';
import {
  buildUploadResponse,
  checkFileSize,
  cleanupTempFile,
  computeHash,
  ensureExtension,
  extractMimeType,
  getErrorMessage,
  getFileType,
} from '../../../shared/utils/file';

/**
 * Maximum allowed size (in bytes) for a base64 JSON upload.
 * JSON uploads are limited to 50 MB because base64 encoding adds ~33%
 * overhead and large payloads strain the JSON parser.
 */
const JSON_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

/** Number of leading bytes read for magic-byte / signature detection. */
const SIGNATURE_BYTES = 16;

/**
 * Payload structure accepted by the JSON upload endpoint.
 */
interface JsonUploadPayload {
  /** Base64-encoded file data (optionally with a data URI prefix). */
  file?: unknown;
  /** Optional file name. */
  fileName?: string;
}

/**
 * Parses a base64-encoded file string, optionally stripping the data URI
 * prefix.
 *
 * Accepts both bare base64 strings and RFC 2397 data URIs (e.g.
 * `data:image/png;base64,...`).
 *
 * @param file - The base64 string, with or without a data URI prefix.
 * @returns The raw base64 payload and the detected MIME type.
 */
const parseBase64File = (file: string): { base64Data: string; mimeType: string } => {
  if (!file.startsWith('data:')) {
    return { base64Data: file, mimeType: 'application/octet-stream' };
  }

  const match = file.match(/^data:([^;]+);base64,(.+)$/);
  return match
    ? { base64Data: match[2], mimeType: match[1] }
    : { base64Data: file, mimeType: 'application/octet-stream' };
};

/**
 * Extracts the Content-Length header value as a number.
 *
 * @param req - The incoming HTTP request.
 * @returns The content length in bytes, or `null` when the header is missing
 *          or invalid.
 */
const getContentLength = (req: Request): number | null => {
  const value = req.headers.get('content-length');
  if (!value) return null;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * Checks whether the request body exceeds the configured maximum size and
 * returns an error response if it does.
 *
 * @param req - The incoming HTTP request.
 * @returns A 413 Response when the request is too large, or `null` when
 *          the size is within bounds (or unknown).
 */
const rejectOversizedRequest = (req: Request): Response | null => {
  const contentLength = getContentLength(req);
  if (contentLength !== null && contentLength > config.maxRequestBodyBytes) {
    return Response.json({ error: 'Request body too large' }, { status: 413 });
  }

  return null;
};

/**
 * Streams a multipart `File` to a temporary file on disk while computing
 * its SHA-256 hash and extracting the signature (first 16 bytes).
 *
 * Backpressure from the write stream is respected via the drain event.
 *
 * @param file - The multipart `File` object.
 * @param maxSizeBytes - Maximum allowed file size; an error is thrown if
 *                       the stream exceeds this limit.
 * @returns A fully prepared upload descriptor with hash, size, and temp path.
 * @throws {Error} When the file size exceeds `maxSizeBytes`.
 */
const streamFileToTemp = async (file: File, maxSizeBytes: number): Promise<PreparedUpload> => {
  const tempPath = `/tmp/filedrop-${nanoid()}`;
  const writer = createWriteStream(tempPath);
  const hasher = new Bun.CryptoHasher('sha256');
  const reader = file.stream().getReader();
  const signatureChunks: Buffer[] = [];
  let signatureBytes = 0;
  let sizeBytes = 0;

  const writeChunk = async (chunk: Buffer): Promise<void> => {
    if (!writer.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        writer.once('drain', resolve);
        writer.once('error', reject);
      });
    }
  };

  const finishWriter = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      writer.end(() => resolve());
      writer.once('error', reject);
    });
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = Buffer.from(value);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maxSizeBytes) {
        throw new Error('File size exceeds upload limit');
      }

      hasher.update(chunk);
      await writeChunk(chunk);

      if (signatureBytes < SIGNATURE_BYTES) {
        const remaining = SIGNATURE_BYTES - signatureBytes;
        const signatureChunk = chunk.subarray(0, remaining);
        signatureChunks.push(signatureChunk);
        signatureBytes += signatureChunk.byteLength;
      }
    }

    await finishWriter();

    return {
      tempPath,
      fileHash: hasher.digest('hex'),
      sizeBytes,
      signatureBuffer: Buffer.concat(signatureChunks, signatureBytes),
    };
  } catch (error) {
    writer.destroy();
    await cleanupTempFile(tempPath);
    throw error;
  } finally {
    reader.releaseLock();
  }
};

/**
 * Writes an in-memory buffer to a temporary file on disk.
 *
 * Used for base64 JSON uploads where the decoded data is already in a Buffer.
 *
 * @param fileBuffer - The decoded file content.
 * @param fileHash - Pre-computed SHA-256 hex digest.
 * @returns A prepared upload descriptor.
 */
const writeBufferToTemp = async (fileBuffer: Buffer, fileHash: string): Promise<PreparedUpload> => {
  const tempPath = `/tmp/filedrop-${nanoid()}`;
  try {
    await Bun.write(tempPath, fileBuffer);
    return {
      tempPath,
      fileHash,
      sizeBytes: fileBuffer.byteLength,
      signatureBuffer: fileBuffer.subarray(0, SIGNATURE_BYTES),
    };
  } catch (error) {
    await cleanupTempFile(tempPath);
    throw error;
  }
};

/**
 * Handles a multipart/form-data file upload.
 *
 * Steps:
 * 1. Parse the multipart form and extract the file.
 * 2. Stream the file to a temp location, computing its hash.
 * 3. Check for deduplication by content hash.
 * 4. Determine the MIME type, file name, and Telegram file type.
 * 5. Validate file size limits.
 * 6. Upload to Telegram (chunked or single-message).
 * 7. Return the upload response JSON.
 *
 * @param req - The incoming HTTP request with a multipart body.
 * @returns A JSON response with the uploaded file metadata.
 */
const handleMultipartUpload = async (req: Request): Promise<Response> => {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const fileName =
      (formData.get('fileName') as string) || (file instanceof File ? file.name : null) || 'file';

    if (!file || !(file instanceof File)) {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > config.maxRequestBodyBytes) {
      return Response.json({ error: 'File size exceeds upload limit' }, { status: 413 });
    }

    const prepared = await streamFileToTemp(file, config.maxRequestBodyBytes);

    const existingFile = await fileRepository.findByHash(prepared.fileHash);
    if (existingFile) {
      await cleanupTempFile(prepared.tempPath);
      return Response.json(buildUploadResponse(existingFile, config.baseUrl), { status: 200 });
    }

    const rawMimeType = file.type || extractMimeType({}, req) || 'application/octet-stream';
    const { fileName: finalFileName, mimeType } = ensureExtension(
      fileName,
      prepared.signatureBuffer,
      rawMimeType,
    );
    const fileType = getFileType(mimeType, finalFileName);

    if (!checkFileSize(prepared.sizeBytes, fileType)) {
      await cleanupTempFile(prepared.tempPath);
      return Response.json({ error: `File size exceeds ${fileType} limit` }, { status: 400 });
    }

    if (prepared.sizeBytes > config.telegramChunkSizeBytes) {
      const uploadedFile = await chunkedStorage.storeFileInTelegramChunks({
        tempPath: prepared.tempPath,
        partFileNamePrefix: `direct-${prepared.fileHash?.slice(0, 16) || 'upload'}`,
        fileName: finalFileName,
        mimeType,
        sizeBytes: prepared.sizeBytes,
        fileType,
        uploaderId: 0,
      });
      await cleanupTempFile(prepared.tempPath);
      return Response.json(buildUploadResponse(uploadedFile, config.baseUrl), { status: 200 });
    }

    const uploaded = await uploadBatcher.enqueuePreparedUpload({
      prepared,
      fileName: finalFileName,
      mimeType,
      fileType,
    });

    return Response.json(buildUploadResponse(uploaded, config.baseUrl), { status: 200 });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    logger.error('Multipart upload error', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
};

/**
 * Handles an application/json file upload where the file is sent as a
 * base64-encoded string.
 *
 * Steps:
 * 1. Parse the JSON body and extract the base64 file data.
 * 2. Decode and estimate the file size; reject if too large for JSON.
 * 3. Write the decoded buffer to a temp file.
 * 4. Check deduplication by content hash.
 * 5. Determine MIME type, file name, and Telegram file type.
 * 6. Validate file size limits.
 * 7. Upload to Telegram (chunked or single-message).
 * 8. Return the upload response JSON.
 *
 * @param req - The incoming HTTP request with a JSON body.
 * @returns A JSON response with the uploaded file metadata.
 */
const handleJSONUpload = async (req: Request): Promise<Response> => {
  try {
    const { file, fileName = 'file' } = (await req.json()) as JsonUploadPayload;

    if (!file || typeof file !== 'string') {
      return Response.json(
        { error: 'Invalid JSON. Must include "file" (base64) and optional "fileName"' },
        { status: 400 },
      );
    }

    const { base64Data, mimeType: rawMimeType } = parseBase64File(file);
    const estimatedSizeBytes = Math.floor((base64Data.length * 3) / 4);
    if (
      estimatedSizeBytes > JSON_UPLOAD_LIMIT_BYTES ||
      estimatedSizeBytes > config.maxRequestBodyBytes
    ) {
      return Response.json(
        {
          error:
            'JSON base64 uploads are limited to 50MB. Use multipart/form-data for larger files',
        },
        { status: 400 },
      );
    }

    const fileBytes = Buffer.from(base64Data, 'base64');
    const hash = computeHash(fileBytes);

    const existingFile = await fileRepository.findByHash(hash);
    if (existingFile) {
      return Response.json(buildUploadResponse(existingFile, config.baseUrl), { status: 200 });
    }

    const fileTypeRaw = getFileType(rawMimeType, fileName);
    const fileType = fileTypeRaw === 'application' ? 'document' : fileTypeRaw;

    const { fileName: finalFileName, mimeType } = ensureExtension(fileName, fileBytes, rawMimeType);

    if (!checkFileSize(fileBytes.byteLength, fileType)) {
      return Response.json({ error: `File size exceeds ${fileType} limit` }, { status: 400 });
    }

    const prepared = await writeBufferToTemp(fileBytes, hash);

    if (prepared.sizeBytes > config.telegramChunkSizeBytes) {
      const uploadedFile = await chunkedStorage.storeFileInTelegramChunks({
        tempPath: prepared.tempPath,
        partFileNamePrefix: `direct-${prepared.fileHash?.slice(0, 16) || 'json'}`,
        fileName: finalFileName,
        mimeType,
        sizeBytes: prepared.sizeBytes,
        fileType,
        uploaderId: 0,
      });
      await cleanupTempFile(prepared.tempPath);
      return Response.json(buildUploadResponse(uploadedFile, config.baseUrl), { status: 200 });
    }

    const uploaded = await uploadBatcher.enqueuePreparedUpload({
      prepared,
      fileName: finalFileName,
      mimeType,
      fileType,
    });

    return Response.json(buildUploadResponse(uploaded, config.baseUrl), { status: 200 });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    logger.error('JSON upload error', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
};

/**
 * Main upload request handler.
 *
 * Dispatches to either the multipart or JSON handler based on the request
 * Content-Type header, returning an appropriate error for unsupported
 * content types.
 *
 * Recording of upload metrics is handled centrally in this function.
 *
 * @param req - The incoming HTTP request.
 * @returns A JSON response with the uploaded file metadata or an error.
 */
export const handleUpload = async (req: Request): Promise<Response> => {
  const startTime = performance.now();
  try {
    const contentType = req.headers.get('content-type') || '';
    const oversizedResponse = rejectOversizedRequest(req);
    if (oversizedResponse) return oversizedResponse;

    if (contentType.includes('multipart/form-data')) {
      return handleMultipartUpload(req);
    } else if (contentType.includes('application/json')) {
      return handleJSONUpload(req);
    }

    return Response.json(
      { error: 'Unsupported content type. Use multipart/form-data or application/json' },
      { status: 400 },
    );
  } catch (error: unknown) {
    metricsCollector.recordError();
    const message = getErrorMessage(error);
    logger.error('Upload error', { error: message });
    return Response.json({ error: message }, { status: 500 });
  } finally {
    metricsCollector.recordUploadTime(performance.now() - startTime);
  }
};
