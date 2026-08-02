import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

type RequestWithParams = Request & {
  params?: {
    public_id?: string;
  };
};

type ErrorBody = {
  error: string;
};

type FileInfoBody = {
  public_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  file_type: string;
  created_at: string;
};

type JsonBody = ErrorBody | FileInfoBody | Record<string, unknown>;

type MockFileRecord = {
  publicId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  fileType: string;
  uploaderId?: number;
  createdAt?: Date;
  telegramFileId?: string;
  storageBackend?: string | null;
  archiveEntryName?: string | null;
  fileHash?: string | null;
  archiveTelegramFileId?: string | null;
};

const requestWithPublicId = (url: string, publicId: string): RequestWithParams => {
  const req = new Request(url) as RequestWithParams;
  req.params = { public_id: publicId };
  return req;
};

const responseJson = async <T extends JsonBody>(res: Response): Promise<T> => {
  return (await res.json()) as T;
};

// Mock the DI module — file-controller imports fileRepository + chunkedStorage from here
const mockFindByPublicId = mock(
  (_publicId: string): Promise<MockFileRecord | null> => Promise.resolve(null),
);

const mockGetFileInfo = mock(async (_telegramFileId: string) => ({
  file_size: 98765,
  mime_type: 'image/jpeg',
  file_path: 'photos/file_0.jpg',
  bot_token: '123456:ABC-DEF',
}));

const mockCreateChunkedObjectResponse = mock(async () => new Response(null, { status: 200 }));

