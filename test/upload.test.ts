import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

let realPhotoBuffer: Buffer;

beforeAll(async () => {
  try {
    const res = await fetch(
      'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
    );
    if (!res.ok) throw new Error('Wikimedia download failed');
    const arrayBuffer = await res.arrayBuffer();
    realPhotoBuffer = Buffer.from(arrayBuffer);
  } catch {
    // Fallback 1x1px JPEG
    realPhotoBuffer = Buffer.from(
      'ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0b000080100010101011100ffc4001f0000010501010110000000000000000000000102030405060708ffda000c03010002110311003f00a0ffd9',
      'hex',
    );
  }
});

// Mock db
type UploadResponseBody = {
  public_id: string;
  file_name: string;
  file_type: string;
  download_url: string;
};

type ErrorResponseBody = {
  error: string;
};

type UploadJsonBody = UploadResponseBody & Partial<ErrorResponseBody>;

let mockFindByHashResult: unknown = null;

const uploadResponseJson = async (res: Response): Promise<UploadJsonBody> => {
  return (await res.json()) as UploadJsonBody;
};

const mockFileRepo = {
  findByHash: mock(() => Promise.resolve(mockFindByHashResult)),
  create: mock((input: unknown) =>
    Promise.resolve({
      ...(input as object),
      publicId: (input as Record<string, unknown>).publicId || 'mocked-id',
      createdAt: new Date(),
    }),
  ),
};

const mockForwardToStorage = mock(() =>
  Promise.resolve({
    telegramFileId: 'tg-file-id-123',
    telegramFileUniqueId: 'tg-unique-id-abc',
    storageMessageId: 98765,
  }),
);

mock.module('../src/infrastructure/di', () => ({
  fileRepository: mockFileRepo,
  chunkedStorage: {
    storeFileInTelegramChunks: mock(() =>
      Promise.resolve({
        fileHash: 'hash',
        publicId: 'mock',
        fileName: 'test',
        mimeType: 'text/plain',
        sizeBytes: 100,
        fileType: 'document',
        createdAt: new Date(),
      }),
    ),
  },
  telegramService: {
    forwardToStorage: mockForwardToStorage,
    getFileInfo: async (telegramFileId: string) => ({
      file_size: 0,
      mime_type: 'application/octet-stream',
      file_path: `documents/${telegramFileId}`,
      bot_token: '123456:ABC-DEF',
    }),
  },
}));

// Mock nanoid
let nanoidCounter = 0;
mock.module('nanoid', () => ({
  nanoid: () => `mocked-nanoid-id-${nanoidCounter++}`,
}));

// Mock streamToTemp — bypass actual file I/O in tests
const mockStreamToTemp = mock((_reader: unknown) =>
  Promise.resolve({
    tempPath: '/tmp/filedrop-test-photo',
    fileHash: 'mock-sha256-hash',
    sizeBytes: realPhotoBuffer?.byteLength || 100,
    signatureBuffer: (realPhotoBuffer || Buffer.alloc(16)).subarray(0, 16),
  }),
);
mock.module('../src/shared/utils/temp-stream', () => ({
  streamToTemp: mockStreamToTemp,
}));

