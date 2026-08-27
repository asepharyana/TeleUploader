import { afterEach, describe, expect, it } from 'bun:test';
import { createGetObjectResponse, type ObjectPartSource } from '../src/interfaces/s3/object-stream';
import type { RangeParseResult } from '../src/interfaces/s3/range';

const originalFetch = globalThis.fetch;

interface PartStub {
  url: string;
  size: number;
  content: string;
  gzip?: boolean;
  /** If set, fetch returns this error for this part. */
  status?: number;
}

/**
 * Installs a fetch stub that serves each part's bytes (optionally slicing by
 * Range header), or returns the configured HTTP error status.
 */
const installFetch = (parts: PartStub[]) => {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const url = String(_url);
    const part = parts.find((p) => p.url === url);
    if (!part) return new Response('not found', { status: 404 });
    if (part.status) return new Response('err', { status: part.status });

    const range = new Headers(init?.headers).get('range');
    let body = part.content;
    let status = 200;
    if (range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = Number(m[2]);
        body = part.content.slice(start, end + 1);
        status = 206;
      }
    }
    return new Response(body, {
      status,
      headers: { 'content-length': String(new TextEncoder().encode(body).length) },
    });
  }) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const part = (
  id: string,
  size: number,
  content: string,
  overrides: Partial<PartStub> = {},
): PartStub & {
  asSrc: ObjectPartSource;
} => ({
  url: `https://tg.test/${id}`,
  size,
  content,
  ...overrides,
  asSrc: {
    telegramFileId: id,
    telegramUrl: `https://tg.test/${id}`,
    sizeBytes: size,
    partNumber: 1,
  },
});

const src = (p: PartStub, partNumber: number): ObjectPartSource => ({
  telegramFileId: p.url,
  telegramUrl: p.url,
  sizeBytes: p.size,
  partNumber,
});

describe('S3 object stream response builder', () => {
  it('concatenates multiple parts in order', async () => {
    const p1 = part('part-1', 6, 'hello ');
    const p2 = part('part-2', 5, 'world');
    installFetch([p1, p2]);

    const res = await createGetObjectResponse({
      reqId: 'req-1',
      contentType: 'text/plain',
      etag: 'etag123',
      lastModified: new Date('2026-07-07T00:00:00Z'),
      totalSize: 11,
      parts: [src(p1, 1), src(p2, 2)],
      range: { type: 'none' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('11');
    expect(await res.text()).toBe('hello world');
  });

  it('returns 206 with content-range for a range within a single part', async () => {
    const p1 = part('part-1', 6, 'hello ');
    installFetch([p1]);
    const range: RangeParseResult = { type: 'valid', start: 1, end: 3 };

    const res = await createGetObjectResponse({
      reqId: 'req-2',
      contentType: 'text/plain',
      etag: 'etag123',
      lastModified: new Date('2026-07-07T00:00:00Z'),
      totalSize: 6,
      parts: [src(p1, 1)],
      range,
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 1-3/6');
    expect(res.headers.get('content-length')).toBe('3');
    expect(await res.text()).toBe('ell');
  });

  it('spans a byte range across two parts correctly', async () => {
    // part-1 = "hello " (6 bytes), part-2 = "world" (5 bytes), total "hello world"
    const p1 = part('p1', 6, 'hello ');
    const p2 = part('p2', 5, 'world');
    installFetch([p1, p2]);
    // range 5..9 = " worl" (byte5 space + bytes6-9 "worl")
    const range: RangeParseResult = { type: 'valid', start: 5, end: 9 };

    const res = await createGetObjectResponse({
      reqId: 'req-3',
      contentType: 'text/plain',
      etag: 'e',
      lastModified: new Date(),
      totalSize: 11,
      parts: [src(p1, 1), src(p2, 2)],
      range,
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 5-9/11');
    expect(await res.text()).toBe(' worl');
  });

  it('serves full object when range is none', async () => {
    const p1 = part('p1', 2, 'ab');
    const p2 = part('p2', 2, 'cd');
    installFetch([p1, p2]);

    const res = await createGetObjectResponse({
      reqId: 'req-4',
      contentType: 'application/octet-stream',
      etag: 'e',
      lastModified: new Date(),
      totalSize: 4,
      parts: [src(p1, 1), src(p2, 2)],
      range: { type: 'none' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abcd');
  });

  it('includes S3 headers and CORS in the response', async () => {
    const p1 = part('p1', 1, 'a');
    installFetch([p1]);
    const res = await createGetObjectResponse({
      reqId: 'req-x',
      contentType: 'text/plain',
      etag: 'mytag',
      lastModified: new Date('2026-01-01T00:00:00Z'),
      totalSize: 1,
      parts: [src(p1, 1)],
      range: { type: 'none' },
    });
    expect(res.headers.get('x-amz-request-id')).toBe('req-x');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('etag')).toBe('"mytag"');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000');
  });

  it('propagates a Telegram fetch failure into the response stream (errors on read)', async () => {
    const p1 = part('p1', 2, 'ab', { status: 502 });
    installFetch([p1]);
    const res = await createGetObjectResponse({
      reqId: 'req-err',
      contentType: 'text/plain',
      etag: 'e',
      lastModified: new Date(),
      totalSize: 2,
      parts: [src(p1, 1)],
      range: { type: 'none' },
    });
    // The stream errors when read, not on creation.
    await expect(res.text()).rejects.toThrow();
  });
});
