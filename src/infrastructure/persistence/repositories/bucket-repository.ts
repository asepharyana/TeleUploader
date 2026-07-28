import { sql } from 'drizzle-orm';
import { db } from '../drizzle/index';
import type { Bucket } from '../../../domain/entities/bucket';
import type { IBucketRepository } from '../../../domain/ports/bucket-repository';

/** Raw result row from `db.execute()`. */
type QueryRow = Record<string, unknown>;
/** Array of raw result rows. */
type QueryResult = QueryRow[];

/**
 * Maps a raw database row to a {@link Bucket} domain entity.
 */
const mapRowToBucket = (row: Record<string, unknown>): Bucket => ({
  id: row.id as string,
  name: row.name as string,
  createdAt: new Date(row.created_at as string),
  updatedAt: new Date(row.updated_at as string),
});

/**
 * Drizzle-backed implementation of {@link IBucketRepository}.
 *
 * Delegates to the same SQL queries as the original `src/db/buckets.ts`
 * module, using raw SQL for drizzle tables that are not part of the
 * typed schema.
 */
export class DrizzleBucketRepository implements IBucketRepository {
  /**
   * {@inheritDoc IBucketRepository.create}
   */
  async create(name: string): Promise<Bucket> {
    const result = (await db.execute(
      sql`INSERT INTO buckets (name) VALUES (${name}) RETURNING id, name, created_at, updated_at`,
    )) as unknown as QueryResult;
    return mapRowToBucket(result[0]!);
  }

  /**
   * {@inheritDoc IBucketRepository.findByName}
   */
  async findByName(name: string): Promise<Bucket | null> {
    const result = (await db.execute(
      sql`SELECT id, name, created_at, updated_at FROM buckets WHERE name = ${name}`,
    )) as unknown as QueryResult;
    if (result.length === 0) return null;
    return mapRowToBucket(result[0]!);
  }

  /**
   * {@inheritDoc IBucketRepository.list}
   */
  async list(): Promise<Bucket[]> {
    const result = (await db.execute(
      sql`SELECT id, name, created_at, updated_at FROM buckets ORDER BY name`,
    )) as unknown as QueryResult;
    return result.map(mapRowToBucket);
  }

  /**
   * {@inheritDoc IBucketRepository.delete}
   *
   * Cascade-deletes multipart and file rows that hold foreign-key
   * references to the bucket before deleting the bucket itself.
   * Failures during cascade are silently caught to match the original
   * defensive-cleanup behaviour.
   */
  async delete(name: string): Promise<boolean> {
    // Cascade-delete rows that hold FK references to the bucket
    await db
      .execute(
        sql`DELETE FROM multipart_parts WHERE upload_id IN (SELECT upload_id FROM multipart_uploads WHERE bucket_id IN (SELECT id FROM buckets WHERE name = ${name}))`,
      )
      .catch(() => {});
    await db
      .execute(
        sql`DELETE FROM multipart_uploads WHERE bucket_id IN (SELECT id FROM buckets WHERE name = ${name})`,
      )
      .catch(() => {});
    await db
      .execute(
        sql`DELETE FROM files WHERE bucket_id IN (SELECT id FROM buckets WHERE name = ${name})`,
      )
      .catch(() => {});
    const result = (await db.execute(
      sql`DELETE FROM buckets WHERE name = ${name}`,
    )) as unknown as QueryResult;
    return result.length > 0;
  }

  /**
   * {@inheritDoc IBucketRepository.exists}
   */
  async exists(name: string): Promise<boolean> {
    const result = (await db.execute(
      sql`SELECT 1 FROM buckets WHERE name = ${name}`,
    )) as unknown as QueryResult;
    return result.length > 0;
  }
}
