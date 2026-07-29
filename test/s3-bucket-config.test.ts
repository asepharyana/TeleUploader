import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = '123456:ABC-DEF';
process.env.STORAGE_CHANNEL_ID = '-1001234567890';
process.env.BASE_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://localhost/test';
process.env.PORT = '3000';
process.env.S3_ACCESS_KEY = 'filedrop-admin';
process.env.S3_SECRET_KEY = 'unit-test-secret';

const bucket = {
  id: 'bucket-uuid',
  name: 'gitea',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

mock.module('../src/db/buckets', () => ({
  createBucket: () => Promise.resolve(bucket),
  deleteBucket: () => Promise.resolve(true),
  findBucketByName: (name: string) => Promise.resolve(name === bucket.name ? bucket : null),
  listBuckets: () => Promise.resolve([bucket]),
}));

mock.module('../src/db/files-ext', () => ({
  countBucketObjects: () => Promise.resolve(0),
  findFileByBucketAndKey: () => Promise.resolve(null),
  listObjectsByPrefix: () => Promise.resolve({ objects: [], prefixes: [] }),
  softDeleteFile: () => Promise.resolve(true),
}));

mock.module('../src/db/multipart', () => ({
  abortMultipartUpload: () => Promise.resolve(),
  completeMultipartUpload: () => Promise.resolve(),
  createMultipartUpload: () => Promise.resolve('upload-id'),
  findMultipartUpload: () => Promise.resolve(null),
  insertMultipartPart: () => Promise.resolve(),
  listMultipartParts: () => Promise.resolve([]),
  listMultipartUploadsByBucket: () =>
    Promise.resolve({ uploads: [], isTruncated: false, nextKeyMarker: null }),
}));

mock.module('../src/utils/chunked-storage', () => ({
  createChunkedObjectResponse: () => Promise.resolve(new Response('')),
  storeFileInTelegramChunks: () => Promise.resolve({ fileHash: 'hash' }),
}));

mock.module('../src/utils/s3/auth', () => ({
  verifyPresignedUrl: () => Promise.resolve({ isValid: true }),
  verifySignature: () => Promise.resolve({ isValid: true }),
}));

mock.module('../src/utils/telegram', () => ({
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
}));

describe('S3 bucket configuration compatibility', () => {
  let handleS3Request: typeof import('../src/interfaces/http/controllers/s3-controller').handleS3Request;

  beforeAll(async () => {
    ({ handleS3Request } = await import('../src/interfaces/http/controllers/s3-controller'));
  });

  afterAll(() => {
    mock.restore();
  });

  it('returns VersioningConfiguration for path-style GetBucketVersioning', async () => {
    const res = await handleS3Request(new Request('http://localhost:3000/gitea?versioning'));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(body).toContain('<VersioningConfiguration');
    expect(body).not.toContain('<ListBucketResult');
  });

  it('returns VersioningConfiguration for virtual-hosted GetBucketVersioning', async () => {
    const res = await handleS3Request(
      new Request('http://gitea.localhost:3000/?versioning'),
      'gitea',
    );
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('<VersioningConfiguration');
    expect(body).not.toContain('<ListBucketResult');
  });
});
