import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { nanoid } from 'nanoid';
import { db, files as fileSchema } from '../db';
import { insertFileParts, listFileParts, type NewFilePartInput } from '../db/file-parts';
import type { File } from '../db/schema';
import { config } from '../env';
import { botPool } from '../infrastructure/telegram/bot-pool';
import { computeHash } from './file';
import { createGetObjectResponse, type ObjectPartSource } from './s3/object-stream';
import type { RangeParseResult } from './s3/range';

export type ChunkCompressionAlgorithm = 'gzip' | null;

export interface ChunkedUploadPart {
  partNumber: number;
  telegramFileId: string;
  telegramFileUniqueId: string;
  storageMessageId: number;
  sizeBytes: number;
  storedSizeBytes: number;
  compressionAlgorithm: ChunkCompressionAlgorithm;
  etag: string;
}

export interface ChunkedUploadResult {
  parts: ChunkedUploadPart[];
  fileHash: string;
  totalSizeBytes: number;
}

export interface ChunkedFileInput {
  tempPath: string;
  partFileNamePrefix: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  fileType: string;
  uploaderId: number;
  bucketId?: string | null;
  s3Key?: string | null;
}

const asSafeChunkSize = (chunkSizeBytes: number): number => {
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new Error('Invalid Telegram chunk size');
  }
  return chunkSizeBytes;
};

const maybeCompressChunk = (
  chunk: Buffer,
  compress: boolean,
  compressionMinSizeBytes: number,
): { bytes: Buffer; compressionAlgorithm: ChunkCompressionAlgorithm } => {
  if (!compress || chunk.byteLength < compressionMinSizeBytes) {
    return { bytes: chunk, compressionAlgorithm: null };
  }

  const gzipped = gzipSync(chunk);
  if (gzipped.byteLength >= chunk.byteLength) {
    return { bytes: chunk, compressionAlgorithm: null };
  }

  return { bytes: gzipped, compressionAlgorithm: 'gzip' };
};

export const uploadFileInTelegramChunks = async (input: {
  tempPath: string;
  partFileNamePrefix: string;
  chunkSizeBytes: number;
  compress: boolean;
  compressionMinSizeBytes: number;
}): Promise<ChunkedUploadResult> => {
  const chunkSizeBytes = asSafeChunkSize(input.chunkSizeBytes);
  const hasher = new Bun.CryptoHasher('sha256');
  const parts: ChunkedUploadPart[] = [];
  let totalSizeBytes = 0;
  let partNumber = 0;

  const stream = createReadStream(input.tempPath, { highWaterMark: chunkSizeBytes });

  // Concurrent upload set: tracks in-flight uploads and limits how many
  // chunks are being uploaded at once from this single file.
  const inFlight = new Set<Promise<void>>();

  for await (const data of stream) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
    if (chunk.byteLength === 0) continue;

    partNumber += 1;
    totalSizeBytes += chunk.byteLength;
    hasher.update(chunk);

    const { bytes, compressionAlgorithm } = maybeCompressChunk(
      chunk,
      input.compress,
      input.compressionMinSizeBytes,
    );
    const currentPart = partNumber;

    // Fire upload concurrently — don't await inside the read loop
    const uploadPromise = botPool
      .forwardToStorage(bytes, `${input.partFileNamePrefix}.part-${currentPart}`, 'document')
      .then((forwardResult) => {
        parts.push({
          partNumber: currentPart,
          telegramFileId: forwardResult.telegramFileId,
          telegramFileUniqueId: forwardResult.telegramFileUniqueId,
          storageMessageId: forwardResult.storageMessageId,
          sizeBytes: chunk.byteLength,
          storedSizeBytes: bytes.byteLength,
          compressionAlgorithm,
          etag: computeHash(chunk),
        });
      });

    // Clean up from in-flight set when done (regardless of success/failure)
    const trackPromise = uploadPromise.finally(() => {
      inFlight.delete(trackPromise);
    });

    inFlight.add(trackPromise);

    // Backpressure: if too many chunks are in-flight, wait for one to
    // finish before reading more — prevents unbounded memory growth.
    if (inFlight.size >= config.uploadConcurrency * 2) {
      await Promise.race(inFlight);
    }
  }

  // Wait for all remaining uploads to finish
  await Promise.all(inFlight);

  return {
    parts,
    fileHash: hasher.digest('hex'),
    totalSizeBytes,
  };
};