describe('Upload Route Handler', () => {
  let handleUpload: typeof import('../src/interfaces/http/controllers/upload-controller').handleUpload;

  beforeEach(async () => {
    mockFileRepo.findByHash.mockClear();
    mockFileRepo.create.mockClear();
    mockForwardToStorage.mockClear();
    mockFindByHashResult = null;
    nanoidCounter = 0;
    const uploadRoute = await import('../src/interfaces/http/controllers/upload-controller');
    handleUpload = uploadRoute.handleUpload;
  });

  it('should reject unsupported content types with 400 status', async () => {
    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
      },
      body: 'plain text data',
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(400);
    const body = await uploadResponseJson(res);
    expect(body.error).toContain('Unsupported content type');
  });

  it('should process JSON upload (base64) successfully', async () => {
    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        file: realPhotoBuffer.toString('base64'),
        fileName: 'test.png',
      }),
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(200);
    const body = await uploadResponseJson(res);

    expect(body.public_id).toContain('mocked-nanoid-id');
    expect(body.file_name).toBe('test.png');
    expect(body.file_type).toBe('document');
    expect(body.download_url).toContain('/f/');
    // No internal Telegram IDs in public response
    expect(body).not.toHaveProperty('telegram_file_id');
    expect(body).not.toHaveProperty('telegram_file_unique_id');
    expect(body).not.toHaveProperty('storage_chat_id');
    expect(body).not.toHaveProperty('storage_message_id');
    expect(body).not.toHaveProperty('uploader_id');
  });

  it('should reject JSON upload without file key', async () => {
    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test.txt',
      }),
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(400);
    const body = await uploadResponseJson(res);
    expect(body.error).toContain('Invalid JSON');
  });

  it('should process multipart upload successfully', async () => {
    const formData = new FormData();
    const fileBlob = new Blob([realPhotoBuffer], { type: 'image/png' });
    formData.append('file', fileBlob, 'test_multi.png');

    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      body: formData,
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(200);
    const body = await uploadResponseJson(res);
    expect(body.public_id).toContain('mocked-nanoid-id');
    expect(body.file_name).toBe('test_multi.png');
    expect(body).not.toHaveProperty('telegram_file_id');
  });

  it('should deduplicate multipart upload if hash exists', async () => {
    mockFindByHashResult = {
      publicId: 'existing-id-123',
      telegramFileId: 'existing-tg-id',
      telegramFileUniqueId: 'existing-tg-unique',
      storageChatId: 12345,
      storageMessageId: 67890,
      fileName: 'existing_name.txt',
      mimeType: 'text/plain',
      sizeBytes: 100,
      fileType: 'document',
      uploaderId: 0,
      createdAt: new Date('2026-05-18T00:00:00.000Z'),
      updatedAt: new Date('2026-05-18T00:00:00.000Z'),
    };

    const formData = new FormData();
    const fileBlob = new Blob([Buffer.from('multipart hello')], { type: 'text/plain' });
    formData.append('file', fileBlob, 'test_multi.txt');

    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      body: formData,
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(200);
    const body = await uploadResponseJson(res);

    expect(body.public_id).toBe('existing-id-123');
    expect(body.file_name).toBe('existing_name.txt');
    expect(body.download_url).toContain('/f/existing-id-123');
    expect(body).not.toHaveProperty('telegram_file_id');

    // findByHash was called
    expect(mockFileRepo.findByHash).toHaveBeenCalled();
    // No telegram upload happened
    expect(mockForwardToStorage).not.toHaveBeenCalled();
    // No db insertion happened
    expect(mockFileRepo.create).not.toHaveBeenCalled();
  });

  it('should deduplicate JSON upload if hash exists', async () => {
    mockFindByHashResult = {
      publicId: 'existing-json-id',
      telegramFileId: 'existing-tg-json-id',
      telegramFileUniqueId: 'existing-tg-json-unique',
      storageChatId: 12345,
      storageMessageId: 67890,
      fileName: 'existing_json.txt',
      mimeType: 'text/plain',
      sizeBytes: 200,
      fileType: 'document',
      uploaderId: 0,
      createdAt: new Date('2026-05-18T00:00:00.000Z'),
      updatedAt: new Date('2026-05-18T00:00:00.000Z'),
    };

    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        file: Buffer.from('hello world').toString('base64'),
        fileName: 'test.txt',
      }),
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(200);
    const body = await uploadResponseJson(res);

    expect(body.public_id).toBe('existing-json-id');
    expect(body.file_name).toBe('existing_json.txt');
    expect(body.download_url).toContain('/f/existing-json-id');
    expect(body).not.toHaveProperty('telegram_file_id');

    // findByHash was called
    expect(mockFileRepo.findByHash).toHaveBeenCalled();
    // No telegram upload happened
    expect(mockForwardToStorage).not.toHaveBeenCalled();
    // No db insertion happened
    expect(mockFileRepo.create).not.toHaveBeenCalled();
  });

  it('should reject oversized request by Content-Length header', async () => {
    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(3 * 1024 * 1024 * 1024),
      },
      body: JSON.stringify({
        file: Buffer.from('hello').toString('base64'),
        fileName: 'test.txt',
      }),
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(413);
    const body = await uploadResponseJson(res);
    expect(body.error).toContain('too large');
  });

  afterAll(() => {
    mock.restore();
  });
});
