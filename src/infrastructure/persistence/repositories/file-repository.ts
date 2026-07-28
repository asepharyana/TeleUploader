import { and, eq, sql } from 'drizzle-orm';
import { db, files as fileSchema } from '../drizzle/index';
import type { File, NewFile } from '../../../domain/entities/file';
import type {
  IFileRepository,
  S3FileRecord,
} from '../../../domain/ports/file-repository';

/** Safely converts a raw value to a number, defaulting to 0. */
const toNumber = (value: unknown): number => Number(value ?? 0);

/**
 * Escape special LIKE wildcard characters (`%`, `_`, `\`) so that
 * a user-supplied prefix can be safely used in a LIKE expression.
 */
const escapeLike = (s: string): string => s.replace(/[%_\\]/g, '\\$&');

/**
 * Maps a raw database row (snake_case keys) to an {@link S3FileRecord}
 * domain entity.  Used only when raw SQL via `db.execute()` returns
 * un-typed result sets.
 */
const mapDbRowToS3Record = (row: Record<string, unknown>): S3FileRecord => ({
  id: row.id as string,
  publicId: row.public_id as string,
  telegramFileId: row.telegram_file_id as string,
  telegramFileUniqueId: row.telegram_file_unique_id as string,
  storageChatId: toNumber(row.storage_chat_id),
  storageMessageId: toNumber(row.storage_message_id),
  fileName: row.file_name as string,
  mimeType: row.mime_type as string,
  sizeBytes: toNumber(row.size_bytes),
  fileType: row.file_type as string,
  uploaderId: toNumber(row.uploader_id),
  fileHash: row.file_hash as string | null,
  archiveTelegramFileId: row.archive_telegram_file_id as string | null,
  archiveStorageMessageId:
    row.archive_storage_message_id === null
      ? null
      : toNumber(row.archive_storage_message_id),
  archiveFileName: row.archive_file_name as string | null,
  archiveEntryName: row.archive_entry_name as string | null,
  archiveMimeType: row.archive_mime_type as string | null,
  archiveSizeBytes:
    row.archive_size_bytes === null
      ? null
      : toNumber(row.archive_size_bytes),
  bucketId: row.bucket_id as string,
  s3Key: row.s3_key as string,
  storageBackend: (row.storage_backend as string) || 'telegram',
  isDeleted: row.is_deleted as boolean,
  multipartUploadId: row.multipart_upload_id as string | null,
  partCount:
    row.part_count === null || row.part_count === undefined
      ? null
      : toNumber(row.part_count),
  createdAt: new Date(row.created_at as string),
  updatedAt: new Date(row.updated_at as string),
});

/**
 * Drizzle-backed implementation of {@link IFileRepository}.
 *
 * Delegates to the same SQL queries as the original `src/db/files.ts` and
 * `src/db/files-ext.ts` modules while presenting a clean domain interface.
 */
export class DrizzleFileRepository implements IFileRepository {
  /**
   * {@inheritDoc IFileRepository.findByHash}
   */
  async findByHash(hash: string): Promise<File | null> {
    const result = await db
      .select()
      .from(fileSchema)
      .where(eq(fileSchema.fileHash, hash))
      .limit(1);
    return result[0] || null;
  }

  /**
   * {@inheritDoc IFileRepository.findByPublicId}
   */
  async findByPublicId(publicId: string): Promise<File | null> {
    const result = await db
      .select()
      .from(fileSchema)
      .where(eq(fileSchema.publicId, publicId))
      .limit(1);
    return result[0] || null;
  }

  /**
   * {@inheritDoc IFileRepository.findByUniqueId}
   */
  async findByUniqueId(telegramFileUniqueId: string): Promise<File | null> {
    const result = await db
      .select()
      .from(fileSchema)
      .where(eq(fileSchema.telegramFileUniqueId, telegramFileUniqueId))
      .limit(1);
    return result[0] || null;
  }

  /**
   * {@inheritDoc IFileRepository.findByBucketAndKey}
   */
  async findByBucketAndKey(
    bucketId: string,
    s3Key: string,
  ): Promise<File | null> {
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
  }

  /**
   * {@inheritDoc IFileRepository.create}
   */
  async create(file: NewFile): Promise<File> {
    const result = await db
      .insert(fileSchema)
      .values(file)
      .returning();
    return result[0]!;
  }

  /**
   * {@inheritDoc IFileRepository.listByPrefix}
   */
  async listByPrefix(
    bucketId: string,
    prefix: string,
    delimiter: string | null,
    maxKeys: number,
    startAfter: string | null,
  ): Promise<{ objects: S3FileRecord[]; prefixes: string[] }> {
    let query = prefix
      ? sql`SELECT * FROM files WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false AND s3_key LIKE ${`${escapeLike(prefix)}%`}`
      : sql`SELECT * FROM files WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false`;

    if (startAfter) {
      query = sql`${query} AND s3_key > ${startAfter}`;
    }

    query = sql`${query} ORDER BY s3_key LIMIT ${maxKeys + 1}`;

    const rawResult = (await db.execute(
      query,
    )) as unknown as Record<string, unknown>[];

    if (delimiter === '/') {
      const prefixSet = new Set<string>();
      const objects: S3FileRecord[] = [];

      for (const row of rawResult) {
        const s3Key = row.s3_key as string;
        const relativeKey = s3Key.substring(prefix.length);
        const slashIndex = relativeKey.indexOf('/');
        if (slashIndex >= 0) {
          const folderPrefix =
            prefix + relativeKey.substring(0, slashIndex + 1);
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
      objects: rawResult.slice(0, maxKeys).map(mapDbRowToS3Record),
      prefixes: [],
    };
  }

  /**
   * {@inheritDoc IFileRepository.softDelete}
   */
  async softDelete(bucketId: string, s3Key: string): Promise<boolean> {
    const result = (await db.execute(
      sql`UPDATE files SET is_deleted = true WHERE bucket_id = ${bucketId}::uuid AND s3_key = ${s3Key} RETURNING id`,
    )) as unknown as Record<string, unknown>[];
    return result.length > 0;
  }

  /**
   * {@inheritDoc IFileRepository.softDeleteBatch}
   */
  async softDeleteBatch(
    bucketId: string,
    keys: string[],
  ): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      const ok = await this.softDelete(bucketId, key);
      if (ok) deleted++;
    }
    return deleted;
  }

  /**
   * {@inheritDoc IFileRepository.countByBucket}
   */
  async countByBucket(bucketId: string): Promise<number> {
    const result = (await db.execute(
      sql`SELECT count(*) as count FROM files WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false`,
    )) as unknown as Record<string, unknown>[];
    return Number(result[0]?.count || 0);
  }

  /**
   * {@inheritDoc IFileRepository.findOrphansByBucket}
   */
  async findOrphansByBucket(bucketId: string): Promise<File[]> {
    return await db
      .select()
      .from(fileSchema)
      .where(
        and(
          eq(fileSchema.bucketId, bucketId),
          eq(fileSchema.isDeleted, true),
        ),
      )
      .limit(100);
  }
}
