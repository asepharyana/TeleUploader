import { createReadStream } from 'node:fs';
import { nanoid } from 'nanoid';
import type { TelegramFileInfo } from '../../../domain/ports/telegram-service';
import { fileInfoCache } from '../../../infrastructure/cache/index';
import { chunkedStorage, fileRepository } from '../../../infrastructure/di';
import { botPool } from '../../../infrastructure/telegram/bot-pool';
import logger from '../../../shared/logger/index';
import { cleanupTempFile, formatCreatedAt, getErrorMessage } from '../../../shared/utils/file';
import { locateZipEntry } from '../../../shared/utils/zip';

/**
 * Extended Request type that includes route parameter access.
 */
type RequestWithParams = Request & {
  /** Route parameters extracted by the router. */
  params?: {
    /** Public file identifier. */
    public_id?: string;
  };
};

/**
 * Resolves Telegram file metadata for a given file ID, using the in-memory
 * cache to avoid repeated API calls to Telegram.
 *
 * @param telegramFileId - The Telegram file identifier to resolve.
 * @param publicId - The public file ID (used for logging).
 * @returns The resolved Telegram file info.
 */
const getTelegramFileInfo = async (
  telegramFileId: string,
  publicId: string,
): Promise<TelegramFileInfo> => {
  const cacheKey = `file_info_${telegramFileId}`;
  const cached = fileInfoCache.get(cacheKey) as TelegramFileInfo | null;

  if (cached) {
    logger.debug('File info from cache', { publicId, cacheKey });
    return cached;
  }

  const fileInfo = await botPool.getFileInfo(telegramFileId);
  fileInfoCache.set(cacheKey, fileInfo);
  logger.debug('File info cached', { publicId, cacheKey });

  return fileInfo;
};

/**
 * Builds a Telegram CDN download URL from a file path and bot token.
 *
 * @param filePath - The Telegram file path returned by getFile.
 * @param botToken - The bot token used to authenticate the download.
 * @returns The full Telegram CDN URL.
 */
const buildTelegramFileUrl = (filePath: string, botToken: string): string =>
  `https://api.telegram.org/file/bot${botToken}/${filePath}`;

/**
 * Sanitises a file name for use in a Content-Disposition header, removing
 * characters that could enable header injection.
 *
 * @param fileName - The raw file name.
 * @returns The sanitised file name.
 */
const sanitizeFilenameHeader = (fileName: string): string =>
  fileName.replace(/[\\"]/g, '').replace(/[\n\r]/g, '');

/**
 * Returns a JSON error response with the given status code and message.
 *
 * @param status - HTTP status code.
 * @param error - Error message.
 * @returns A JSON Response.
 */
const fail = (status: number, error: string): Response => Response.json({ error }, { status });

/**
 * Handles file redirect requests.
 *
 * Looks up a file by its public identifier and determines the best delivery
 * method:
 * - **chunked** files are streamed via the chunked-object response builder.
 * - **archive-entry** files are extracted from a Telegram-stored zip archive
 *   and streamed as a single file.
 * - **regular** files are redirected to the Telegram CDN URL (302).
 *
 * @param req - The incoming HTTP request with a `public_id` route parameter.
 * @returns A redirect or streaming response, or a JSON error.
 */
export const handleFileRedirect = async (req: RequestWithParams): Promise<Response> => {
  const publicId = req.params?.public_id;
  try {
    if (!publicId) {
      return fail(400, 'Missing file id');
    }

    const file = await fileRepository.findByPublicId(publicId);
    if (!file) {
      logger.warn('File not found', { publicId });
      return fail(404, 'File not found');
    }

    if (file.storageBackend === 'chunked') {
      if (file.archiveEntryName) {
        return fail(501, 'Archive entry extraction is not supported for chunked files');
      }
      const range = { type: 'none' as const };
      return chunkedStorage.createChunkedObjectResponse({ file, range, reqId: '' });
    }

    const archiveEntryName = file.archiveEntryName;
    if (archiveEntryName) {
      const archiveFileId = file.archiveTelegramFileId || file.telegramFileId;
      const archiveInfo = await getTelegramFileInfo(archiveFileId, publicId);
      const archiveResponse = await fetch(
        buildTelegramFileUrl(archiveInfo.file_path, archiveInfo.bot_token),
      );

      if (!archiveResponse.ok) {
        logger.error('Archive download failed', { publicId, status: archiveResponse.status });
        return fail(500, 'Server error');
      }

      const tempZipPath = `/tmp/filedrop-dl-${nanoid()}.zip`;
      await Bun.write(tempZipPath, archiveResponse);

      const loc = await locateZipEntry(tempZipPath, archiveEntryName);
      if (!loc) {
        await cleanupTempFile(tempZipPath);
        logger.error('Archive entry not found', { publicId, archiveEntryName });
        return fail(404, 'File not found');
      }

      const fileStream = createReadStream(tempZipPath, {
        start: loc.start,
        end: loc.start + loc.length - 1,
      });

      fileStream.on('close', () => {
        void cleanupTempFile(tempZipPath);
      });
      fileStream.on('error', () => {
        void cleanupTempFile(tempZipPath);
      });

      return new Response(fileStream as unknown as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type': file.mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${sanitizeFilenameHeader(file.fileName)}"`,
          'Content-Length': String(loc.length),
        },
      });
    }

    const fileInfo = await getTelegramFileInfo(file.telegramFileId, publicId);
    const redirectUrl = buildTelegramFileUrl(fileInfo.file_path, fileInfo.bot_token);

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl,
      },
    });
  } catch (error: unknown) {
    logger.error('File redirect error', { publicId, error: getErrorMessage(error) });
    return fail(500, 'Server error');
  }
};

/**
 * Handles file info requests.
 *
 * Looks up a file by its public identifier and returns its metadata as JSON.
 *
 * @param req - The incoming HTTP request with a `public_id` route parameter.
 * @returns A JSON response with file metadata, or 404 when not found.
 */
export const handleFileInfo = async (req: RequestWithParams): Promise<Response> => {
  const publicId = req.params?.public_id;
  try {
    if (!publicId) {
      return fail(400, 'Missing file id');
    }

    const file = await fileRepository.findByPublicId(publicId);
    if (!file) {
      logger.warn('File not found', { publicId });
      return fail(404, 'File not found');
    }

    return Response.json(
      {
        public_id: file.publicId,
        file_name: file.fileName,
        mime_type: file.mimeType,
        size_bytes: file.sizeBytes,
        file_type: file.fileType,
        created_at: formatCreatedAt(file.createdAt),
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    logger.error('File info error', { publicId, error: getErrorMessage(error) });
    return fail(500, 'Server error');
  }
};
