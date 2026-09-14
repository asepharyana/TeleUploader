import { nanoid } from 'nanoid';
import { createUploadFileUseCase } from '../../../application/use-cases/upload-file';
import { config } from '../../../env';
import { chunkedStorage, fileRepository, telegramService } from '../../../infrastructure/di';
import logger from '../../../shared/logger/index';
import { metricsCollector } from '../../../shared/metrics/index';
import {
  buildUploadResponse,
  checkFileSize,
  computeHash,
  ensureExtension,
  extractMimeType,
  getErrorMessage,
  getFileType,
} from '../../../shared/utils/file';
import { streamToTemp } from '../../../shared/utils/temp-stream';
import { JsonUploadPayloadSchema } from '../../../shared/validation/schemas';

/**
 * Maximum allowed size (in bytes) for a base64 JSON upload.
 * JSON uploads are limited to 50 MB because base64 encoding adds ~33%
 * overhead and large payloads strain the JSON parser.
 */
const JSON_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

/** Number of leading bytes read for magic-byte / signature detection. */
const SIGNATURE_BYTES = 16;

/** Lazily built upload use case wired to the DI singletons. */
const getUploadUseCase = () =>
  createUploadFileUseCase({
    fileRepo: fileRepository,
    telegramService,
    chunkedStorage,
    config: {
      baseUrl: config.baseUrl,
      telegramChunkSizeBytes: config.telegramChunkSizeBytes,
      storageChatId: config.storageChatId,
      compressChunkedUploads: config.compressChunkedUploads,
      chunkCompressionMinSizeBytes: config.chunkCompressionMinSizeBytes,
    },
  });

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
 * Handles a multipart/form-data file upload.
 *
 * Steps:
 * 1. Parse the multipart form and extract the file.
 * 2. Stream the file to a temp location, computing its hash.
 * 3. Delegate to the upload use case (dedup `hash`) and return its response.
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

    const prepared = await streamToTemp(file.stream().getReader(), {
      maxSizeBytes: config.maxRequestBodyBytes,
    });

    const rawMimeType = file.type || extractMimeType({}, req) || 'application/octet-stream';
    const output = await getUploadUseCase()({
      tempPath: prepared.tempPath,
      fileHash: prepared.fileHash,
      fileName,
      mimeType: rawMimeType,
      sizeBytes: prepared.sizeBytes,
      uploaderId: 0,
      dedup: 'hash',
      signatureBuffer: prepared.signatureBuffer,
    });

    // The use case is the single source of truth for stored metadata —
    // build the response directly from its output, not a synthetic record.
    return Response.json(buildUploadResponse(output, config.baseUrl), { status: 200 });
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
 * 1. Parse and validate the JSON body (must include base64 `file`).
 * 2. Decode, check size limits, and stage to a temp file.
 * 3. Delegate to the upload use case (dedup `hash`) and return its response.
 *
 * @param req - The incoming HTTP request with a JSON body.
 * @returns A JSON response with the uploaded file metadata.
 */
const handleJSONUpload = async (req: Request): Promise<Response> => {
  try {
    const parsed = JsonUploadPayloadSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json(
        { error: 'Invalid JSON. Must include "file" (base64) and optional "fileName"' },
        { status: 400 },
      );
    }
    const { file, fileName } = parsed.data;

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

    const fileTypeRaw = getFileType(rawMimeType, fileName);
    const fileType = fileTypeRaw === 'application' ? 'document' : fileTypeRaw;

    const { fileName: finalFileName, mimeType } = ensureExtension(fileName, fileBytes, rawMimeType);

    if (!checkFileSize(fileBytes.byteLength, fileType)) {
      return Response.json({ error: `File size exceeds ${fileType} limit` }, { status: 400 });
    }

    const tempPath = `/tmp/teleuploader-${nanoid()}`;
    await Bun.write(tempPath, fileBytes);
    const output = await getUploadUseCase()({
      tempPath,
      fileHash: hash,
      fileName: finalFileName,
      mimeType,
      sizeBytes: fileBytes.byteLength,
      uploaderId: 0,
      dedup: 'hash',
      signatureBuffer: fileBytes.subarray(0, SIGNATURE_BYTES),
    });

    return Response.json(buildUploadResponse(output, config.baseUrl), { status: 200 });
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
