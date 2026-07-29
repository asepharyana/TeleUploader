import {
  bigint,
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Files table definition.
 * Stores metadata about uploaded files including Telegram storage references,
 * S3 bucket information, multipart upload tracking, and archive entries.
 */
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  publicId: text('public_id').unique().notNull(),
  telegramFileId: text('telegram_file_id').notNull(),
  telegramFileUniqueId: text('telegram_file_unique_id').notNull(),
  storageChatId: bigint('storage_chat_id', { mode: 'number' }).notNull(),
  storageMessageId: bigint('storage_message_id', { mode: 'number' }).notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  fileType: text('file_type').notNull(),
  uploaderId: bigint('uploader_id', { mode: 'number' }).notNull(),
  fileHash: text('file_hash'),
  archiveTelegramFileId: text('archive_telegram_file_id'),
  archiveStorageMessageId: bigint('archive_storage_message_id', { mode: 'number' }),
  archiveFileName: text('archive_file_name'),
  archiveEntryName: text('archive_entry_name'),
  archiveMimeType: text('archive_mime_type'),
  archiveSizeBytes: bigint('archive_size_bytes', { mode: 'number' }),
  bucketId: text('bucket_id'),
  s3Key: text('s3_key'),
  storageBackend: text('storage_backend').default('telegram'),
  isDeleted: boolean('is_deleted').default(false),
  multipartUploadId: text('multipart_upload_id'),
  partCount: integer('part_count'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * File parts table definition.
 * Stores chunks of multipart uploads with per-part Telegram storage references
 * and compression metadata.
 */
export const fileParts = pgTable('file_parts', {
  id: serial('id').primaryKey(),
  fileId: uuid('file_id').notNull(),
  partNumber: integer('part_number').notNull(),
  telegramFileId: text('telegram_file_id').notNull(),
  telegramFileUniqueId: text('telegram_file_unique_id').notNull(),
  storageChatId: bigint('storage_chat_id', { mode: 'number' }).notNull(),
  storageMessageId: bigint('storage_message_id', { mode: 'number' }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storedSizeBytes: bigint('stored_size_bytes', { mode: 'number' }).notNull(),
  compressionAlgorithm: text('compression_algorithm'),
  etag: text('etag').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
