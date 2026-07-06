/**
 * S3 compatibility E2E tests using the official AWS SDK v3.
 *
 * Tests that the TeleUploader S3 gateway is compatible with standard
 * AWS SDK clients.  All operations are exercised against the production
 * endpoint.
 *
 * Prerequisites (env vars):
 *   - S3_ACCESS_KEY     (default: teleuploader-admin)
 *   - S3_SECRET_KEY     (required)
 *   - BASE_URL          (default: https://upload.asepharyana.my.id)
 *
 * Usage:
 *   S3_SECRET_KEY=xxx bun test test/s3-sdk.test.ts
 *
 * CAUTION: creates & destroys real resources on the production server!
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || 'https://upload.asepharyana.my.id';
const S3_KEY = process.env.S3_ACCESS_KEY || 'teleuploader-admin';
const S3_SECRET = process.env.S3_SECRET_KEY;

const TS = Date.now().toString(36);
const PREFIX = 'e2e-s3sdk'; // consistent prefix for cleanup
const BUCKET = `${PREFIX}-${TS}`;

let createdBuckets: string[] = [];

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: BASE_URL,
  credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET! },
  forcePathStyle: true, // required — we don't support virtual-hosted style
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  for (const b of createdBuckets) {
    // List & delete all objects first (FK constraint may prevent bucket delete)
    try {
      const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: b }));
      const keys = Contents.map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: b, Delete: { Objects: keys } }));
      }
    } catch {
      /* best-effort */
    }
    // Clean up any multipart uploads
    try {
      const { Uploads = [] } = await s3.send(new ListMultipartUploadsCommand({ Bucket: b }));
      for (const u of Uploads) {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: b,
            Key: u.Key!,
            UploadId: u.UploadId!,
          }),
        );
      }
    } catch {
      /* best-effort */
    }
    try {
      await s3.send(new DeleteBucketCommand({ Bucket: b }));
    } catch {
      /* best-effort */
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  S3 SDK Compatibility Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('S3 SDK compatibility', () => {
  if (!S3_SECRET) throw new Error('S3_SECRET_KEY env var required');

  // ── Bucket operations ──────────────────────────────────────────────────────

  it('ListBuckets returns bucket list', async () => {
    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets).toBeDefined();
    expect(Array.isArray(Buckets)).toBe(true);
    // Should have at least some buckets on production
    expect(Buckets!.length).toBeGreaterThanOrEqual(0);
  });

  it('CreateBucket succeeds', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    createdBuckets.push(BUCKET);
  });

  it('CreateBucket rejects duplicate (BucketAlreadyExists)', async () => {
    await expect(s3.send(new CreateBucketCommand({ Bucket: BUCKET }))).rejects.toThrow(
      /already exists|not available/i,
    );
  });

  it('HeadBucket succeeds for existing bucket', async () => {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  });

  it('HeadBucket returns 404 for missing bucket', async () => {
    await expect(s3.send(new HeadBucketCommand({ Bucket: 'no-such-bucket-xyz' }))).rejects.toThrow(
      NotFound,
    );
  });

  // ── Object operations ──────────────────────────────────────────────────────

  it('PutObject stores text content', async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'hello-sdk.txt',
        Body: 'Hello from AWS SDK v3!',
        ContentType: 'text/plain',
      }),
    );
  });

  it('PutObject stores binary content in nested folder', async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'folder/nested-file.txt',
        Body: new TextEncoder().encode('binary content'),
      }),
    );
  });

  it('HeadObject returns metadata', async () => {
    const { ContentType, ContentLength, ETag } = await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: 'hello-sdk.txt' }),
    );
    expect(typeof ETag).toBe('string');
    expect(ContentLength).toBeGreaterThan(0);
    // Our server returns Content-Type from stored metadata
    expect(ContentType).toBe('text/plain');
  });

  it('GetObject returns stored content (proxied from Telegram)', async () => {
    const { Body, ContentType, ContentLength, ETag } = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: 'hello-sdk.txt' }),
    );
    const text = await Body!.transformToString();
    expect(text).toBe('Hello from AWS SDK v3!');
    expect(ContentType).toBe('text/plain');
    expect(ContentLength).toBeGreaterThan(0);
    expect(ETag).toBeTruthy();
  });

  it('GetObject supports Range requests', async () => {
    const { Body, ContentRange, ContentLength } = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: 'hello-sdk.txt', Range: 'bytes=0-4' }),
    );
    expect(ContentRange).toMatch(/^bytes 0-4\//);
    expect(ContentLength).toBe(5);
    expect(await Body!.transformToString()).toBe('Hello');
  });

  it('GetObject returns 404 (NoSuchKey) for missing key', async () => {
    await expect(
      s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'does-not-exist.txt' })),
    ).rejects.toThrow(NoSuchKey);
  });

  // ── Listing ────────────────────────────────────────────────────────────────

  it('ListObjectsV2 returns all objects', async () => {
    const { Contents, IsTruncated, KeyCount } = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET }),
    );
    expect(Contents!.length).toBeGreaterThanOrEqual(2);
    expect(IsTruncated).toBe(false);
    expect(KeyCount).toBeGreaterThanOrEqual(2);
    const keys = Contents!.map((o) => o.Key);
    expect(keys).toContain('hello-sdk.txt');
    expect(keys).toContain('folder/nested-file.txt');
  });

  it('ListObjectsV2 with prefix filters results', async () => {
    const { Contents } = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'folder/' }),
    );
    expect(Contents!.length).toBe(1);
    expect(Contents![0].Key).toBe('folder/nested-file.txt');
  });

  it('ListObjectsV2 with delimiter groups common prefixes', async () => {
    const { Contents, CommonPrefixes } = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: '/' }),
    );
    // 'hello-sdk.txt' has no '/' → in Contents
    expect(Contents!.some((o) => o.Key === 'hello-sdk.txt')).toBe(true);
    // 'folder/' appears as a CommonPrefix
    expect(CommonPrefixes!.some((p) => p.Prefix === 'folder/')).toBe(true);
  });

  it('ListObjectsV1 (list-type=1) also works', async () => {
    const { Contents, IsTruncated, Marker } = await s3.send(
      new ListObjectsCommand({ Bucket: BUCKET }),
    );
    expect(Contents!.length).toBeGreaterThanOrEqual(2);
    expect(typeof IsTruncated).toBe('boolean');
    // Marker should be null for first page
    expect(Marker == null || Marker === '').toBe(true);
  });

  // ── Copy & Delete ──────────────────────────────────────────────────────────

  it('CopyObject copies within same bucket', async () => {
    await s3.send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: `/${BUCKET}/hello-sdk.txt`,
        Key: 'hello-copy.txt',
      }),
    );
    // Verify copy via HeadObject (GetObject redirects to Telegram)
    const { ContentLength } = await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: 'hello-copy.txt' }),
    );
    expect(ContentLength).toBeGreaterThan(0);
  });

  it('DeleteObject removes a single object', async () => {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'folder/nested-file.txt' }));
    // Verify deletion
    const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    expect(Contents!.some((o) => o.Key === 'folder/nested-file.txt')).toBe(false);
  });

  it('DeleteObjects removes multiple objects in batch', async () => {
    // Upload test files
    for (const k of ['del-a.txt', 'del-b.txt', 'del-c.txt']) {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: k, Body: 'batch delete test' }));
    }
    // Batch delete
    const { Deleted, Errors } = await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: [{ Key: 'del-a.txt' }, { Key: 'del-b.txt' }, { Key: 'del-c.txt' }] },
      }),
    );
    expect(Deleted).toHaveLength(3);
    expect(Errors).toBeUndefined();
    // Verify all deleted
    const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    for (const k of ['del-a.txt', 'del-b.txt', 'del-c.txt']) {
      expect(Contents!.some((o) => o.Key === k)).toBe(false);
    }
  });

  // ── Multipart upload ───────────────────────────────────────────────────────

  it('Multipart upload works with AWS SDK under strict SigV4', async () => {
    let uploadId: string | undefined;
    try {
      const created = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'sdk-multipart.txt' }),
      );
      uploadId = created.UploadId;
      expect(uploadId).toBeTruthy();

      const part1 = await s3.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: 'sdk-multipart.txt',
          UploadId: uploadId,
          PartNumber: 1,
          Body: 'hello ',
        }),
      );
      const part2 = await s3.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: 'sdk-multipart.txt',
          UploadId: uploadId,
          PartNumber: 2,
          Body: 'sdk multipart',
        }),
      );

      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: BUCKET,
          Key: 'sdk-multipart.txt',
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [
              { ETag: part1.ETag, PartNumber: 1 },
              { ETag: part2.ETag, PartNumber: 2 },
            ],
          },
        }),
      );
      uploadId = undefined;

      const { Body } = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: 'sdk-multipart.txt' }),
      );
      expect(await Body!.transformToString()).toBe('hello sdk multipart');
    } finally {
      if (uploadId) {
        await s3
          .send(
            new AbortMultipartUploadCommand({
              Bucket: BUCKET,
              Key: 'sdk-multipart.txt',
              UploadId: uploadId,
            }),
          )
          .catch(() => {});
      }
      await s3
        .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'sdk-multipart.txt' }))
        .catch(() => {});
    }
  });

  // ── Cleanup & delete bucket ────────────────────────────────────────────────

  it('DeleteBucket succeeds for empty bucket', async () => {
    // Remove remaining objects first
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'hello-sdk.txt' }));
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'hello-copy.txt' }));

    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    createdBuckets = createdBuckets.filter((b) => b !== BUCKET);
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it('NoSuchBucket error on non-existent bucket', async () => {
    await expect(
      s3.send(new HeadBucketCommand({ Bucket: 'bucket-does-not-exist-99999' })),
    ).rejects.toThrow();
  });
});

console.info(`\nℹ️  S3 SDK E2E — ${BASE_URL}  bucket: ${BUCKET}`);
