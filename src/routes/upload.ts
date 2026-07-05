import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { findFileByHash } from '../db/files';
import { config } from '../env';
import {
  buildUploadResponse,
  checkFileSize,
  computeHash,
  ensureExtension,
  extractMimeType,
  getErrorMessage,
  getFileType,
} from '../utils/file';
import logger from '../utils/logger';
import { enqueuePreparedUpload, type PreparedUpload } from '../utils/uploadBatcher';

interface JsonUploadPayload {
  file?: unknown;
  fileName?: string;
}

const parseBase64File = (file: string): { base64Data: string; mimeType: string } => {
  if (!file.startsWith('data:')) {
    return { base64Data: file, mimeType: 'application/octet-stream' };
  }

  const match = file.match(/^data:([^;]+);base64,(.+)$/);
  return match
    ? { base64Data: match[2], mimeType: match[1] }
    : { base64Data: file, mimeType: 'application/octet-stream' };
};

const normalizeFileType = (mimeType: string, fileName: string): string => {
  const fileType = getFileType(mimeType, fileName);
  return fileType === 'application' ? 'document' : fileType;
};

const JSON_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const SIGNATURE_BYTES = 16;

const getContentLength = (req: Request): number | null => {
  const value = req.headers.get('content-length');
  if (!value) return null;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const rejectOversizedRequest = (req: Request): Response | null => {
  const contentLength = getContentLength(req);
  if (contentLength !== null && contentLength > config.maxRequestBodyBytes) {
    return Response.json({ error: 'Request body too large' }, { status: 413 });
  }

  return null;
};

const cleanupTempFile = async (tempPath: string): Promise<void> => {
  try {
    await unlink(tempPath);
  } catch (err) {
    logger.warn('Failed to cleanup temp file', { tempPath, error: getErrorMessage(err) });
  }
};

const streamFileToTemp = async (file: File, maxSizeBytes: number): Promise<PreparedUpload> => {
  const tempPath = `/tmp/teleuploader-${nanoid()}`;
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

const writeBufferToTemp = async (fileBuffer: Buffer, fileHash: string): Promise<PreparedUpload> => {
  const tempPath = `/tmp/teleuploader-${nanoid()}`;
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

export const handleUpload = async (req: Request): Promise<Response> => {
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
    const message = getErrorMessage(error);
    logger.error('Upload error', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
};

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

    const existingFile = await findFileByHash(prepared.fileHash);
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

    const uploaded = await enqueuePreparedUpload({
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

    const existingFile = await findFileByHash(hash);
    if (existingFile) {
      return Response.json(buildUploadResponse(existingFile, config.baseUrl), { status: 200 });
    }

    const { fileName: finalFileName, mimeType } = ensureExtension(fileName, fileBytes, rawMimeType);
    const fileType = normalizeFileType(mimeType, finalFileName);

    if (!checkFileSize(fileBytes.byteLength, fileType)) {
      return Response.json({ error: `File size exceeds ${fileType} limit` }, { status: 400 });
    }

    const prepared = await writeBufferToTemp(fileBytes, hash);
    const uploaded = await enqueuePreparedUpload({
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
