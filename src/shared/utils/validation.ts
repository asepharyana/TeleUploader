/**
 * Maximum allowed chunk/part size in bytes for Telegram storage.
 *
 * Telegram Bot API `getFile` can only resolve files up to 20 MB; anything
 * larger fails with "Bad Request: file is too big". Chunked uploads store
 * each part as a Telegram document and later resolve it via `getFile`, so a
 * part must never reach that limit. 19 MB (19922944 bytes) leaves a safety
 * margin and is the value used in production (/etc/teleuploader/env).
 */
export const TELEGRAM_CHUNK_SIZE_MAX_BYTES = 19 * 1024 * 1024;

/**
 * Validates a chunk size value and returns it as a safe integer.
 *
 * @param chunkSizeBytes - The desired chunk size in bytes.
 * @returns The same value if it is a positive safe integer at or below
 *   {@link TELEGRAM_CHUNK_SIZE_MAX_BYTES}.
 * @throws {Error} If the chunk size is not a safe positive integer or exceeds
 *   the Telegram `getFile` limit (with margin).
 */
export const asSafeChunkSize = (chunkSizeBytes: number): number => {
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new Error('Invalid Telegram chunk size');
  }
  if (chunkSizeBytes > TELEGRAM_CHUNK_SIZE_MAX_BYTES) {
    throw new Error(
      `Telegram chunk size ${chunkSizeBytes} exceeds the maximum allowed part size ` +
        `${TELEGRAM_CHUNK_SIZE_MAX_BYTES} bytes (${TELEGRAM_CHUNK_SIZE_MAX_BYTES / (1024 * 1024)} MB). ` +
        'Telegram getFile cannot download files larger than 20 MB, so such parts would be undownloadable.',
    );
  }
  return chunkSizeBytes;
};
