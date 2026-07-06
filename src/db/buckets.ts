import { sql } from 'drizzle-orm';
import { db } from './index';

export interface Bucket {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export const createBucket = async (name: string): Promise<Bucket> => {
  const result = (await db.execute(
    sql`INSERT INTO buckets (name) VALUES (${name}) RETURNING id, name, created_at, updated_at`,
  )) as unknown as QueryResult;
  const row = result.rows[0];
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
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
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
  return result.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }));
};

export const deleteBucket = async (name: string): Promise<boolean> => {
  const result = (await db.execute(
    sql`DELETE FROM buckets WHERE name = ${name}`,
  )) as unknown as QueryResult;
  return result.rowCount > 0;
};

export const bucketExists = async (name: string): Promise<boolean> => {
  const result = (await db.execute(
    sql`SELECT 1 FROM buckets WHERE name = ${name}`,
  )) as unknown as QueryResult;
  return result.rows.length > 0;
};
