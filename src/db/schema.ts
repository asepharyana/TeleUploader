import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { bigint, boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type File = InferSelectModel<typeof files>;
export type NewFile = InferInsertModel<typeof files>;
