import { eq, and, sql } from 'drizzle-orm';
import { db, files as fileSchema } from './index';
import type { File } from './schema';

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

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

export const listObjectsByPrefix = async (
  bucketId: string,
  prefix: string,
  delimiter: string | null,
  maxKeys: number,
  startAfter: string | null,
): Promise<{ objects: S3FileRecord[]; prefixes: string[] }> => {
  // Use raw SQL for the complex prefix/startAfter query
  let query = sql`SELECT * FROM files WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false AND s3_key LIKE ${prefix + '%'}`;

  if (startAfter) {
    query = sql`${query} AND s3_key > ${startAfter}`;
  }

  query = sql`${query} ORDER BY s3_key LIMIT ${maxKeys + 1}`;

  const result = (await db.execute(query)) as unknown as QueryResult;

  if (delimiter === '/') {
    const prefixSet = new Set<string>();
    const objects: S3FileRecord[] = [];

    for (const row of result.rows) {
      const s3Key = row.s3_key as string;
      const relativeKey = s3Key.substring(prefix.length);
      const slashIndex = relativeKey.indexOf('/');
      if (slashIndex >= 0) {
        // It's under a subfolder — extract the folder prefix
        const folderPrefix = prefix + relativeKey.substring(0, slashIndex + 1);
        if (folderPrefix !== prefix) {
          prefixSet.add(folderPrefix);
        }
      } else {
        // It's a direct child object
        objects.push({
          ...row,
          bucketId: row.bucket_id as string,
          s3Key: s3Key,
        } as unknown as S3FileRecord);
      }
    }

    return {
      objects: objects.slice(0, maxKeys),
      prefixes: Array.from(prefixSet).sort(),
    };
  }

  return {
    objects: result.rows.slice(0, maxKeys).map(
      (row) =>
        ({
          ...row,
          bucketId: row.bucket_id as string,
          s3Key: row.s3_key as string,
        }) as unknown as S3FileRecord,
    ),
    prefixes: [],
  };
};

export const softDeleteFile = async (bucketId: string, s3Key: string): Promise<boolean> => {
  const result = (await db.execute(
    sql`UPDATE files SET is_deleted = true WHERE bucket_id = ${bucketId}::uuid AND s3_key = ${s3Key} RETURNING id`,
  )) as unknown as QueryResult;
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
  )) as unknown as QueryResult;
  return Number(result.rows[0]?.count || 0);
};
