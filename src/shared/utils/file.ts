import { unlink } from 'node:fs/promises';
import logger from '../logger/index';

/**
 * Safely extracts an error message from an unknown value.
 *
 * @param error - The error value (caught exception, rejection reason, etc.).
 * @returns The error message string.
 */
export const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/**
 * Asynchronously removes a temporary file from disk, logging a warning
 * instead of throwing when the operation fails.
 *
 * @param tempPath - Absolute path to the temporary file.
 */
export const cleanupTempFile = async (tempPath: string): Promise<void> => {
  try {
    await unlink(tempPath);
  } catch (err) {
    logger.warn('Failed to cleanup temp file', { tempPath, error: getErrorMessage(err) });
  }
};

/** Metadata describing a stored file record. */
interface FileMetadata {
  /** Public-facing unique identifier. */
  publicId: string;
  /** Telegram file identifier. */
  telegramFileId: string;
  /** Telegram file unique identifier (stable across chats). */
  telegramFileUniqueId: string;
  /** ID of the Telegram chat where the file is stored. */
  storageChatId: number;
  /** Message ID within the storage chat. */
  storageMessageId: number;
  /** Original file name. */
  fileName: string;
  /** MIME type of the file. */
  mimeType: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Telegram-inferred file type (document, photo, video, etc.). */
  fileType: string;
  /** Telegram user ID of the uploader. */
  uploaderId: number;
  /** Timestamp when the record was created. */
  createdAt: Date | string | number;
}

/** Default file type used when no specific type can be determined. */
export const DEFAULT_FILE_TYPE = 'document';

/** Per-file-type size limits in bytes. */
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

/**
 * Determines the Telegram file type from a MIME type and optional caption.
 *
 * The returned string matches one of the keys in `FILE_TYPES` (document,
 * photo, video, audio, voice, animation, sticker, video_note).
 *
 * @param mime - The MIME type string (may be null).
 * @param caption - Optional caption text that may hint at the file type.
 * @returns The inferred Telegram file type.
 */
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

/**
 * Checks whether a file's size is within the allowed limit for its type.
 *
 * @param sizeBytes - File size in bytes.
 * @param fileType - One of the recognised Telegram file type keys.
 * @returns `true` if the file size is within bounds, `false` otherwise.
 */
export const checkFileSize = (sizeBytes: number, fileType: string): boolean => {
  const limit = FILE_TYPES[fileType] || FILE_TYPES.document;
  return sizeBytes <= limit;
};

/**
 * Ensures a file name has a proper extension based on its content.
 *
 * Magic-bytes (PDF, PNG, JPEG, GIF) are detected from the buffer first; if
 * no magic matches, the optional detected MIME type is consulted.
 *
 * @param fileName - The original file name (may lack an extension).
 * @param buffer   - At least the first few bytes of file content.
 * @param detectedMime - Optional MIME type from an external detector.
 * @returns An object with the potentially-corrected file name and MIME type.
 */
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

/** Duck-typed object that may carry HTTP-like headers. */
type HeaderMapRequest = {
  headers?:
    | {
        get?: (name: string) => string | null;
      }
    | Record<string, string>;
};

/** Duck-typed Telegram file-like object. */
type FileLike = {
  /** File name, if available. */
  fileName?: string;
  /** MIME type, if available. */
  mimeType?: string;
};

/** Duck-typed Telegram message object that may contain file attachments. */
type MessageLike = {
  document?: FileLike;
  photo?: FileLike[];
  audio?: FileLike;
  voice?: FileLike;
  animation?: FileLike;
};

/**
 * Safely reads a header value from a request-like object, supporting both
 * the Fetch API `Headers#get` interface and plain records.
 *
 * @param request - An object with an optional `headers` property.
 * @param name    - The header name (case-insensitive for `get()`).
 * @returns The header value, or `undefined` if not present.
 */
