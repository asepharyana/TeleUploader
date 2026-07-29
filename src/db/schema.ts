import { eq, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const files = pgTable(
  'files',
  {
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
  },
  (table) => ({
    // H2: Prevent TOCTOU race on concurrent PUT — only one active (non-deleted)
    // object per (bucket_id, s3_key) pair.
    activeObjectIdx: uniqueIndex('active_object_idx')
      .on(table.bucketId, table.s3Key)
      .where(eq(table.isDeleted, false)),
  }),
);

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

export type File = InferSelectModel<typeof files>;
export type NewFile = InferInsertModel<typeof files>;
export type FilePart = InferSelectModel<typeof fileParts>;
export type NewFilePart = InferInsertModel<typeof fileParts>;