export const storeFileInTelegramChunks = async (input: ChunkedFileInput): Promise<File> => {
  const upload = await uploadFileInTelegramChunks({
    tempPath: input.tempPath,
    partFileNamePrefix: input.partFileNamePrefix,
    chunkSizeBytes: config.telegramChunkSizeBytes,
    compress: config.compressChunkedUploads,
    compressionMinSizeBytes: config.chunkCompressionMinSizeBytes,
  });

  const firstPart = upload.parts[0];
  if (!firstPart) {
    throw new Error('Chunked upload produced no parts');
  }

  const now = new Date();
  const fileId = randomUUID();
  const publicId = nanoid();
  const file: File = {
    id: fileId,
    publicId,
    telegramFileId: firstPart.telegramFileId,
    telegramFileUniqueId: firstPart.telegramFileUniqueId,
    storageChatId: config.storageChatId,
    storageMessageId: firstPart.storageMessageId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: upload.totalSizeBytes,
    fileType: input.fileType,
    uploaderId: input.uploaderId,
    fileHash: upload.fileHash,
    archiveTelegramFileId: null,
    archiveStorageMessageId: null,
    archiveFileName: null,
    archiveEntryName: null,
    archiveMimeType: null,
    archiveSizeBytes: null,
    bucketId: input.bucketId ?? null,
    s3Key: input.s3Key ?? null,
    storageBackend: 'chunked',
    isDeleted: false,
    multipartUploadId: null,
    partCount: upload.parts.length,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(fileSchema).values(file);

  const fileParts: NewFilePartInput[] = upload.parts.map((part) => ({
    fileId,
    partNumber: part.partNumber,
    telegramFileId: part.telegramFileId,
    telegramFileUniqueId: part.telegramFileUniqueId,
    storageChatId: config.storageChatId,
    storageMessageId: part.storageMessageId,
    sizeBytes: part.sizeBytes,
    storedSizeBytes: part.storedSizeBytes,
    compressionAlgorithm: part.compressionAlgorithm,
    etag: part.etag,
  }));

  await insertFileParts(fileParts);
  return file;
};

export const buildChunkedObjectSources = async (file: File): Promise<ObjectPartSource[]> => {
  const parts = await listFileParts(file.id);
  const sources: ObjectPartSource[] = [];

  for (const part of parts) {
    const fileInfo = await botPool.getFileInfo(part.telegramFileId);
    sources.push({
      telegramFileId: part.telegramFileId,
      telegramUrl: `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`,
      sizeBytes: part.sizeBytes,
      storedSizeBytes: part.storedSizeBytes,
      compressionAlgorithm: part.compressionAlgorithm,
      partNumber: part.partNumber,
    });
  }

  return sources;
};

export const createChunkedObjectResponse = async (input: {
  file: File;
  range: RangeParseResult;
  reqId: string;
}): Promise<Response> => {
  const parts = await buildChunkedObjectSources(input.file);
  if (parts.length === 0) {
    throw new Error('Chunked object has no parts');
  }

  return createGetObjectResponse({
    reqId: input.reqId,
    contentType: input.file.mimeType,
    etag: input.file.fileHash || parts.map((p) => p.telegramFileId).join('-'),
    lastModified:
      input.file.createdAt instanceof Date ? input.file.createdAt : new Date(input.file.createdAt),
    totalSize: Number(input.file.sizeBytes),
    parts,
    range: input.range,
  });
};
