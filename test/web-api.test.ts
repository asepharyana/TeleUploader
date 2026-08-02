import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockBuckets = [
  {
    id: 'uuid-1',
    name: 'test-bucket',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  },
];

let mockObjects: Record<string, unknown>[] = [];
let mockPrefixes: string[] = [];

mock.module('../src/infrastructure/persistence/repositories/bucket-repository', () => ({
  DrizzleBucketRepository: class {
    list = () => Promise.resolve(mockBuckets);
    findByName = (name: string) =>
      Promise.resolve(mockBuckets.find((b) => b.name === name) || null);
    create = (name: string) =>
      Promise.resolve({ id: 'new-uuid', name, createdAt: new Date(), updatedAt: new Date() });
    delete = () => Promise.resolve(true);
  },
}));

mock.module('../src/infrastructure/persistence/repositories/file-repository', () => ({
  DrizzleFileRepository: class {
    findByBucketAndKey = () => Promise.resolve(null);
    listByPrefix = () => Promise.resolve({ objects: mockObjects, prefixes: mockPrefixes });
    softDelete = () => Promise.resolve(true);
    softDeleteBatch = () => Promise.resolve(0);
    countByBucket = () => Promise.resolve(0);
    findByBucket = () => Promise.resolve([]);
  },
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
        file_size: 100,
        mime_type: 'text/plain',
        file_path: 'documents/file.txt',
        bot_token: '123456:ABC-DEF',
      }),
  },
}));

describe('Web API v1', () => {
  let handleWebApiV1: typeof import('../src/interfaces/http/controllers/web-api-controller').handleWebApiV1;

  beforeAll(async () => {
    process.env.BOT_TOKEN = '123456:ABC-DEF';
    process.env.STORAGE_CHANNEL_ID = '-1001234567890';
    process.env.BASE_URL = 'http://localhost:4000';
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const webApi = await import('../src/interfaces/http/controllers/web-api-controller');
    handleWebApiV1 = webApi.handleWebApiV1;
  });

  beforeEach(() => {
    mockObjects = [];
    mockPrefixes = [];
  });

  afterAll(() => {
    mock.restore();
  });

  it('should list buckets via GET /api/v1/buckets', async () => {
    const req = new Request('http://localhost:4000/api/v1/buckets');
    const res = await handleWebApiV1(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { buckets: { name: string }[] };
    expect(data).toHaveProperty('buckets');
    expect(Array.isArray(data.buckets)).toBe(true);
    expect(data.buckets[0].name).toBe('test-bucket');
  });

  it('should return 404 for unknown API path', async () => {
    const req = new Request('http://localhost:4000/api/v1/unknown');
    const res = await handleWebApiV1(req);
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data).toHaveProperty('error');
  });

  it('should return 400 for invalid bucket name on create', async () => {
    const req = new Request('http://localhost:4000/api/v1/buckets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'INVALID_NAME!' }),
    });
    const res = await handleWebApiV1(req);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('Invalid bucket name');
  });

  it('should normalize listed object sizeBytes to a number', async () => {
    mockObjects = [
      {
        s3Key: 'tiny.txt',
        fileName: 'tiny.txt',
        mimeType: 'text/plain',
        sizeBytes: '12',
        fileType: 'document',
        fileHash: 'etag',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        publicId: 'public-id',
      },
    ];

    const req = new Request('http://localhost:4000/api/v1/buckets/test-bucket/objects');
    const res = await handleWebApiV1(req);

    expect(res.status).toBe(200);
    const data = (await res.json()) as { objects: { sizeBytes: unknown }[] };
    expect(data.objects[0].sizeBytes).toBe(12);
    expect(typeof data.objects[0].sizeBytes).toBe('number');
  });
});
