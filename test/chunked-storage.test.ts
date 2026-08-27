import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ITelegramService } from '../src/domain/ports/telegram-service';
import { ChunkedStorage } from '../src/infrastructure/telegram/chunked-storage';

/**
 * Tests the real ChunkedStorage class (src/infrastructure/telegram/
 * chunked-storage.ts). uploadFileInTelegramChunks only depends on the injected
 * telegramService, so we stub that and pass no-op repos for the rest.
 *
 * Rewritten from a stale test that imported the old `src/utils/chunked-storage`
 * layout, which no longer exists after the refactor.
 */
const makeTelegramStub = (): ITelegramService =>
  ({
    forwardToStorage: mock(async (_bytes: unknown, fileName: string) => ({
      telegramFileId: `tg-${fileName}`,
      telegramFileUniqueId: `tg-unique-${fileName}`,
      storageMessageId: Math.floor(Math.random() * 100000) + 1,
    })),
    getFileInfo: mock(async (telegramFileId: string) => ({
      file_size: 0,
      mime_type: 'application/octet-stream',
      file_path: `documents/${telegramFileId}`,
      bot_token: '123456:ABC-DEF',
    })),
  }) as unknown as ITelegramService;

const noopRepo = {} as never;

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

describe('ChunkedStorage.uploadFileInTelegramChunks', () => {
  let storage: ChunkedStorage;
  let tg: ITelegramService;

  beforeEach(() => {
    tg = makeTelegramStub();
    storage = new ChunkedStorage(noopRepo, noopRepo, tg);
  });

  it('splits a file into the correct number of chunks', async () => {
    const data = Buffer.from('1234567890ab'); // 12 bytes
    const path = '/tmp/test-chunk-1';
    await writeTemp(path, data);

    const result = await storage.uploadFileInTelegramChunks({
      tempPath: path,
      partFileNamePrefix: 'test-1',
      chunkSizeBytes: 4,
      compress: false,
      compressionMinSizeBytes: 4096,
    });
    await rmTemp(path);

    expect(result.parts.length).toBe(3);
    expect(result.totalSizeBytes).toBe(12);
    expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(result.parts[0].sizeBytes).toBe(4);
    expect(result.parts[0].storedSizeBytes).toBe(4);
    expect(result.parts[0].compressionAlgorithm).toBeNull();
  });

  it('handles a file smaller than one chunk as a single part', async () => {
    const data = Buffer.from('abc');
    const path = '/tmp/test-chunk-small';
    await writeTemp(path, data);

    const result = await storage.uploadFileInTelegramChunks({
      tempPath: path,
      partFileNamePrefix: 'small',
      chunkSizeBytes: 1024,
      compress: false,
      compressionMinSizeBytes: 4096,
    });
    await rmTemp(path);

    expect(result.parts.length).toBe(1);
    expect(result.totalSizeBytes).toBe(3);
  });

  it('computes the correct full-file SHA-256 hash', async () => {
    const data = Buffer.from('Hello, chunked storage!');
    const path = '/tmp/test-chunk-hash';
    await writeTemp(path, data);

    const result = await storage.uploadFileInTelegramChunks({
      tempPath: path,
      partFileNamePrefix: 'hash',
      chunkSizeBytes: 10,
      compress: false,
      compressionMinSizeBytes: 4096,
    });
    await rmTemp(path);

    expect(result.fileHash).toBe(createHash('sha256').update(data).digest('hex'));
    expect(result.totalSizeBytes).toBe(data.byteLength);
  });

  it('gzip-compresses compressible chunks and records the algorithm', async () => {
    const data = Buffer.from('AAAAAAAAAA'.repeat(100)); // 1000 bytes, very compressible
    const path = '/tmp/test-chunk-compress';
    await writeTemp(path, data);

    const result = await storage.uploadFileInTelegramChunks({
      tempPath: path,
      partFileNamePrefix: 'comp',
      chunkSizeBytes: 512,
      compress: true,
      compressionMinSizeBytes: 10,
    });
    await rmTemp(path);

    expect(result.parts.length).toBe(2);
    for (const part of result.parts) {
      expect(part.storedSizeBytes).toBeLessThanOrEqual(part.sizeBytes);
      if (part.storedSizeBytes < part.sizeBytes) {
        expect(part.compressionAlgorithm).toBe('gzip');
      }
    }
    expect(result.totalSizeBytes).toBe(1000);
  });

  it('does not compress already-incompressible (gzipped) data', async () => {
    const { gzipSync } = await import('node:zlib');
    const original = Buffer.from('AAAA'.repeat(100));
    const compressed = gzipSync(original); // already gzipped → won't compress further
    const path = '/tmp/test-chunk-incompress';
    await writeTemp(path, compressed);

    const result = await storage.uploadFileInTelegramChunks({
      tempPath: path,
      partFileNamePrefix: 'inc',
      chunkSizeBytes: 1024,
      compress: true,
      compressionMinSizeBytes: 10,
    });
    await rmTemp(path);

    expect(result.parts[0].compressionAlgorithm).toBeNull();
    expect(result.parts[0].sizeBytes).toBe(result.parts[0].storedSizeBytes);
  });

  it('rejects a zero chunk size', async () => {
    await expect(
      storage.uploadFileInTelegramChunks({
        tempPath: '/nonexistent',
        partFileNamePrefix: 'err',
        chunkSizeBytes: 0,
        compress: false,
        compressionMinSizeBytes: 4096,
      }),
    ).rejects.toThrow(/chunk size/i);
  });

  it('rejects a chunk size that exceeds the Telegram 20MB safety limit', async () => {
    await expect(
      storage.uploadFileInTelegramChunks({
        tempPath: '/nonexistent',
        partFileNamePrefix: 'err',
        chunkSizeBytes: 100 * 1024 * 1024, // 100 MB
        compress: false,
        compressionMinSizeBytes: 4096,
      }),
    ).rejects.toThrow();
  });

  it('forwards each chunk to the telegram service via document type', async () => {
    const data = Buffer.from('abcdef'); // 6 bytes, 3 chunks of 2
    const path = '/tmp/test-chunk-fwd';
    await writeTemp(path, data);

    const result = await storage.uploadFileInTelegramChunks({
      tempPath: path,
      partFileNamePrefix: 'fwd',
      chunkSizeBytes: 2,
      compress: false,
      compressionMinSizeBytes: 4096,
    });
    await rmTemp(path);

    const fwd = tg.forwardToStorage as unknown as ReturnType<typeof mock>;
    expect(fwd).toHaveBeenCalledTimes(3);
    expect(result.parts.every((p) => p.telegramFileId.startsWith('tg-'))).toBe(true);
  });
});