mock.module('../src/infrastructure/di', () => ({
  fileRepository: {
    findByPublicId: mockFindByPublicId,
    findByHash: async () => null,
    findByUniqueId: async () => null,
    findByBucketAndKey: async () => null,
    create: async (data: Record<string, unknown>) => ({
      ...data,
      id: 'mock-id',
      createdAt: new Date(),
    }),
    softDelete: async () => true,
    softDeleteBatch: async () => 1,
    countByBucket: async () => 0,
    listByPrefix: async () => ({ objects: [], prefixes: [] }),
    findOrphansByBucket: async () => [],
  },
  chunkedStorage: {
    createChunkedObjectResponse: mockCreateChunkedObjectResponse,
    buildChunkedObjectSources: async () => [],
    uploadFileInTelegramChunks: async () => ({ parts: [], fileHash: '', totalSizeBytes: 0 }),
    storeFileInTelegramChunks: async () => ({
      id: 'mock-id',
      publicId: 'mock-public',
      telegramFileId: 'mock-tg',
      telegramFileUniqueId: 'mock-tg-unique',
      storageChatId: 0,
      storageMessageId: 0,
      fileName: 'mock',
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
      fileType: 'document',
      uploaderId: 0,
      fileHash: null,
      archiveTelegramFileId: null,
      archiveStorageMessageId: null,
      archiveFileName: null,
      archiveEntryName: null,
      archiveMimeType: null,
      archiveSizeBytes: null,
      bucketId: null,
      s3Key: null,
      storageBackend: 'telegram',
      isDeleted: false,
      multipartUploadId: null,
      partCount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  },
}));

// Mock botPool.getFileInfo used in file redirect
mock.module('../src/infrastructure/telegram/bot-pool', () => ({
  botPool: {
    getFileInfo: mockGetFileInfo,
    forwardToStorage: async () => ({
      telegramFileId: 'mock-tg-id',
      telegramFileUniqueId: 'mock-tg-unique',
      storageMessageId: 12345,
    }),
    size: 1,
    getEffectiveConcurrency: () => 1,
  },
}));

describe('File Route Handlers', () => {
  let handleFileRedirect: typeof import('../src/interfaces/http/controllers/file-controller').handleFileRedirect;
  let handleFileInfo: typeof import('../src/interfaces/http/controllers/file-controller').handleFileInfo;

  beforeEach(async () => {
    mockFindByPublicId.mockClear();
    mockGetFileInfo.mockClear();
    mockCreateChunkedObjectResponse.mockClear();

    // Set up mock token
    process.env.BOT_TOKEN = '123456:ABC-DEF';

    const filesRoute = await import('../src/interfaces/http/controllers/file-controller');
    handleFileRedirect = filesRoute.handleFileRedirect;
    handleFileInfo = filesRoute.handleFileInfo;
  });

  afterAll(() => {
    mock.restore();
  });

  describe('handleFileRedirect', () => {
    it('should return 404 if file is not found in database', async () => {
      mockFindByPublicId.mockImplementationOnce(async () => null);

      const req = requestWithPublicId('http://localhost:4000/f/missing-id', 'missing-id');
      const res = await handleFileRedirect(req);
      expect(res.status).toBe(404);
      const body = await responseJson<ErrorBody>(res);
      expect(body.error).toBe('File not found');
    });

    it('should redirect to telegram file url with 302', async () => {
      mockFindByPublicId.mockImplementationOnce(async () => ({
        publicId: 'test-id',
        telegramFileId: 'tg-file-id',
        telegramFileUniqueId: 'tg-unique',
        storageChatId: -100123,
        storageMessageId: 42,
        fileName: 'test.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
        fileType: 'photo',
        uploaderId: 0,
        fileHash: 'abc123',
        archiveTelegramFileId: null,
        archiveStorageMessageId: null,
        archiveFileName: null,
        archiveEntryName: null,
        archiveMimeType: null,
        archiveSizeBytes: null,
        bucketId: null,
        s3Key: null,
        storageBackend: 'telegram',
        isDeleted: false,
        multipartUploadId: null,
        partCount: null,
        createdAt: new Date('2026-05-18T00:00:00.000Z'),
        updatedAt: new Date('2026-05-18T00:00:00.000Z'),
      }));

      const req = requestWithPublicId('http://localhost:4000/f/test-id', 'test-id');
      const res = await handleFileRedirect(req);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(
        'https://api.telegram.org/file/bot123456:ABC-DEF/photos/file_0.jpg',
      );
    });

    it('should return 500 on database or external errors', async () => {
      mockFindByPublicId.mockImplementationOnce(async () => {
        throw new Error('DB Connection Error');
      });

      const req = requestWithPublicId('http://localhost:4000/f/test-id', 'test-id');
      const res = await handleFileRedirect(req);
      expect(res.status).toBe(500);
      const body = await responseJson<ErrorBody>(res);
      expect(body.error).toBe('Server error');
    });
  });

  describe('handleFileInfo', () => {
    it('should return 404 if file is not found in database', async () => {
      mockFindByPublicId.mockImplementationOnce(async () => null);

      const req = requestWithPublicId('http://localhost:4000/file/missing-id/info', 'missing-id');
      const res = await handleFileInfo(req);
      expect(res.status).toBe(404);
      const body = await responseJson<ErrorBody>(res);
      expect(body.error).toBe('File not found');
    });

    it('should return file info JSON without internal fields', async () => {
      const dbFile = {
        publicId: 'test-id',
        telegramFileId: 'tg-file-id',
        telegramFileUniqueId: 'tg-unique',
        storageChatId: -100123,
        storageMessageId: 42,
        fileName: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        fileType: 'photo',
        uploaderId: 99999,
        fileHash: null,
        archiveTelegramFileId: null,
        archiveStorageMessageId: null,
        archiveFileName: null,
        archiveEntryName: null,
        archiveMimeType: null,
        archiveSizeBytes: null,
        bucketId: null,
        s3Key: null,
        storageBackend: 'telegram',
        isDeleted: false,
        multipartUploadId: null,
        partCount: null,
        createdAt: new Date('2026-05-18T00:00:00.000Z'),
        updatedAt: new Date('2026-05-18T00:00:00.000Z'),
      };

      mockFindByPublicId.mockImplementationOnce(async () => dbFile);

      const req = requestWithPublicId('http://localhost:4000/file/test-id/info', 'test-id');
      const res = await handleFileInfo(req);
      expect(res.status).toBe(200);
      const body = await responseJson<FileInfoBody>(res);
      expect(body).toEqual({
        public_id: 'test-id',
        file_name: 'image.png',
        mime_type: 'image/png',
        size_bytes: 2048,
        file_type: 'photo',
        created_at: '2026-05-18T00:00:00.000Z',
      });
      // No internal fields
      expect(body).not.toHaveProperty('uploader_id');
      expect(body).not.toHaveProperty('telegram_file_id');
    });

    it('should return 500 on database or external errors', async () => {
      mockFindByPublicId.mockImplementationOnce(async () => {
        throw new Error('DB Connection Error');
      });

      const req = requestWithPublicId('http://localhost:4000/file/test-id/info', 'test-id');
      const res = await handleFileInfo(req);
      expect(res.status).toBe(500);
      const body = await responseJson<ErrorBody>(res);
      expect(body.error).toBe('Server error');
    });
  });
});
