import { describe, expect, it } from 'bun:test';
import { unlink, writeFile } from 'node:fs/promises';
import {
  createZip,
  extractZipEntry,
  locateZipEntry,
  sanitizeZipEntryName,
} from '../src/shared/utils/zip';

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
    expect(sanitizeZipEntryName('a\\b\\c.txt')).toBe('a_b_c.txt');
    expect(sanitizeZipEntryName('path..with..dots.txt')).toBe('path.with.dots.txt');
  });

  it('should sanitize empty, dot, and dotdot names to a safe fallback', () => {
    expect(sanitizeZipEntryName('')).toBe('file');
    expect(sanitizeZipEntryName('..')).toBe('file');
    expect(sanitizeZipEntryName('.')).toBe('file');
  });

  it('should make duplicate entry names unique', () => {
    const used = new Set<string>();
    const first = sanitizeZipEntryName('greeting.txt', used);
    const second = sanitizeZipEntryName('greeting.txt', used);
    const third = sanitizeZipEntryName('greeting.txt', used);
    expect(first).toBe('greeting.txt');
    expect(second).toBe('greeting-1.txt');
    expect(third).toBe('greeting-2.txt');
  });

  it("returns the created zip's magic number and entry names", async () => {
    const p = `/tmp/filedrop-zip-${crypto.randomUUID()}.txt`;
    await writeFile(p, 'data');
    const zip = await createZip([{ tempPath: p, fileName: 'data.txt' }]);
    try {
      const buf = Buffer.from(await Bun.file(zip.tempPath).arrayBuffer());
      expect(buf.subarray(0, 2).toString()).toBe('PK');
      expect(zip.entries[0].entryName).toBe('data.txt');
      expect(zip.sizeBytes).toBe(buf.byteLength);
    } finally {
      await cleanup(p, zip.tempPath);
    }
  });

  it('extracts a stored entry and returns null for missing or compressed entries', async () => {
    const p = `/tmp/filedrop-zip-${crypto.randomUUID()}.bin`;
    await writeFile(p, 'payload');
    const zip = await createZip([{ tempPath: p, fileName: 'x.bin' }]);
    try {
      const buf = Buffer.from(await Bun.file(zip.tempPath).arrayBuffer());
      expect(Buffer.from((await extractZipEntry(buf, 'x.bin')) ?? Buffer.alloc(0)).toString()).toBe(
        'payload',
      );
      expect(await extractZipEntry(buf, 'missing.bin')).toBeNull();
    } finally {
      await cleanup(p, zip.tempPath);
    }
  });

  it('locates an entry on disk without loading the whole archive', async () => {
    const p = `/tmp/filedrop-zip-${crypto.randomUUID()}.bin`;
    await writeFile(p, 'hello');
    const zip = await createZip([{ tempPath: p, fileName: 'hi.txt' }]);
    try {
      const loc = await locateZipEntry(zip.tempPath, 'hi.txt');
      expect(loc).not.toBeNull();
      const fd = await import('node:fs/promises').then((m) => m.open(zip.tempPath, 'r'));
      try {
        const { bytesRead } = await fd.read(Buffer.alloc(5), 0, 5, loc!.start);
        expect(bytesRead).toBe(5);
      } finally {
        await fd.close();
      }
    } finally {
      await cleanup(p, zip.tempPath);
    }
  });
});
