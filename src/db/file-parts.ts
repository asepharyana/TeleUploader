import { sql } from 'drizzle-orm';
import { db } from './index';

export type CompressionAlgorithm = 'gzip' | null;

export interface FilePart {
  id: number;
  fileId: string;
  partNumber: number;
  telegramFileId: string;
  telegramFileUniqueId: string;
  storageChatId: number;
  storageMessageId: number;
  sizeBytes: number;
  storedSizeBytes: number;
  compressionAlgorithm: CompressionAlgorithm;
  etag: string;
  createdAt: Date;
}

export type NewFilePartInput = Omit<FilePart, 'id' | 'createdAt'>;

const toNumber = (value: unknown): number => Number(value ?? 0);

const mapRowToFilePart = (row: Record<string, unknown>): FilePart => ({
  id: toNumber(row.id),
  fileId: row.file_id as string,
  partNumber: toNumber(row.part_number),
  telegramFileId: row.telegram_file_id as string,
  telegramFileUniqueId: row.telegram_file_unique_id as string,
  storageChatId: toNumber(row.storage_chat_id),
  storageMessageId: toNumber(row.storage_message_id),
  sizeBytes: toNumber(row.size_bytes),
  storedSizeBytes: toNumber(row.stored_size_bytes),
  compressionAlgorithm: (row.compression_algorithm as CompressionAlgorithm) || null,
  etag: row.etag as string,
  createdAt: new Date(row.created_at as string),
});

export const insertFileParts = async (parts: NewFilePartInput[]): Promise<void> => {
  for (const part of parts) {
    await db.execute(
      sql`INSERT INTO file_parts (
        file_id,
        part_number,
        telegram_file_id,
        telegram_file_unique_id,
        storage_chat_id,
        storage_message_id,
        size_bytes,
        stored_size_bytes,
        compression_algorithm,
        etag
      ) VALUES (
        ${part.fileId}::uuid,
        ${part.partNumber},
        ${part.telegramFileId},
        ${part.telegramFileUniqueId},
        ${part.storageChatId},
        ${part.storageMessageId},
        ${part.sizeBytes},
        ${part.storedSizeBytes},
        ${part.compressionAlgorithm},
        ${part.etag}
      )`,
    );
  }
};

export const listFileParts = async (fileId: string): Promise<FilePart[]> => {
  const result = (await db.execute(
    sql`SELECT id,
      file_id,
      part_number,
      telegram_file_id,
      telegram_file_unique_id,
      storage_chat_id,
      storage_message_id,
      size_bytes,
      stored_size_bytes,
      compression_algorithm,
      etag,
      created_at
    FROM file_parts
    WHERE file_id = ${fileId}::uuid
    ORDER BY part_number`,
  )) as unknown as Record<string, unknown>[];

  return result.map(mapRowToFilePart);
};

export const countFileParts = async (fileId: string): Promise<number> => {
  const result = (await db.execute(
    sql`SELECT COUNT(*) AS count FROM file_parts WHERE file_id = ${fileId}::uuid`,
  )) as unknown as Record<string, unknown>[];
  return toNumber(result[0]?.count);
};
