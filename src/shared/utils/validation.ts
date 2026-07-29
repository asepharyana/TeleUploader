/**
 * Validates a chunk size value and returns it as a safe integer.
 *
 * @param chunkSizeBytes - The desired chunk size in bytes.
 * @returns The same value if it is a positive safe integer.
 * @throws {Error} If the chunk size is not a safe positive integer.
 */
export const asSafeChunkSize = (chunkSizeBytes: number): number => {
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new Error('Invalid Telegram chunk size');
  }
  return chunkSizeBytes;
};
