import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { findFileByPublicId } from '../db/files';
import { fileInfoCache } from '../utils/cache';
import { formatCreatedAt, getErrorMessage } from '../utils/file';
import logger from '../utils/logger';
import { getFileInfo } from '../utils/telegram';
import { locateZipEntry } from '../utils/zip';

type RequestWithParams = Request & {
  params?: {
    public_id?: string;
  };
};

const getTelegramFileInfo = async (telegramFileId: string, public_id: string) => {
  const cacheKey = `file_info_${telegramFileId}`;
  let fileInfo = fileInfoCache.get(cacheKey) as any;

  if (!fileInfo) {
    fileInfo = await getFileInfo(telegramFileId);
    fileInfoCache.set(cacheKey, fileInfo);
    logger.debug('File info cached', { public_id, cacheKey });
  } else {
    logger.debug('File info from cache', { public_id, cacheKey });
  }

  return fileInfo as { file_size: number; mime_type: string; file_path: string; bot_token: string };
};

const buildTelegramFileUrl = (filePath: string, botToken: string): string =>
  `https://api.telegram.org/file/bot${botToken}/${filePath}`;

const cleanupTempFile = async (tempPath: string): Promise<void> => {
  try {
    await unlink(tempPath);
  } catch (err) {
    logger.warn('Failed to cleanup temp file', { tempPath, error: getErrorMessage(err) });
  }
};

const sanitizeFilenameHeader = (fileName: string): string =>
  fileName.replace(/[\\"]/g, '').replace(/[\n\r]/g, '');

const fail = (status: number, error: string): Response =>
  Response.json({ error }, { status });

export const handleFileRedirect = async (req: RequestWithParams): Promise<Response> => {
  const public_id = req.params?.public_id;
  try {
    if (!public_id) {
      return fail(400, 'Missing file id');
    }

    const file = await findFileByPublicId(public_id);
    if (!file) {
      logger.warn('File not found', { public_id });
      return fail(404, 'File not found');
    }

    const archiveEntryName = file.archiveEntryName;
    if (archiveEntryName) {
      const archiveFileId = file.archiveTelegramFileId || file.telegramFileId;
      const archiveInfo = await getTelegramFileInfo(archiveFileId, public_id);
      const archiveResponse = await fetch(
        buildTelegramFileUrl(archiveInfo.file_path, archiveInfo.bot_token),
      );

      if (!archiveResponse.ok) {
        logger.error('Archive download failed', { public_id, status: archiveResponse.status });
        return fail(500, 'Server error');
      }

      const tempZipPath = `/tmp/teleuploader-dl-${nanoid()}.zip`;
      await Bun.write(tempZipPath, archiveResponse);

      const loc = await locateZipEntry(tempZipPath, archiveEntryName);
      if (!loc) {
        await cleanupTempFile(tempZipPath);
        logger.error('Archive entry not found', { public_id, archiveEntryName });
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

      return new Response(fileStream as any, {
        status: 200,
        headers: {
          'Content-Type': file.mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${sanitizeFilenameHeader(file.fileName)}"`,
          'Content-Length': String(loc.length),
        },
      });
    }

    const fileInfo = await getTelegramFileInfo(file.telegramFileId, public_id);
    const redirectUrl = buildTelegramFileUrl(fileInfo.file_path, fileInfo.bot_token);

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl,
      },
    });
  } catch (error: unknown) {
    logger.error('File redirect error', { public_id, error: getErrorMessage(error) });
    return fail(500, 'Server error');
  }
};

export const handleFileInfo = async (req: RequestWithParams): Promise<Response> => {
  const public_id = req.params?.public_id;
  try {
    if (!public_id) {
      return fail(400, 'Missing file id');
    }

    const file = await findFileByPublicId(public_id);
    if (!file) {
      logger.warn('File not found', { public_id });
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
    logger.error('File info error', { public_id, error: getErrorMessage(error) });
    return fail(500, 'Server error');
  }
};