const getHeader = (request: HeaderMapRequest | null, name: string): string | undefined => {
  const headers = request?.headers;
  if (!headers) return undefined;

  const get = 'get' in headers ? headers.get : undefined;
  if (typeof get === 'function') return get(name) || undefined;

  return (headers as Record<string, string>)[name];
};

/**
 * Extracts the file name from a Telegram message or an `x-file-name` request
 * header.
 *
 * The request header takes precedence when present.
 *
 * @param msg     - A duck-typed Telegram message object.
 * @param request - An optional request-like object for header inspection.
 * @returns The extracted file name, or `'file'` if none was found.
 */
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

/**
 * Extracts the MIME type from a Telegram message or an `x-mime-type` request
 * header.
 *
 * The request header takes precedence when present.
 *
 * @param msg     - A duck-typed Telegram message object.
 * @param request - An optional request-like object for header inspection.
 * @returns The extracted MIME type, or `'application/octet-stream'` as
 *          fallback.
 */
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

/**
 * Computes the SHA-256 hex digest of a buffer.
 *
 * @param buffer - The input data.
 * @returns The 64-character hex-encoded SHA-256 hash.
 */
export const computeHash = (buffer: Buffer): string => {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(buffer);
  return hasher.digest('hex');
};

/** Telegram API file object (subset of the full file object). */
export interface TelegramMessageFile {
  /** Unique file identifier. */
  file_id: string;
  /** Unique file identifier that is stable across different Telegram chats. */
  file_unique_id: string;
  /** File size in bytes, if available. */
  file_size?: number;
  /** MIME type, if available. */
  mime_type?: string;
  /** Original file name, if available. */
  file_name?: string;
}

/** Telegram API message object that may carry media attachments. */
export interface TelegramMediaMessage {
  /** Message identifier within the chat. */
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

/**
 * Extracts the relevant TelegramMessageFile from a media message based on the
 * detected file type.
 *
 * For photos the last (largest) entry in the photo array is returned.
 *
 * @param msg      - The Telegram media message.
 * @param fileType - The detected file type (photo, document, video, etc.).
 * @returns The matching file descriptor.
 */
export const extractFileFromMessage = (
  msg: TelegramMediaMessage,
  fileType: string,
): TelegramMessageFile => {
  if (fileType === 'photo') return msg.photo?.slice(-1)[0] as TelegramMessageFile;
  if (fileType === 'sticker') return msg.sticker as TelegramMessageFile;
  return msg[fileType as keyof TelegramMediaMessage] as TelegramMessageFile;
};

/**
 * Detects the file type from a Telegram media message by inspecting which
 * media fields are populated.
 *
 * The first populated field in the order document, photo, video, audio,
 * voice, animation, sticker, video_note determines the type.
 *
 * @param msg - The Telegram media message.
 * @returns The detected file type string.
 */
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

/**
 * Returns the maximum allowed file size in bytes for the given file type.
 *
 * @param fileType - One of the recognised Telegram file type keys.
 * @returns The size limit in bytes.
 */
export const getFileSizeLimit = (fileType: string): number =>
  FILE_TYPES[fileType] || FILE_TYPES.document;

/**
 * Formats a `createdAt` value into an ISO-8601 string.
 *
 * Accepts a Date instance, a date string, or a Unix timestamp (number).
 *
 * @param createdAt - The timestamp value to format.
 * @returns The ISO-8601 string representation.
 */
export const formatCreatedAt = (createdAt: Date | string | number): string => {
  return createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
};

/** Public shape of a file in the upload API response. */
export interface UploadResponse {
  /** Public unique identifier. */
  public_id: string;
  /** Original file name. */
  file_name: string;
  /** MIME type. */
  mime_type: string;
  /** File size in bytes. */
  size_bytes: number;
  /** Telegram file type. */
  file_type: string;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** Public download URL. */
  download_url: string;
}

/**
 * Builds an API response object from stored file metadata.
 *
 * @param file    - The file metadata record.
 * @param baseUrl - The server's base URL used to construct the download link.
 * @returns A plain response object suitable for JSON serialisation.
 */
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
