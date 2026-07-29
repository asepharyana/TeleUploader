import { createReadStream } from 'node:fs';
import { nanoid } from 'nanoid';
import { db, files as fileSchema } from '../db';
import type { NewFile } from '../db/schema';
import { config } from '../env';
import { botPool } from '../infrastructure/telegram/bot-pool';
import { cleanupTempFile } from './file';
import { createZip, type ZipEntry } from './zip';

export type PreparedUpload = {
  tempPath: string;
  fileHash: string;
  sizeBytes: number;
  signatureBuffer: Buffer;
};

export type UploadedFile = NewFile & {
  createdAt: Date;
  updatedAt: Date;
};

export type BatchUploadItem = {
  prepared: PreparedUpload;
  fileName: string;
  mimeType: string;
  fileType: string;
};

type PendingUpload = BatchUploadItem & {
  resolve: (file: UploadedFile) => void;
  reject: (error: unknown) => void;
};

const BATCH_WINDOW_MS = 2000;

let pendingUploads: PendingUpload[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const buildUploadedFile = (
  item: BatchUploadItem,
  entry: ZipEntry,
  archive: {
    telegramFileId: string;
    telegramFileUniqueId: string;
    storageMessageId: number;
    fileName: string;
    sizeBytes: number;
  },
): UploadedFile => ({
  publicId: nanoid(),
  telegramFileId: archive.telegramFileId,
  telegramFileUniqueId: archive.telegramFileUniqueId,
  storageChatId: config.storageChatId,
  storageMessageId: archive.storageMessageId,
  fileName: item.fileName,
  mimeType: item.mimeType || 'application/octet-stream',
  sizeBytes: item.prepared.sizeBytes,
  fileType: item.fileType,
  uploaderId: 0,
  fileHash: item.prepared.fileHash,
  archiveTelegramFileId: archive.telegramFileId,
  archiveStorageMessageId: archive.storageMessageId,
  archiveFileName: archive.fileName,
  archiveEntryName: entry.entryName,
  archiveMimeType: 'application/zip',
  archiveSizeBytes: archive.sizeBytes,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const flushUploads = async (): Promise<void> => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const batch = pendingUploads;
  pendingUploads = [];
  if (batch.length === 0) return;

  let zipTempPath: string | null = null;

  try {
    const zip = await createZip(
      batch.map((item) => ({ tempPath: item.prepared.tempPath, fileName: item.fileName })),
    );
    zipTempPath = zip.tempPath;
    const archiveFileName = `filedrop-${nanoid()}.zip`;
    const archiveResult = await botPool.forwardToStorage(
      createReadStream(zip.tempPath),
      archiveFileName,
      'document',
    );

    const uploadedFiles = batch.map((item, index) =>
      buildUploadedFile(item, zip.entries[index], {
        telegramFileId: archiveResult.telegramFileId,
        telegramFileUniqueId: archiveResult.telegramFileUniqueId,
        storageMessageId: archiveResult.storageMessageId,
        fileName: archiveFileName,
        sizeBytes: zip.sizeBytes,
      }),
    );

    await db.insert(fileSchema).values(uploadedFiles);

    for (let i = 0; i < batch.length; i++) {
      batch[i].resolve(uploadedFiles[i]);
    }
  } catch (error) {
    for (const item of batch) {
      item.reject(error);
    }
  } finally {
    await Promise.all(batch.map((item) => cleanupTempFile(item.prepared.tempPath)));
    if (zipTempPath) await cleanupTempFile(zipTempPath);
    // Reschedule timer if new items arrived during async processing
    if (pendingUploads.length > 0 && !flushTimer) {
      flushTimer = setTimeout(() => {
        void flushUploads();
      }, BATCH_WINDOW_MS);
    }
  }
};

const getPendingSize = (): number =>
  pendingUploads.reduce((total, item) => total + item.prepared.sizeBytes, 0);

export const enqueuePreparedUpload = (item: BatchUploadItem): Promise<UploadedFile> => {
  return new Promise((resolve, reject) => {
    pendingUploads.push({ ...item, resolve, reject });

    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        void flushUploads();
      }, BATCH_WINDOW_MS);
    }

    if (
      pendingUploads.length >= config.batchMaxItems ||
      getPendingSize() >= config.batchMaxSizeBytes
    ) {
      void flushUploads();
    }
  });
};

export const flushPendingUploads = async (): Promise<void> => {
  await flushUploads();
};

export const getPendingUploadCount = (): number => pendingUploads.length;
