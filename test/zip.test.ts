import { describe, expect, it } from 'bun:test';
import { unlink, writeFile } from 'node:fs/promises';
import { createZip, extractZipEntry, sanitizeZipEntryName } from '../src/utils/zip';

const cleanup = async (...paths: string[]) => {
  await Promise.all(
    paths.map(async (path) => {
      try {
        await unlink(path);
      } catch {}
    }),
  );
};

describe('ZIP utilities', () => {
  it('should create a zip and extract entries by name', async () => {
    const firstPath = `/tmp/filedrop-test-${crypto.randomUUID()}-1.txt`;
    const secondPath = `/tmp/filedrop-test-${crypto.randomUUID()}-2.txt`;
    await writeFile(firstPath, 'hello');
    await writeFile(secondPath, 'world');

    const zip = await createZip([
      { tempPath: firstPath, fileName: 'greeting.txt' },
      { tempPath: secondPath, fileName: 'greeting.txt' },
    ]);

    try {
      const zipBuffer = Buffer.from(await Bun.file(zip.tempPath).arrayBuffer());
      expect(zipBuffer.subarray(0, 2).toString()).toBe('PK');
      expect(zip.entries.map((entry) => entry.entryName)).toEqual([
        'greeting.txt',
        'greeting-1.txt',
      ]);
      expect((await extractZipEntry(zipBuffer, 'greeting.txt'))?.toString()).toBe('hello');
      expect((await extractZipEntry(zipBuffer, 'greeting-1.txt'))?.toString()).toBe('world');
    } finally {
      await cleanup(firstPath, secondPath, zip.tempPath);
    }
  });

  it('should sanitize unsafe entry names', () => {
    expect(sanitizeZipEntryName('../secret.txt')).toBe('secret.txt');
    expect(sanitizeZipEntryName('nested/path/file.txt')).toBe('file.txt');
  });
});
