/**
 * Shared utility for streaming data into a temporary file on disk while
 * computing its SHA-256 hash (and optionally MD5) and extracting the
 * signature (first 16 bytes) for magic-byte detection.
 *
 * Consolidates the duplicated streaming-to-temp pattern found across
 * multiple HTTP controllers (s3-controller, upload-controller,
 * web-api-controller) into a single, reusable function.
 */

import { unlink } from 'node:fs/promises';
import { nanoid } from 'nanoid';

/** Options for the {@link streamToTemp} function. */
export interface StreamToTempOptions {
  /** Temporary file path prefix (default: `'/tmp/filedrop-'`). */
  prefix?: string;
  /** When true, also compute the MD5 hash (default: false). */
  computeMd5?: boolean;
  /** Maximum allowed bytes; throws if the stream exceeds this size. */
  maxSizeBytes?: number;
}

/** Result of a successful {@link streamToTemp} call. */
export interface StreamToTempResult {
  /** Absolute path to the written temp file. */
  tempPath: string;
  /** SHA-256 hex digest of the entire stream. */
  fileHash: string;
  /** MD5 base-64 digest — only present when `computeMd5` was true. */
  md5Hash?: string;
  /** Total number of bytes written. */
  sizeBytes: number;
  /** First 16 bytes of the stream (padded with zeros if shorter). */
  signatureBuffer: Buffer;
}

/**
 * Streams data from a `ReadableStreamDefaultReader` into a temporary file
 * while computing hashes and extracting the first 16 bytes as a signature
 * buffer.
 *
 * The temp file is cleaned up automatically on error.
 *
 * @param reader - A reader obtained from a `ReadableStream`.
 * @param options - Optional behaviour flags.
 * @returns A promise resolving with the temp-file metadata.
 * @throws {Error} If `maxSizeBytes` is exceeded.
 */
export const streamToTemp = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: StreamToTempOptions,
): Promise<StreamToTempResult> => {
  const prefix = options?.prefix ?? '/tmp/filedrop-';
  const computeMd5 = options?.computeMd5 ?? false;
  const maxSizeBytes = options?.maxSizeBytes;

  const tempPath = `${prefix}${nanoid()}`;
  const writer = Bun.file(tempPath).writer();
  const sha256 = new Bun.CryptoHasher('sha256');
  const md5 = computeMd5 ? new Bun.CryptoHasher('md5') : null;

  const SIGNATURE_BYTES = 16;
  const signatureChunks: Buffer[] = [];
  let signatureBytes = 0;
  let sizeBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = Buffer.from(value);
      sizeBytes += chunk.byteLength;

      if (maxSizeBytes !== undefined && sizeBytes > maxSizeBytes) {
        reader.cancel();
        throw new Error('File size exceeds upload limit');
      }

      sha256.update(chunk);
      md5?.update(chunk);
      writer.write(chunk);

      if (signatureBytes < SIGNATURE_BYTES) {
        const remaining = SIGNATURE_BYTES - signatureBytes;
        const sigChunk = chunk.subarray(0, remaining);
        signatureChunks.push(sigChunk);
        signatureBytes += sigChunk.byteLength;
      }
    }

    try {
      writer.end();
    } catch {
      // Writer may have already errored — ignore on success path
    }

    const result: StreamToTempResult = {
      tempPath,
      fileHash: sha256.digest('hex'),
      sizeBytes,
      signatureBuffer: Buffer.concat(signatureChunks, signatureBytes),
    };

    if (md5) {
      result.md5Hash = md5.digest('base64');
    }

    return result;
  } catch (error) {
    try {
      writer.end();
    } catch {
      // ignore writer end failure during error path
    }

    try {
      await unlink(tempPath);
    } catch {
      // ignore unlink failure
    }

    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore release lock failure
    }
  }
};
