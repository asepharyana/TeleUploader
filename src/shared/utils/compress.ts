/** Compression algorithm for chunked file storage. */
export type CompressionAlgorithm = 'gzip' | null;

/**
 * Optionally compress a chunk with gzip.
 *
 * Compression is skipped if:
 * - The `compress` flag is false.
 * - The chunk is smaller than `compressionMinSizeBytes`.
 * - The compressed result is larger than the original.
 *
 * @param chunk - The raw chunk buffer.
 * @param compress - Whether compression is enabled.
 * @param compressionMinSizeBytes - Minimum chunk size to attempt compression.
 * @returns The (possibly compressed) bytes and the algorithm used.
 */
export const maybeCompressChunk = (
  chunk: Buffer,
  compress: boolean,
  compressionMinSizeBytes: number,
): { bytes: Buffer; compressionAlgorithm: CompressionAlgorithm } => {
  if (!compress || chunk.byteLength < compressionMinSizeBytes) {
    return { bytes: chunk, compressionAlgorithm: null };
  }

  const gzipped = Bun.gzipSync(chunk);
  if (gzipped.byteLength >= chunk.byteLength) {
    return { bytes: chunk, compressionAlgorithm: null };
  }

  return { bytes: gzipped, compressionAlgorithm: 'gzip' };
};
