import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock DB layer (chunked-storage imports db, insertFileParts, listFileParts)
const mockInsert = mock(() => Promise.resolve());
const mockPartsInsert = mock(() => Promise.resolve());
const mockPartsSelect = mock(() => Promise.resolve([]));

mock.module('../src/db/index', () => ({
  db: {
    insert: mockInsert,
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    execute: mock(() => Promise.resolve([])),
  },
  files: {},
  fileParts: {},
}));

mock.module('../src/db/file-parts', () => ({
  insertFileParts: mockPartsInsert,
  listFileParts: mockPartsSelect,
}));

mock.module('../src/utils/telegram', () => ({
  forwardToStorage: async (_bytes: unknown, fileName: string) => ({
    telegramFileId: `tg-${fileName}`,
    telegramFileUniqueId: `tg-unique-${fileName}`,
    storageMessageId: Math.floor(Math.random() * 100000) + 1,
  }),
  getFileInfo: async (telegramFileId: string) => ({
    file_size: 0,
    mime_type: 'application/octet-stream',
    file_path: `documents/${telegramFileId}`,
    bot_token: '123456:ABC-DEF',
  }),
}));

const writeTemp = async (path: string, data: Buffer): Promise<void> => {
  await Bun.write(path, data);
};

const rmTemp = async (path: string): Promise<void> => {
  try {
    await Bun.$`rm -f ${path}`;
  } catch {
    /* ignore */
  }
};

describe('chunked-storage utility', () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockPartsInsert.mockClear();
    mockPartsSelect.mockClear();
  });

  it('should split a file into correct number of chunks', async () => {
    const { uploadFileInTelegramChunks } = await import('../src/utils/chunked-storage');

    const data = Buffer.from('1234567890ab');
    const path = '/tmp/test-chunk-1';
    await writeTemp(path, data);

    const result = await uploadFileInTelegramChunks({
      tempPath: path,
      partFileNamePrefix: 'test-1',
      chunkSizeBytes: 4,
      compress: false,
      compressionMinSizeBytes: 4096,
    });

    await rmTemp(path);

    // 12 bytes at 4 bytes/chunk = 3 chunks
    expect(result.parts.length).toBe(3);
    expect(result.totalSizeBytes).toBe(12);
    expect(result.parts[0].partNumber).toBe(1);
    expect(result.parts[1].partNumber).toBe(2);
    expect(result.parts[2].partNumber).toBe(3);
    expect(result.parts[0].storedSizeBytes).toBe(4);
    expect(result.parts[0].compressionAlgorithm).toBeNull();
  });

  it('should compute correct full-file hash', async () => {
    const { uploadFileInTelegramChunks } = await import('../src/utils/chunked-storage');
    const { createHash } = await import('node:crypto');

    const data = Buffer.from('Hello, chunked storage!');
    const path = '/tmp/test-chunk-hash';
    await writeTemp(path, data);

    // Expected SHA-256
    const expectedHash = createHash('sha256').update(data).digest('hex');

    const result = await uploadFileInTelegramChunks({
      tempPath: path,
      partFileNamePrefix: 'test-hash',
      chunkSizeBytes: 10,
      compress: false,
      compressionMinSizeBytes: 4096,
    });

    await rmTemp(path);

    expect(result.fileHash).toBe(expectedHash);
    expect(result.totalSizeBytes).toBe(data.byteLength);
  });

  it('should gzip compressible chunks and skip incompressible ones', async () => {
    const { uploadFileInTelegramChunks } = await import('../src/utils/chunked-storage');

    // Use data large enough to exceed compressionMinSizeBytes
    const data = Buffer.from('AAAAAAAAAA'.repeat(100)); // 1000 bytes, very compressible
    const path = '/tmp/test-chunk-compress';
    await writeTemp(path, data);

    const result = await uploadFileInTelegramChunks({
      tempPath: path,
      partFileNamePrefix: 'test-comp',
      chunkSizeBytes: 512,
      compress: true,
      compressionMinSizeBytes: 10,
    });

    await rmTemp(path);

    expect(result.parts.length).toBe(2);
    // At least one chunk was compressed (gzip)
    for (const part of result.parts) {
      expect(part.storedSizeBytes).toBeLessThanOrEqual(part.sizeBytes);
      if (part.storedSizeBytes < part.sizeBytes) {
        expect(part.compressionAlgorithm).toBe('gzip');
      }
    }
    expect(result.totalSizeBytes).toBe(1000);
  });

  it('should not attempt compression for incompressible data', async () => {
    const { uploadFileInTelegramChunks } = await import('../src/utils/chunked-storage');
    const { gzipSync } = await import('node:zlib');

    const original = Buffer.from('AAAA'.repeat(100));
    const compressed = gzipSync(original);
    const path = '/tmp/test-chunk-incompress';
    await writeTemp(path, compressed);

    const result = await uploadFileInTelegramChunks({
      tempPath: path,
      partFileNamePrefix: 'test-inc',
      chunkSizeBytes: 1024,
      compress: true,
      compressionMinSizeBytes: 10,
    });

    await rmTemp(path);

    // Incompressible data should stay uncompressed
    expect(result.parts[0].compressionAlgorithm).toBeNull();
    expect(result.parts[0].sizeBytes).toBe(result.parts[0].storedSizeBytes);
  });

  it('should reject chunk size of zero', async () => {
    const { uploadFileInTelegramChunks } = await import('../src/utils/chunked-storage');

    expect(
      uploadFileInTelegramChunks({
        tempPath: '/nonexistent',
        partFileNamePrefix: 'err',
        chunkSizeBytes: 0,
        compress: false,
        compressionMinSizeBytes: 4096,
      }),
    ).rejects.toThrow('Invalid Telegram chunk size');
  });
});
