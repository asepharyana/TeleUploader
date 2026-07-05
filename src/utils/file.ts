import { unlink } from 'node:fs/promises';
import logger from './logger';

export const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

export const cleanupTempFile = async (tempPath: string): Promise<void> => {
  try {
    await unlink(tempPath);
  } catch (err) {
    logger.warn('Failed to cleanup temp file', { tempPath, error: getErrorMessage(err) });
  }
};

interface FileMetadata {
  publicId: string;
  telegramFileId: string;
  telegramFileUniqueId: string;
  storageChatId: number;
  storageMessageId: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  fileType: string;
  uploaderId: number;
  createdAt: Date | string | number;
}

const FILE_TYPES: Record<string, number> = {
  document: 2 * 1024 * 1024 * 1024, // 2GB
  photo: 10 * 1024 * 1024, // 10MB
  video: 2 * 1024 * 1024 * 1024, // 2GB
  audio: 200 * 1024 * 1024, // 200MB
  voice: 200 * 1024 * 1024, // 200MB
  animation: 2 * 1024 * 1024 * 1024, // 2GB
  sticker: 10 * 1024 * 1024, // 10MB
  video_note: 2 * 1024 * 1024 * 1024, // 2GB
};

export const getFileType = (mime: string | null, caption?: string): string => {
  const mimeUpper = mime?.split('/')[0]?.toLowerCase();
  const captionLower = caption?.toLowerCase();

  if (mime?.toLowerCase() === 'image/webp' || captionLower?.includes('sticker')) return 'sticker';
  if (captionLower?.includes('video_note')) return 'video_note';
  if (mimeUpper === 'video') return 'video';
  if (mimeUpper === 'audio') return 'audio';
  if (mimeUpper === 'document') return 'document';
  if (mimeUpper === 'image') return captionLower?.includes('gif') ? 'animation' : 'photo';
  if (captionLower?.includes('voice')) return 'voice';
  if (captionLower?.includes('animation')) return 'animation';

  return mimeUpper === 'application' ? 'application' : 'document';
};

export const checkFileSize = (sizeBytes: number, fileType: string): boolean => {
  const limit = FILE_TYPES[fileType] || FILE_TYPES.document;
  return sizeBytes <= limit;
};

export const ensureExtension = (
  fileName: string,
  buffer: Buffer,
  detectedMime?: string,
): { fileName: string; mimeType: string } => {
  const mimeMap: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'text/plain': 'txt',
    'application/zip': 'zip',
  };

  let ext: string | null = null;
  if (buffer.subarray(0, 4).toString() === '%PDF') {
    ext = 'pdf';
  } else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    ext = 'png';
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    ext = 'jpg';
  } else if (buffer.subarray(0, 4).toString() === 'GIF8') {
    ext = 'gif';
  } else if (detectedMime) {
    ext = mimeMap[detectedMime.toLowerCase()] || null;
  }

  let finalFileName = fileName;
  const hasExtension = fileName.includes('.') && fileName.split('.').pop()!.length >= 2;
  if (!hasExtension && ext) {
    finalFileName = `${fileName}.${ext}`;
  }

  const mimeType = ext
    ? Object.keys(mimeMap).find((k) => mimeMap[k] === ext) ||
      detectedMime ||
      'application/octet-stream'
    : detectedMime || 'application/octet-stream';

  return { fileName: finalFileName, mimeType };
};

type HeaderMapRequest = {
  headers?:
    | {
        get?: (name: string) => string | null;
      }
    | Record<string, string>;
};

type FileLike = {
  fileName?: string;
  mimeType?: string;
};

type MessageLike = {
  document?: FileLike;
  photo?: FileLike[];
  audio?: FileLike;
  voice?: FileLike;
  animation?: FileLike;
};

const getHeader = (request: HeaderMapRequest | null, name: string): string | undefined => {
  const headers = request?.headers;
  if (!headers) return undefined;

  const get = 'get' in headers ? headers.get : undefined;
  if (typeof get === 'function') return get(name) || undefined;

  return (headers as Record<string, string>)[name];
};

export const extractFileName = (msg: MessageLike, request: HeaderMapRequest | null): string => {
  const headerFileName = getHeader(request, 'x-file-name');
  if (headerFileName) return headerFileName;

  return (
    msg.document?.fileName ||
    msg.photo?.slice(-1)[0]?.fileName ||
    msg.audio?.fileName ||
    msg.voice?.fileName ||
    msg.animation?.fileName ||
    'file'
  );
};

export const extractMimeType = (msg: MessageLike, request: HeaderMapRequest | null): string => {
  const headerMimeType = getHeader(request, 'x-mime-type');
  if (headerMimeType) return headerMimeType;

  return (
    msg.document?.mimeType ||
    msg.photo?.slice(-1)[0]?.mimeType ||
    msg.audio?.mimeType ||
    msg.voice?.mimeType ||
    msg.animation?.mimeType ||
    'application/octet-stream'
  );
};

export const computeHash = (buffer: Buffer): string => {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(buffer);
  return hasher.digest('hex');
};

export interface TelegramMessageFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

export interface TelegramMediaMessage {
  message_id: number;
  document?: TelegramMessageFile;
  photo?: TelegramMessageFile[];
  video?: TelegramMessageFile;
  audio?: TelegramMessageFile;
  voice?: TelegramMessageFile;
  animation?: TelegramMessageFile;
  sticker?: TelegramMessageFile;
  video_note?: TelegramMessageFile;
}

export const extractFileFromMessage = (
  msg: TelegramMediaMessage,
  fileType: string,
): TelegramMessageFile => {
  if (fileType === 'photo') return msg.photo?.slice(-1)[0] as TelegramMessageFile;
  if (fileType === 'sticker') return msg.sticker as TelegramMessageFile;
  return msg[fileType as keyof TelegramMediaMessage] as TelegramMessageFile;
};

export const detectFileType = (msg: TelegramMediaMessage): string => {
  if (msg.document) return 'document';
  if (msg.photo) return 'photo';
  if (msg.video) return 'video';
  if (msg.audio) return 'audio';
  if (msg.voice) return 'voice';
  if (msg.animation) return 'animation';
  if (msg.sticker) return 'sticker';
  if (msg.video_note) return 'video_note';
  return 'document';
};

export const getFileSizeLimit = (fileType: string): number =>
  FILE_TYPES[fileType] || FILE_TYPES.document;

export const formatCreatedAt = (createdAt: Date | string | number): string => {
  return createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
};

export interface UploadResponse {
  public_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  file_type: string;
  created_at: string;
  download_url: string;
}

export const buildUploadResponse = (file: FileMetadata, baseUrl: string): UploadResponse => {
  return {
    public_id: file.publicId,
    file_name: file.fileName,
    mime_type: file.mimeType,
    size_bytes: file.sizeBytes,
    file_type: file.fileType,
    created_at: formatCreatedAt(file.createdAt),
    download_url: `${baseUrl}/f/${file.publicId}`,
  };
};
