import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createGetObjectResponse, type ObjectPartSource } from '../src/interfaces/s3/object-stream';
import type { RangeParseResult } from '../src/interfaces/s3/range';

/**
 * Stubs `globalThis.fetch` so every Telegram part URL returns a body whose
 * bytes encode the part number. The first (and only the first) fetch is
 * delayed heavily, so it resolves LAST — proving the response still streams
 * parts back in correct order despite out-of-order completion.
 */
const installFetchMock = () => {
  const original = globalThis.fetch;

  const fakeFetch = mock((url: string | URL | Request) => {
    const u = url.toString();
    const match = u.match(/part(\d+)\.bin/);
    const part = match ? Number.parseInt(match[1], 10) : 0;
    const bytes = new Uint8Array(8).fill(0);
    // Encode part number in the last byte so we can assert ordering.
    bytes[7] = part;

    const delay = part === 1 ? 60 : 0;
    return new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(
          new Response(bytes, {
            status: 200,
            headers: { 'content-length': String(bytes.byteLength) },
          }),
        );
      }, delay);
    });
  }) as unknown as typeof fetch;

  globalThis.fetch = fakeFetch;
  return { original, fakeFetch };
};

const makePart = (partNumber: number, sizeBytes: number): ObjectPartSource => ({
  telegramFileId: `id-${partNumber}`,
  telegramUrl: `https://api.telegram.org/file/botTOKEN/part${partNumber}.bin`,
  sizeBytes,
  partNumber,
});

const fullRange = (): RangeParseResult => ({
  type: 'none',
});

const collect = async (res: Response): Promise<Uint8Array> => {
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
};

describe('object-stream parallel fan-in', () => {
  let restore: { original: typeof fetch; fakeFetch: unknown } | null = null;

  beforeEach(() => {
    restore = installFetchMock();
  });

  afterEach(() => {
    if (restore) {
      globalThis.fetch = restore.original;
      restore = null;
    }
  });

  it('streams multiple parts in order even when part 1 resolves last', async () => {
    const parts = [makePart(1, 8), makePart(2, 8), makePart(3, 8)];
    const res = await createGetObjectResponse({
      reqId: 'req-1',
      contentType: 'application/octet-stream',
      etag: 'etag',
      lastModified: new Date('2026-01-01T00:00:00Z'),
      totalSize: 24,
      parts,
      range: fullRange(),
    });

    expect(res.status).toBe(200);
    const body = await collect(res);
    expect(body.byteLength).toBe(24);

    // Each 8-byte part ends with its part number; order must be 1,2,3.
    expect(body[7]).toBe(1);
    expect(body[15]).toBe(2);
    expect(body[23]).toBe(3);
  });

  it('respects byte range across parts', async () => {
    const parts = [makePart(1, 8), makePart(2, 8), makePart(3, 8)];
    const range: RangeParseResult = { type: 'valid', start: 4, end: 19 };
    const res = await createGetObjectResponse({
      reqId: 'req-2',
      contentType: 'application/octet-stream',
      etag: 'etag',
      lastModified: new Date('2026-01-01T00:00:00Z'),
      totalSize: 24,
      parts,
      range,
    });

    expect(res.status).toBe(206);
    const body = await collect(res);
    // 16 bytes: tail of part1 (byte 4-7 => part1 marker), full part2, head of part3 (0-3)
    expect(body.byteLength).toBe(16);
    expect(body[3]).toBe(1); // last byte of part 1 (marker)
    expect(body[11]).toBe(2); // last byte of part 2 (marker)
    // Part 3 contributes only its first 4 bytes (0-3); its marker lives at
    // relative byte 7, which is outside the requested range — so no marker here.
    expect(body[15]).toBe(0);
  });

  it('handles a single part without error', async () => {
    const parts = [makePart(1, 8)];
    const res = await createGetObjectResponse({
      reqId: 'req-3',
      contentType: 'application/octet-stream',
      etag: 'etag',
      lastModified: new Date('2026-01-01T00:00:00Z'),
      totalSize: 8,
      parts,
      range: fullRange(),
    });
    const body = await collect(res);
    expect(body.byteLength).toBe(8);
    expect(body[7]).toBe(1);
  });
});
