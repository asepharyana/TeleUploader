import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = '123456:ABC-DEF';
process.env.STORAGE_CHANNEL_ID = '-1001234567890';
process.env.BASE_URL = 'http://localhost:4000';
process.env.DATABASE_URL = 'postgresql://asephs:***@100.121.180.82:6432/test';
process.env.PORT = '4000';
process.env.S3_ACCESS_KEY = 'filedrop-admin';
process.env.S3_SECRET_KEY = 'unit-test-secret';

const bucket = {
  id: 'bucket-uuid',
  name: 'gitea',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

mock.module('../src/infrastructure/persistence/repositories/bucket-repository', () => ({
  DrizzleBucketRepository: class {
    create = () => Promise.resolve(bucket);
    findByName = (name: string) => Promise.resolve(name === bucket.name ? bucket : null);
    list = () => Promise.resolve([bucket]);
    delete = () => Promise.resolve(true);
  },
}));

mock.module('../src/infrastructure/persistence/repositories/file-repository', () => ({
  DrizzleFileRepository: class {
    countByBucket = () => Promise.resolve(0);
    findByBucketAndKey = () => Promise.resolve(null);
    listByPrefix = () => Promise.resolve({ objects: [], prefixes: [] });
    softDelete = () => Promise.resolve(true);
  },
}));

mock.module('../src/infrastructure/persistence/repositories/multipart-repository', () => ({
  DrizzleMultipartRepository: class {
    abort = () => Promise.resolve();
    complete = () => Promise.resolve();
    create = () => Promise.resolve('upload-id');
    findById = () => Promise.resolve(null);
    insertPart = () => Promise.resolve();
    listParts = () => Promise.resolve([]);
    listByBucket = () => Promise.resolve({ uploads: [], isTruncated: false, nextKeyMarker: null });
  },
}));

mock.module('../src/infrastructure/telegram/chunked-storage', () => ({
  ChunkedStorage: class {
    createChunkedObjectResponse = () => Promise.resolve(new Response(''));
    storeFileInTelegramChunks = () => Promise.resolve({ fileHash: 'hash' });
  },
}));

mock.module('../src/interfaces/s3/auth', () => ({
  verifyPresignedUrl: () => Promise.resolve({ isValid: true }),
  verifySignature: () => Promise.resolve({ isValid: true }),
  verifyBodyHash: () => null,
  isS3Request: (headers: Record<string, string>) =>
    (headers.authorization || '').startsWith('AWS4-HMAC-SHA256'),
}));

mock.module('../src/infrastructure/telegram/bot-pool', () => ({
  botPool: {
    forwardToStorage: () =>
      Promise.resolve({
        telegramFileId: 'mock-tg-id',
        telegramFileUniqueId: 'mock-tg-unique',
        storageMessageId: 12345,
      }),
    getFileInfo: () =>
      Promise.resolve({
        bot_token: '123456:ABC-DEF',
        file_path: 'documents/file.txt',
        file_size: 100,
        mime_type: 'text/plain',
      }),
  },
}));

const AWS_AUTH =
  'AWS4-HMAC-SHA256 Credential=filedrop-admin/20260101/us-east-1/s3/aws4_request, ' +
  'SignedHeaders=host;x-amz-date, Signature=abc123';

describe('S3 routing (routes table)', () => {
  let routes: typeof import('../src/interfaces/http/routes/index').routes;

  beforeAll(async () => {
    ({ routes } = await import('../src/interfaces/http/routes/index'));
  });

  afterAll(() => {
    mock.restore();
  });

  it('routes GET / with AWS4 auth headers to S3 (not the home page)', async () => {
    const res = await routes['/'].GET(
      new Request('http://localhost:4000/', {
        headers: { authorization: AWS_AUTH },
      }),
    );
    const contentType = res.headers.get('content-type') || '';
    // S3 answers with XML; the home page would be text/html.
    expect(contentType).toContain('application/xml');
  });

  it('serves GET / without S3 headers as the home page (HTML 200)', async () => {
    const res = await routes['/'].GET(new Request('http://localhost:4000/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('FileDrop');
  });

  it('answers OPTIONS /* without S3 headers as a generic 204 CORS preflight (not S3 XML)', async () => {
    const res = await routes['/*'].OPTIONS(
      new Request('http://localhost:4000/some/path', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('routes OPTIONS /* with AWS4 auth headers to the S3 handler', async () => {
    const res = await routes['/*'].OPTIONS(
      new Request('http://localhost:4000/gitea/key', {
        method: 'OPTIONS',
        headers: { authorization: AWS_AUTH },
      }),
    );
    expect(res.status).toBe(204);
  });

  it('answers HEAD / without S3 headers as 404 (never S3-direct)', async () => {
    const res = await routes['/'].HEAD(new Request('http://localhost:4000/', { method: 'HEAD' }));
    expect(res.status).toBe(404);
  });

  it('answers DELETE / without S3 headers as 404 (never S3-direct)', async () => {
    const res = await routes['/'].DELETE(
      new Request('http://localhost:4000/', { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('answers POST / without S3 headers as 404 (never S3-direct)', async () => {
    const res = await routes['/'].POST(new Request('http://localhost:4000/', { method: 'POST' }));
    expect(res.status).toBe(404);
  });
});
