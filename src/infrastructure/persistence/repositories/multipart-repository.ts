import { sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { MultipartPart, MultipartUpload } from '../../../domain/entities/multipart';
import type { IMultipartRepository } from '../../../domain/ports/multipart-repository';
import { db } from '../drizzle/index';

/**
 * Maps a raw database row to a {@link MultipartUpload} domain entity.
 */
const mapRowToMultipartUpload = (r: Record<string, unknown>): MultipartUpload => ({
  uploadId: r.upload_id as string,
  bucketId: r.bucket_id as string,
  s3Key: r.s3_key as string,
  initiatedAt: new Date(r.initiated_at as string),
  status: r.status as string,
  initiatedBy: (r.initiated_by as string | null) || '',
});

/**
 * Drizzle-backed implementation of {@link IMultipartRepository}.
 *
 * Delegates to the same SQL queries as the original `src/db/multipart.ts`
 * module, using raw SQL for all operations on the un-typed
 * `multipart_uploads` and `multipart_parts` tables.
 */
export class DrizzleMultipartRepository implements IMultipartRepository {
  /**
   * {@inheritDoc IMultipartRepository.create}
   */
  async create(bucketId: string, s3Key: string, initiatedBy: string): Promise<string> {
    const uploadId = nanoid(32);
    await db.execute(
      sql`INSERT INTO multipart_uploads (upload_id, bucket_id, s3_key, initiated_by) VALUES (${uploadId}, ${bucketId}, ${s3Key}, ${initiatedBy})`,
    );
    return uploadId;
  }

  /**
   * {@inheritDoc IMultipartRepository.findById}
   */
  async findById(uploadId: string): Promise<MultipartUpload | null> {
    const result = (await db.execute(
      sql`SELECT upload_id, bucket_id, s3_key, initiated_at, status FROM multipart_uploads WHERE upload_id = ${uploadId} AND status = 'in_progress'`,
    )) as unknown as Record<string, unknown>[];
    if (result.length === 0) return null;
    const r = result[0]!;
    return {
      uploadId: r.upload_id as string,
      bucketId: r.bucket_id as string,
      s3Key: r.s3_key as string,
      initiatedAt: new Date(r.initiated_at as string),
      status: r.status as string,
      initiatedBy: '',
    };
  }

  /**
   * {@inheritDoc IMultipartRepository.complete}
   */
  async complete(uploadId: string): Promise<void> {
    await db.execute(
      sql`UPDATE multipart_uploads SET status = 'completed' WHERE upload_id = ${uploadId}`,
    );
  }

  /**
   * {@inheritDoc IMultipartRepository.abort}
   */
  async abort(uploadId: string): Promise<void> {
    await db.execute(
      sql`UPDATE multipart_uploads SET status = 'aborted' WHERE upload_id = ${uploadId}`,
    );
  }

  /**
   * {@inheritDoc IMultipartRepository.insertPart}
   */
  async insertPart(part: Omit<MultipartPart, 'id' | 'createdAt'>): Promise<void> {
    await db.execute(
      sql`INSERT INTO multipart_parts (upload_id, part_number, telegram_file_id, telegram_file_unique_id, storage_message_id, size_bytes, etag)
          VALUES (${part.uploadId}, ${part.partNumber}, ${part.telegramFileId}, ${part.telegramFileUniqueId}, ${part.storageMessageId}, ${part.sizeBytes}, ${part.etag})`,
    );
  }

  /**
   * {@inheritDoc IMultipartRepository.listParts}
   */
  async listParts(uploadId: string): Promise<MultipartPart[]> {
    const result = (await db.execute(
      sql`SELECT id, upload_id, part_number, telegram_file_id, telegram_file_unique_id, storage_message_id, size_bytes, etag, created_at
          FROM multipart_parts WHERE upload_id = ${uploadId} ORDER BY part_number`,
    )) as unknown as Record<string, unknown>[];
    return result.map((r) => ({
      id: r.id as number,
      uploadId: r.upload_id as string,
      partNumber: r.part_number as number,
      telegramFileId: r.telegram_file_id as string,
      telegramFileUniqueId: r.telegram_file_unique_id as string,
      storageMessageId: r.storage_message_id as number,
      sizeBytes: Number(r.size_bytes),
      etag: r.etag as string,
      createdAt: new Date(r.created_at as string),
    }));
  }

  /**
   * {@inheritDoc IMultipartRepository.listByBucket}
   */
  async listByBucket(
    bucketId: string,
    maxUploads: number,
    keyMarker: string | null,
  ): Promise<{
    uploads: MultipartUpload[];
    isTruncated: boolean;
    nextKeyMarker: string | null;
  }> {
    const limit = Math.min(Math.max(maxUploads || 1000, 1), 1000);
    const result = (await db.execute(
      keyMarker
        ? sql`SELECT upload_id, bucket_id, s3_key, initiated_at, status, initiated_by
            FROM multipart_uploads
            WHERE bucket_id = ${bucketId}::uuid AND status = 'in_progress' AND s3_key > ${keyMarker}
            ORDER BY s3_key, initiated_at
            LIMIT ${limit + 1}`
        : sql`SELECT upload_id, bucket_id, s3_key, initiated_at, status, initiated_by
            FROM multipart_uploads
            WHERE bucket_id = ${bucketId}::uuid AND status = 'in_progress'
            ORDER BY s3_key, initiated_at
            LIMIT ${limit + 1}`,
    )) as unknown as Record<string, unknown>[];

    const uploads = result.slice(0, limit).map(mapRowToMultipartUpload);
    return {
      uploads,
      isTruncated: result.length > limit,
      nextKeyMarker: result.length > limit ? uploads.at(-1)?.s3Key || null : null,
    };
  }
}
