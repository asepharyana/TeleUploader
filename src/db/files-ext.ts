import { eq, and, sql } from 'drizzle-orm';
import { db, files as fileSchema } from './index';
import type { File } from './schema';

export interface S3FileRecord extends File {
  bucketId: string;
  s3Key: string;
}

export const findFileByBucketAndKey = async (
  bucketId: string,
  s3Key: string,
): Promise<File | null> => {
  const result = await db
    .select()
    .from(fileSchema)
    .where(
      and(
        eq(fileSchema.bucketId, bucketId),
        eq(fileSchema.s3Key, s3Key),
        eq(fileSchema.isDeleted, false),
      ),
    )
    .limit(1);
  return result[0] || null;
};

const mapDbRowToS3Record = (row: Record<string, unknown>): S3FileRecord => {
  return {
    id: row.id as string,
    publicId: row.public_id as string,
    telegramFileId: row.telegram_file_id as string,
    telegramFileUniqueId: row.telegram_file_unique_id as string,
    storageChatId: row.storage_chat_id as number,
    storageMessageId: row.storage_message_id as number,
    fileName: row.file_name as string,
    mimeType: row.mime_type as string,
    sizeBytes: row.size_bytes as number,
    fileType: row.file_type as string,
    uploaderId: row.uploader_id as number,
    fileHash: row.file_hash as string | null,
    archiveTelegramFileId: row.archive_telegram_file_id as string | null,
    archiveStorageMessageId: row.archive_storage_message_id as number | null,
    archiveFileName: row.archive_file_name as string | null,
    archiveEntryName: row.archive_entry_name as string | null,
    archiveMimeType: row.archive_mime_type as string | null,
    archiveSizeBytes: row.archive_size_bytes as number | null,
    bucketId: row.bucket_id as string,
    s3Key: row.s3_key as string,
    storageBackend: (row.storage_backend as string) || 'telegram',
    isDeleted: row.is_deleted as boolean,
    multipartUploadId: row.multipart_upload_id as string | null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
};

export const listObjectsByPrefix = async (
  bucketId: string,
  prefix: string,
  delimiter: string | null,
  maxKeys: number,
  startAfter: string | null,
): Promise<{ objects: S3FileRecord[]; prefixes: string[] }> => {
  let query = sql`SELECT * FROM files WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false AND s3_key LIKE ${prefix + '%'}`;

  if (startAfter) {
    query = sql`${query} AND s3_key > ${startAfter}`;
  }

  query = sql`${query} ORDER BY s3_key LIMIT ${maxKeys + 1}`;

  const rawResult = (await db.execute(query)) as unknown as {
    rows: Record<string, unknown>[];
  };

  if (delimiter === '/') {
    const prefixSet = new Set<string>();
    const objects: S3FileRecord[] = [];

    for (const row of rawResult.rows) {
      const s3Key = row.s3_key as string;
      const relativeKey = s3Key.substring(prefix.length);
      const slashIndex = relativeKey.indexOf('/');
      if (slashIndex >= 0) {
        const folderPrefix = prefix + relativeKey.substring(0, slashIndex + 1);
        if (folderPrefix !== prefix) {
          prefixSet.add(folderPrefix);
        }
      } else {
        objects.push(mapDbRowToS3Record(row));
      }
    }

    return {
      objects: objects.slice(0, maxKeys),
      prefixes: Array.from(prefixSet).sort(),
    };
  }

  return {
    objects: rawResult.rows.slice(0, maxKeys).map(mapDbRowToS3Record),
    prefixes: [],
  };
};

export const softDeleteFile = async (bucketId: string, s3Key: string): Promise<boolean> => {
  const result = (await db.execute(
    sql`UPDATE files SET is_deleted = true WHERE bucket_id = ${bucketId}::uuid AND s3_key = ${s3Key} RETURNING id`,
  )) as unknown as { rows: Record<string, unknown>[] };
  return result.rows.length > 0;
};

export const softDeleteFilesBatch = async (
  bucketId: string,
  keys: string[],
): Promise<number> => {
  let deleted = 0;
  for (const key of keys) {
    const ok = await softDeleteFile(bucketId, key);
    if (ok) deleted++;
  }
  return deleted;
};

export const countBucketObjects = async (bucketId: string): Promise<number> => {
  const result = (await db.execute(
    sql`SELECT count(*) as count FROM files WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false`,
  )) as unknown as { rows: Record<string, unknown>[] };
  return Number(result.rows[0]?.count || 0);
};

export const findOrphanFilesByBucket = async (bucketId: string): Promise<File[]> => {
  return await db
    .select()
    .from(fileSchema)
    .where(and(eq(fileSchema.bucketId, bucketId), eq(fileSchema.isDeleted, true)))
    .limit(100);
};
