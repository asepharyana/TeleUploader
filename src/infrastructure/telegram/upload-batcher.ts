import { createReadStream } from 'node:fs';
import { nanoid } from 'nanoid';
import type { File as FileEntity, NewFile } from '../../domain/entities/file';
import type { IFileRepository } from '../../domain/ports/file-repository';
import type { ITelegramService } from '../../domain/ports/telegram-service';
import { config } from '../../env';
import { cleanupTempFile } from '../../shared/utils/file';
import { createZip, type ZipEntry } from '../../shared/utils/zip';

/**
 * Metadata about a prepared upload before it is submitted to the batcher.
 */
export type PreparedUpload = {
  /** Temporary file path on disk */
  tempPath: string;
  /** SHA-256 hash of the file contents */
  fileHash: string;
  /** File size in bytes */
  sizeBytes: number;
  /** First bytes of the file for MIME detection */
  signatureBuffer: Buffer;
};

/**
 * A fully materialised file record returned from the batcher.
 */
export type UploadedFile = FileEntity;

/**
 * An item ready for batched upload to Telegram storage.
 */
export type BatchUploadItem = {
  /** Prepared upload metadata */
  prepared: PreparedUpload;
  /** Original file name */
  fileName: string;
  /** MIME type of the file */
  mimeType: string;
  /** File type classification (e.g. "document", "photo") */
  fileType: string;
};

/**
 * Internal pending upload tracking type, extending BatchUploadItem
 * with resolve/reject callbacks.
 */
type PendingUpload = BatchUploadItem & {
  resolve: (file: FileEntity) => void;
  reject: (error: unknown) => void;
};

/** Time window in milliseconds during which uploads are batched together. */
const BATCH_WINDOW_MS = 2000;

/**
 * Batches multiple file uploads into a single ZIP archive before forwarding
 * them to Telegram storage. This reduces the number of Telegram API calls
 * and improves throughput for small-file workloads.
 *
 * Injects dependencies via constructor — can be used with any
 * {@link IFileRepository} and {@link ITelegramService} implementation.
 */
export class UploadBatcher {
  private readonly pendingUploads: PendingUpload[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param fileRepository - Repository for persisting file records.
   * @param telegramService - Service for forwarding files to Telegram storage.
   */
  constructor(
    private readonly fileRepository: IFileRepository,
    private readonly telegramService: ITelegramService,
  ) {}

  /**
   * Build a NewFile record from a batch item and its archive metadata.
   *
   * @param item - The batched upload item.
   * @param entry - ZIP entry metadata for the individual file.
   * @param archive - Archive-level Telegram storage metadata.
   * @returns A NewFile record ready for repository insertion.
   */
  private buildUploadedFile(
    item: BatchUploadItem,
    entry: ZipEntry,
    archive: {
      telegramFileId: string;
      telegramFileUniqueId: string;
      storageMessageId: number;
      fileName: string;
      sizeBytes: number;
    },
  ): NewFile {
    return {
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
      bucketId: null,
      s3Key: null,
      storageBackend: null,
      isDeleted: null,
      multipartUploadId: null,
      partCount: null,
    };
  }

  /**
   * Flush all pending uploads by zipping them together and sending
   * the archive to Telegram storage.
   */
  private async flushUploads(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const batch = this.pendingUploads.splice(0);
    if (batch.length === 0) return;

    let zipTempPath: string | null = null;

    try {
      const zip = await createZip(
        batch.map((item) => ({ tempPath: item.prepared.tempPath, fileName: item.fileName })),
      );
      zipTempPath = zip.tempPath;
      const archiveFileName = `filedrop-${nanoid()}.zip`;
      const archiveResult = await this.telegramService.forwardToStorage(
        createReadStream(zip.tempPath),
        archiveFileName,
        'document',
      );

      const newFileInputs = batch.map((item, index) =>
        this.buildUploadedFile(item, zip.entries[index], {
          telegramFileId: archiveResult.telegramFileId,
          telegramFileUniqueId: archiveResult.telegramFileUniqueId,
          storageMessageId: archiveResult.storageMessageId,
          fileName: archiveFileName,
          sizeBytes: zip.sizeBytes,
        }),
      );

      // Persist each file record through the repository
      const createdFiles = await Promise.all(
        newFileInputs.map((input) => this.fileRepository.create(input)),
      );

      for (let i = 0; i < batch.length; i++) {
        batch[i].resolve(createdFiles[i]);
      }
    } catch (error) {
      for (const item of batch) {
        item.reject(error);
      }
    } finally {
      await Promise.all(batch.map((item) => cleanupTempFile(item.prepared.tempPath)));
      if (zipTempPath) await cleanupTempFile(zipTempPath);
      // Reschedule timer if new items arrived during async processing
      if (this.pendingUploads.length > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          void this.flushUploads();
        }, BATCH_WINDOW_MS);
      }
    }
  }

  /**
   * Calculate total size of all pending uploads in bytes.
   *
   * @returns The sum of all pending file sizes.
   */
  private getPendingSize(): number {
    return this.pendingUploads.reduce((total, item) => total + item.prepared.sizeBytes, 0);
  }

  /**
   * Enqueue a prepared upload for batched processing.
   *
   * The upload is held for up to {@link BATCH_WINDOW_MS} milliseconds
   * (or until the batch size/byte thresholds in config are exceeded)
   * before being flushed to Telegram storage.
   *
   * @param item - The prepared upload item to enqueue.
   * @returns A promise that resolves with the fully created File record.
   */
  enqueuePreparedUpload(item: BatchUploadItem): Promise<FileEntity> {
    return new Promise<FileEntity>((resolve, reject) => {
      this.pendingUploads.push({ ...item, resolve, reject });

      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          void this.flushUploads();
        }, BATCH_WINDOW_MS);
      }

      if (
        this.pendingUploads.length >= config.batchMaxItems ||
        this.getPendingSize() >= config.batchMaxSizeBytes
      ) {
        void this.flushUploads();
      }
    });
  }

  /**
   * Immediately flush all pending uploads, regardless of batch size.
   *
   * @returns A promise that resolves when the flush is complete.
   */
  async flushPendingUploads(): Promise<void> {
    await this.flushUploads();
  }

  /**
   * Get the number of uploads currently waiting in the batch queue.
   *
   * @returns The pending upload count.
   */
  getPendingUploadCount(): number {
    return this.pendingUploads.length;
  }
}
