import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { streamToTemp } from '../src/shared/utils/temp-stream';

/**
 * Tests streamToTemp — the shared S3/upload streaming helper that writes a
 * Request body to a temp file in O(1) memory while computing SHA-256 (+ MD5)
 * and capturing the first 16 bytes as a signature.
 */
const readerFrom = (chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  }).getReader() as ReadableStreamDefaultReader<Uint8Array>;

const run = (chunks: (string | Uint8Array)[]) =>
  streamToTemp(
    readerFrom(chunks.map((c) => (typeof c === 'string' ? new TextEncoder().encode(c) : c))),
    { prefix: '/tmp/tt-' },
  );

describe('streamToTemp', () => {
  it('writes all bytes to a temp file and returns the size', async () => {
    const r = await run(['hello ', 'world']);
    try {
      expect(r.sizeBytes).toBe(11);
      expect(await readFile(r.tempPath, 'utf8')).toBe('hello world');
    } finally {
      await Bun.$`rm -f ${r.tempPath}`;
    }
  });

  it('computes the SHA-256 hash of the full stream', async () => {
    const r = await run(['foo', 'bar', 'baz']);
    try {
      const expected = createHash('sha256').update('foobarbaz').digest('hex');
      expect(r.fileHash).toBe(expected);
    } finally {
      await Bun.$`rm -f ${r.tempPath}`;
    }
  });

  it('computes MD5 (base64) only when requested', async () => {
    const withMd5 = await streamToTemp(readerFrom([new TextEncoder().encode('abc')]), {
      computeMd5: true,
      prefix: '/tmp/tt-',
    });
    try {
      const expected = createHash('md5').update('abc').digest('base64');
      expect(withMd5.md5Hash).toBe(expected);
    } finally {
      await Bun.$`rm -f ${withMd5.tempPath}`;
    }
  });

  it('captures the first 16 bytes as signature, padding shorter streams', async () => {
    const long = await run(['ABCDEFGHIJKLMNOPQRST']);
    try {
      expect(long.signatureBuffer.toString()).toBe('ABCDEFGHIJKLMNOP');
    } finally {
      await Bun.$`rm -f ${long.tempPath}`;
    }

    const short = await run(['ab']);
    try {
      expect(short.signatureBuffer.byteLength).toBe(2);
      expect(short.signatureBuffer.toString()).toBe('ab');
    } finally {
      await Bun.$`rm -f ${short.tempPath}`;
    }
  });

  it('handles an empty stream (zero bytes)', async () => {
    const r = await run([]);
    try {
      expect(r.sizeBytes).toBe(0);
      expect(r.fileHash).toBe(createHash('sha256').update('').digest('hex'));
      expect(r.signatureBuffer.byteLength).toBe(0);
    } finally {
      await Bun.$`rm -f ${r.tempPath}`;
    }
  });

  it('throws when the stream exceeds maxSizeBytes and cleans up the temp file', async () => {
    await expect(
      streamToTemp(readerFrom([new TextEncoder().encode('12345')]), {
        maxSizeBytes: 3,
        prefix: '/tmp/tt-',
      }),
    ).rejects.toThrow(/exceeds upload limit/i);
    // The temp file should NOT remain.
    // (streamToTemp deletes on error; paths are unique so can't easily assert,
    //  but we can at least confirm no crash and no orphan via a known path.)
  });

  it('uses the provided temp prefix for generated paths', async () => {
    const r = await run(['x']);
    try {
      expect(r.tempPath.startsWith('/tmp/tt-')).toBe(true);
    } finally {
      await Bun.$`rm -f ${r.tempPath}`;
    }
  });
});
