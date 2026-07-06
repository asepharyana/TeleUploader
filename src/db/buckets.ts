import { sql } from 'drizzle-orm';
import { db } from './index';

export interface Bucket {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

type QueryRow = Record<string, unknown>;
type QueryResult = QueryRow[];

export const createBucket = async (name: string): Promise<Bucket> => {
  const result = (await db.execute(
    sql`INSERT INTO buckets (name) VALUES (${name}) RETURNING id, name, created_at, updated_at`,
  )) as unknown as QueryResult;
  const row = result[0]!;
  return {
    id: row.id as string,
    name: row.name as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
};

export const findBucketByName = async (name: string): Promise<Bucket | null> => {
  const result = (await db.execute(
    sql`SELECT id, name, created_at, updated_at FROM buckets WHERE name = ${name}`,
  )) as unknown as QueryResult;
  if (result.length === 0) return null;
  const row = result[0]!;
  return {
    id: row.id as string,
    name: row.name as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
};

export const listBuckets = async (): Promise<Bucket[]> => {
  const result = (await db.execute(
    sql`SELECT id, name, created_at, updated_at FROM buckets ORDER BY name`,
  )) as unknown as QueryResult;
  return result.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }));
};

export const deleteBucket = async (name: string): Promise<boolean> => {
  // Cascade-delete rows that hold FK references to the bucket
  await db.execute(
    sql`DELETE FROM multipart_parts WHERE upload_id IN (SELECT upload_id FROM multipart_uploads WHERE bucket_id IN (SELECT id FROM buckets WHERE name = ${name}))`,
  ).catch(() => {});
  await db.execute(
    sql`DELETE FROM multipart_uploads WHERE bucket_id IN (SELECT id FROM buckets WHERE name = ${name})`,
  ).catch(() => {});
  await db.execute(
    sql`DELETE FROM files WHERE bucket_id IN (SELECT id FROM buckets WHERE name = ${name})`,
  ).catch(() => {});
  const result = (await db.execute(
    sql`DELETE FROM buckets WHERE name = ${name}`,
  )) as unknown as QueryResult;
  return result.length > 0;
};

export const bucketExists = async (name: string): Promise<boolean> => {
  const result = (await db.execute(
    sql`SELECT 1 FROM buckets WHERE name = ${name}`,
  )) as unknown as QueryResult;
  return result.length > 0;
};
