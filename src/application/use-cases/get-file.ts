import type { File } from '../../domain/entities/file';
import type { IFileRepository } from '../../domain/ports/file-repository';
import type { ITelegramService, TelegramFileInfo } from '../../domain/ports/telegram-service';

/**
 * Result type for a simple file-info lookup.
 */
export interface FileInfoResult {
  /** Whether the file was found. */
  found: true;
  /** Public unique identifier. */
  publicId: string;
  /** Original file name. */
  fileName: string;
  /** MIME type. */
  mimeType: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Telegram file type (document, photo, video, etc.). */
  fileType: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/**
 * Result type for a file-not-found lookup.
 */
export interface FileNotFoundResult {
  /** Always `false` for a not-found result. */
  found: false;
}

/**
 * Discriminated union of all possible file-info lookup outcomes.
 */
export type GetFileInfoResult = FileInfoResult | FileNotFoundResult;

/**
 * Describes a redirect-based file retrieval.
 */
export interface RedirectRetrieval {
  /** Discriminant. */
  type: 'redirect';
  /** The resolved file entity. */
  file: File;
  /** Full Telegram CDN URL to redirect the client to. */
  redirectUrl: string;
  /** Cached Telegram file metadata. */
  fileInfo: TelegramFileInfo;
}

/**
 * Describes a chunked file retrieval that needs a multi-part response.
 */
export interface ChunkedRetrieval {
  /** Discriminant. */
  type: 'chunked';
  /** The resolved file entity. */
  file: File;
}

/**
 * Describes an archive-entry file retrieval.
 */
export interface ArchiveEntryRetrieval {
  /** Discriminant. */
  type: 'archive-entry';
  /** The resolved file entity. */
  file: File;
  /** Telegram file metadata for the archive container. */
  archiveInfo: TelegramFileInfo;
  /** Name of the entry within the archive. */
  entryName: string;
}

/**
 * Discriminated union of all possible file retrieval outcomes.
 */
export type FileRetrievalResult = RedirectRetrieval | ChunkedRetrieval | ArchiveEntryRetrieval;

/** Subset of application configuration consumed by the get-file use case. */
export interface GetFileConfig {
  /** Server base URL (used in constructing archive download URLs). */
  baseUrl: string;
}

/** Dependencies required by the get-file use case factory. */
export interface GetFileUseCaseDeps {
  /** File repository for looking up file records. */
  fileRepo: IFileRepository;
  /** Telegram service for resolving file identifiers to download paths. */
  telegramService: ITelegramService;
  /** Application configuration subset. */
  config: GetFileConfig;
}

/**
 * Creates a factory function for the get-file info use case.
 *
 * Looks up a file by its public identifier and returns its metadata.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting a public ID and returning file info.
 */
export function createGetFileInfoUseCase(deps: Pick<GetFileUseCaseDeps, 'fileRepo'>) {
  return async (publicId: string): Promise<GetFileInfoResult> => {
    const file = await deps.fileRepo.findByPublicId(publicId);
    if (!file) {
      return { found: false };
    }

    return {
      found: true,
      publicId: file.publicId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      fileType: file.fileType,
      createdAt: formatCreatedAtForInfo(file.createdAt),
    };
  };
}

/**
 * Formats a date-like value into an ISO-8601 string.
 *
 * @param date - A Date instance, date string, or numeric timestamp.
 * @returns The ISO-8601 string.
 */
const formatCreatedAtForInfo = (date: Date | string | number): string => {
  if (date instanceof Date) return date.toISOString();
  return new Date(date).toISOString();
};

/**
 * Creates a factory function for the get-file retrieval use case.
 *
 * Determines how a file should be delivered to the client:
 * - **redirect**: For regular (non-chunked, non-archive) files — returns a
 *   Telegram CDN redirect URL.
 * - **chunked**: For files stored across multiple Telegram parts — returns
 *   the file entity so the caller can build a multi-part streaming response.
 * - **archive-entry**: For files stored inside a Telegram archive (zip) —
 *   returns the archive's Telegram metadata and the entry name so the caller
 *   can extract and stream the entry.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting a public ID and returning a retrieval result.
 */
export function createGetFileUseCase(deps: GetFileUseCaseDeps) {
  return async (publicId: string): Promise<FileRetrievalResult | null> => {
    const file = await deps.fileRepo.findByPublicId(publicId);
    if (!file) {
      return null;
    }

    // Chunked file — return the entity for multi-part response building
    if (file.storageBackend === 'chunked') {
      return { type: 'chunked', file };
    }

    // Archive entry — resolve the archive's Telegram location
    const archiveEntryName = file.archiveEntryName;
    if (archiveEntryName) {
      const archiveFileId = file.archiveTelegramFileId || file.telegramFileId;
      const archiveInfo = await deps.telegramService.getFileInfo(archiveFileId);
      return { type: 'archive-entry', file, archiveInfo, entryName: archiveEntryName };
    }

    // Regular file — resolve Telegram CDN path for a redirect
    const fileInfo = await deps.telegramService.getFileInfo(file.telegramFileId);
    const redirectUrl = `https://api.telegram.org/file/bot${fileInfo.bot_token}/${fileInfo.file_path}`;

    return { type: 'redirect', file, redirectUrl, fileInfo };
  };
}
