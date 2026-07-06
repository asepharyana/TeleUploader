import { afterEach, describe, expect, it } from 'bun:test';
import { createGetObjectResponse } from '../src/utils/s3/object-stream';

const originalFetch = globalThis.fetch;

const streamText = (text: string) => new Response(text).body!;

const installFetch = () => {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range');
    const url = String(_url);
    const text = url.includes('part-1') ? 'hello ' : 'world';
    if (range === 'bytes=1-3') {
      return new Response(text.slice(1, 4), {
        status: 206,
        headers: { 'content-range': `bytes 1-3/${text.length}`, 'content-length': '3' },
      });
    }
    return new Response(streamText(text), {
      status: 200,
      headers: { 'content-length': String(text.length) },
    });
  }) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('S3 object stream response builder', () => {
  it('concatenates multiple Telegram part streams', async () => {
    installFetch();
    const res = await createGetObjectResponse({
      reqId: 'req-1',
      contentType: 'text/plain',
      etag: 'etag123',
      lastModified: new Date('2026-07-07T00:00:00Z'),
      totalSize: 11,
      parts: [
        {
          telegramFileId: 'part-1',
          telegramUrl: 'https://telegram.test/part-1',
          sizeBytes: 6,
          partNumber: 1,
        },
        {
          telegramFileId: 'part-2',
          telegramUrl: 'https://telegram.test/part-2',
          sizeBytes: 5,
          partNumber: 2,
        },
      ],
      range: { type: 'none' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('11');
    expect(await res.text()).toBe('hello world');
  });

  it('returns 206 with content-range for a single-part byte range', async () => {
    installFetch();
    const res = await createGetObjectResponse({
      reqId: 'req-2',
      contentType: 'text/plain',
      etag: 'etag123',
      lastModified: new Date('2026-07-07T00:00:00Z'),
      totalSize: 6,
      parts: [
        {
          telegramFileId: 'part-1',
          telegramUrl: 'https://telegram.test/part-1',
          sizeBytes: 6,
          partNumber: 1,
        },
      ],
      range: { type: 'valid', start: 1, end: 3 },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 1-3/6');
    expect(res.headers.get('content-length')).toBe('3');
    expect(await res.text()).toBe('ell');
  });
});
