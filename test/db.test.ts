import { describe, expect, it } from 'bun:test';
import { db, files } from '../src/infrastructure/persistence/drizzle/index';
import { files as schemaFiles } from '../src/infrastructure/persistence/drizzle/schema';

describe('Database Layer', () => {
  it('should export db instance', () => {
    expect(db).toBeDefined();
  });

  it('should export files schema from both index and schema', () => {
    expect(files).toBeDefined();
    expect(schemaFiles).toBeDefined();
  });

  it('should have correct schema properties', () => {
    expect(files.id).toBeDefined();
    expect(files.publicId).toBeDefined();
    expect(files.telegramFileId).toBeDefined();
    expect(files.telegramFileUniqueId).toBeDefined();
    expect(files.storageChatId).toBeDefined();
    expect(files.storageMessageId).toBeDefined();
    expect(files.fileName).toBeDefined();
    expect(files.mimeType).toBeDefined();
    expect(files.sizeBytes).toBeDefined();
    expect(files.fileType).toBeDefined();
    expect(files.uploaderId).toBeDefined();
    expect(files.fileHash).toBeDefined();
    expect(files.createdAt).toBeDefined();
    expect(files.updatedAt).toBeDefined();
  });
});
