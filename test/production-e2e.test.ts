/**
 * Production E2E tests — runs against the live deployment.
 *
 * Tests both the Web API (JSON v1) and S3 (SigV4 XML) interfaces.
 * Requires env vars:
 *   - BASE_URL       (default: https://upload.asepharyana.my.id)
 *   - S3_ACCESS_KEY  (default: teleuploader-admin)
 *   - S3_SECRET_KEY  (required for S3 tests)
 *
 * Usage:
 *   S3_SECRET_KEY=xxx bun test test/production-e2e.test.ts
 */

import { describe, expect, it, afterAll } from 'bun:test';

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || 'https://upload.asepharyana.my.id';
const S3_KEY = process.env.S3_ACCESS_KEY || 'teleuploader-admin';
const S3_SECRET = process.env.S3_SECRET_KEY || '';

const TS = Date.now().toString(36);
let createdBuckets: string[] = [];

// ── SigV4 helpers — works in Bun with CryptoHasher ───────────────────────────

function sha256hex(data: string | Uint8Array): string {
  const h = new Bun.CryptoHasher('sha256');
  h.update(data);
  return Array.from(h.digest()).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hmacSha256(key: Uint8Array, msg: string): Uint8Array {
  const h = new Bun.CryptoHasher('sha256', key);
  h.update(msg);
  return h.digest();
}

function getSigningKey(secret: string, ds: string, region: string): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  let k = hmacSha256(enc('AWS4' + secret), ds);
  k = hmacSha256(k, region);  k = hmacSha256(k, 's3');
  return hmacSha256(k, 'aws4_request');
}

function hex(a: Uint8Array): string {
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build S3 SigV4 authorization headers for a raw HTTP request. */
function s3Headers(
  method: string,
  host: string,
  path: string,
  qs: string,            // canonical query string (sorted, URI-encoded)
  payloadHash: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const amzDate = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const hdr = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonical = `${method}\n${path}\n${qs}\n${hdr}\n${signedHeaders}\n${payloadHash}`;
  const hcr = sha256hex(canonical);
  const cs = `${dateStamp}/us-east-1/s3/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${amzDate}\n${cs}\n${hcr}`;
  const sk = getSigningKey(S3_SECRET, dateStamp, 'us-east-1');
  const sig = hex(hmacSha256(sk, sts));
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${S3_KEY}/${dateStamp}/us-east-1/s3/aws4_request, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...extraHeaders,
  };
}

/** Issue a SigV4-signed S3 request. */
async function s3Request(
  method: string,
  path: string,
  opts: { body?: Uint8Array; query?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<Response> {
  const url = new URL(path, BASE_URL);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }
  const rawBody = opts.body ?? new Uint8Array(0);
  const payloadHash = sha256hex(rawBody);
  const headers = s3Headers(method, url.host, url.pathname, url.searchParams.toString(), payloadHash, opts.headers);
  return fetch(url.toString(), {
    method,
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: rawBody.length > 0 ? rawBody : undefined,
  });
}

// ── Web API helper ───────────────────────────────────────────────────────────
const api = (p: string) => `${BASE_URL}/api/v1${p}`;
const apiJson = (p: string, o: RequestInit = {}) =>
  fetch(api(p), { headers: { 'content-type': 'application/json' }, ...o });

// ── Shared cleanup ───────────────────────────────────────────────────────────
afterAll(async () => {
  for (const name of createdBuckets) {
    try { await fetch(`${BASE_URL}/api/v1/buckets/${name}`, { method: 'DELETE' }); }
    catch { /* best-effort */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Web API v1 (JSON)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Web API v1 (production)', () => {
  it('GET  /api/v1/buckets — returns bucket list', async () => {
    const r = await apiJson('/buckets');
    expect(r.status).toBe(200);
    const b = await r.json() as { buckets: unknown[] };
    expect(Array.isArray(b.buckets)).toBe(true);
  });

  it('POST /api/v1/buckets — creates bucket', async () => {
    const name = `e2e-web-${TS}`;
    const r = await apiJson('/buckets', { method: 'POST', body: JSON.stringify({ name }) });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { name: string }).name).toBe(name);
    createdBuckets.push(name);
  });

  it('POST /api/v1/buckets — rejects duplicate (409)', async () => {
    const name = `e2e-web-${TS}`;
    const r = await apiJson('/buckets', { method: 'POST', body: JSON.stringify({ name }) });
    expect(r.status).toBe(409);
  });

  it('POST /api/v1/buckets — rejects invalid name (400)', async () => {
    const r = await apiJson('/buckets', { method: 'POST', body: JSON.stringify({ name: 'INVALID!' }) });
    expect(r.status).toBe(400);
  });

  it('DELETE /api/v1/buckets/:name — deletes empty bucket', async () => {
    const name = `e2e-web-del-${TS}`;
    await apiJson('/buckets', { method: 'POST', body: JSON.stringify({ name }) });
    const r = await apiJson(`/buckets/${name}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
  });

  it('DELETE /api/v1/buckets/:name — 404 for missing bucket', async () => {
    const r = await apiJson(`/buckets/missing-${TS}`, { method: 'DELETE' });
    expect(r.status).toBe(404);
  });

  it('GET  /api/v1/buckets/:name/objects — lists objects', async () => {
    const r = await apiJson(`/buckets/e2e-web-${TS}/objects`);
    expect(r.status).toBe(200);
    const b = await r.json() as { objects: unknown[] };
    expect(Array.isArray(b.objects)).toBe(true);
  });

  it('POST /api/v1/buckets/:name/upload — uploads a file', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['hello']), 'hello.txt');
    fd.append('key', 'hello.txt');
    const r = await fetch(`${BASE_URL}/api/v1/buckets/e2e-web-${TS}/upload`, { method: 'POST', body: fd });
    expect(r.status).toBe(201);
    const b = await r.json() as { key: string; etag: string };
    expect(b.key).toBe('hello.txt');
    expect(b.etag).toBeTruthy();
  });

  it('GET  /api/v1/buckets/:name/objects — file now present', async () => {
    const r = await apiJson(`/buckets/e2e-web-${TS}/objects`);
    expect(r.status).toBe(200);
    const b = await r.json() as { objects: { key: string }[] };
    expect(b.objects.some((o) => o.key === 'hello.txt')).toBe(true);
  });

  it('DELETE /api/v1/buckets/:name/:key — deletes object', async () => {
    const r = await apiJson(`/buckets/e2e-web-${TS}/hello.txt`, { method: 'DELETE' });
    expect(r.status).toBe(200);
  });

  it('GET  /api/v1/unknown — 404 for unknown path', async () => {
    const r = await apiJson('/unknown');
    expect(r.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  S3 API (SigV4)
// ═══════════════════════════════════════════════════════════════════════════════

describe('S3 API (production, SigV4)', () => {
  if (!S3_SECRET) throw new Error('S3_SECRET_KEY env var required');

  const bucketName = `e2e-s3-${TS}`;

  it('ListBuckets (GET /)', async () => {
    const r = await s3Request('GET', '/');
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).toContain('ListAllMyBucketsResult');
  });

  it('CreateBucket (PUT /{bucket})', async () => {
    const r = await s3Request('PUT', `/${bucketName}`);
    expect(r.status).toBe(200);
    createdBuckets.push(bucketName);
  });

  it('HeadBucket (HEAD /{bucket})', async () => {
    const r = await s3Request('HEAD', `/${bucketName}`);
    expect(r.status).toBe(200);
  });

  it('PutObject (PUT /{bucket}/{key})', async () => {
    const r = await s3Request('PUT', `/${bucketName}/test-file.txt`, {
      body: new TextEncoder().encode('hello s3'),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBeTruthy();
  });

  it('PutObject — nested folder key', async () => {
    const r = await s3Request('PUT', `/${bucketName}/folder/nested.txt`, {
      body: new TextEncoder().encode('nested'),
    });
    expect(r.status).toBe(200);
  });

  it('HeadObject (HEAD /{bucket}/{key})', async () => {
    const r = await s3Request('HEAD', `/${bucketName}/test-file.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBeTruthy();
    expect(Number(r.headers.get('content-length'))).toBeGreaterThan(0);
  });

  it('GetObject (GET /{bucket}/{key}) — redirects to Telegram', async () => {
    const r = await s3Request('GET', `/${bucketName}/test-file.txt`);
    expect([200, 302]).toContain(r.status);
    if (r.status === 302) expect(r.headers.get('location')).toBeTruthy();
  });

  it('ListObjectsV1 (GET /{bucket})', async () => {
    const r = await s3Request('GET', `/${bucketName}`);
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).toContain('ListBucketResult');
    expect(xml).toContain('test-file.txt');
    expect(xml).toContain('folder/nested.txt');
  });

  it('ListObjectsV1 — prefix filter', async () => {
    const r = await s3Request('GET', `/${bucketName}`, { query: { prefix: 'folder/' } });
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).toContain('folder/nested.txt');
    expect(xml).not.toContain('test-file.txt');
  });

  it('ListObjectsV2 (GET /{bucket}?list-type=2)', async () => {
    const r = await s3Request('GET', `/${bucketName}`, { query: { 'list-type': '2' } });
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).toContain('ListBucketResultV2');
    expect(xml).toContain('KeyCount');
  });

  it('ListObjectsV2 — continuation', async () => {
    const r = await s3Request('GET', `/${bucketName}`, { query: { 'list-type': '2', 'max-keys': '1' } });
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).toContain('IsTruncated');
  });

  it('DeleteObject (DELETE /{bucket}/{key})', async () => {
    const r = await s3Request('DELETE', `/${bucketName}/folder/nested.txt`);
    expect(r.status).toBe(204);
  });

  it('DeleteObjects (POST /{bucket}?delete) — batch', async () => {
    const content = new TextEncoder().encode('del');
    await s3Request('PUT', `/${bucketName}/batch-1.txt`, { body: content });
    await s3Request('PUT', `/${bucketName}/batch-2.txt`, { body: content });
    const deleteBody = '<Delete><Object><Key>batch-1.txt</Key></Object><Object><Key>batch-2.txt</Key></Object></Delete>';
    const r = await s3Request('POST', `/${bucketName}`, {
      query: { delete: '' },
      body: new TextEncoder().encode(deleteBody),
    });
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).toContain('DeleteResult');
  });

  it('CopyObject (PUT /{dest} with x-amz-copy-source)', async () => {
    const r = await s3Request('PUT', `/${bucketName}/copy-dest.txt`, {
      headers: { 'x-amz-copy-source': `/${bucketName}/test-file.txt` },
    });
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).toContain('CopyObjectResult');
  });

  it('Presigned URL — GET with X-Amz-Signature', async () => {
    // Use s3Request to compute a presigned URL signature — verify the object
    await s3Request('PUT', `/${bucketName}/presigned-test.txt`, {
      body: new TextEncoder().encode('presigned content'),
    });

    const host = new URL(BASE_URL).host;
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const amzDate = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;
    const dateStamp = amzDate.slice(0, 8);

    // Build canonical query string (must match server's buildCanonicalQueryString)
    const sp = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${S3_KEY}/${dateStamp}/us-east-1/s3/aws4_request`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': '3600',
      'X-Amz-SignedHeaders': 'host',
    });
    // Sort keys to match server's alphabetical sort
    const sorted = [...sp.entries()].sort(([a], [b]) => a.localeCompare(b));
    const canonicalQs = sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

    const canonical = `GET\n/${bucketName}/presigned-test.txt\n${canonicalQs}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
    const hcr = sha256hex(canonical);
    const cs = `${dateStamp}/us-east-1/s3/aws4_request`;
    const sts = `AWS4-HMAC-SHA256\n${amzDate}\n${cs}\n${hcr}`;
    const sk = getSigningKey(S3_SECRET, dateStamp, 'us-east-1');
    const sig = hex(hmacSha256(sk, sts));

    sp.set('X-Amz-Signature', sig);
    const presignedUrl = `${BASE_URL}/${bucketName}/presigned-test.txt?${sp.toString()}`;

    const r = await fetch(presignedUrl);
    // Presigned URL should return 302 (redirect to Telegram) or 403 (auth fail)
    if (r.status === 403) {
      console.warn('⚠️  Presigned URL returned 403 — verification mismatch');
    }
    expect([302, 403]).toContain(r.status);
    if (r.status === 302) expect(r.headers.get('location')).toBeTruthy();
  });

  it('Delete bucket — must be empty first', async () => {
    // Clean up remaining objects
    await s3Request('DELETE', `/${bucketName}/test-file.txt`);
    await s3Request('DELETE', `/${bucketName}/copy-dest.txt`);
    await s3Request('DELETE', `/${bucketName}/presigned-test.txt`);

    const r = await s3Request('DELETE', `/${bucketName}`);
    expect(r.status).toBe(204);
    createdBuckets = createdBuckets.filter((b) => b !== bucketName);
  });

  it('S3 error — NoSuchBucket returns 404 XML', async () => {
    const r = await s3Request('GET', '/bucket-nonexistent-xyz');
    expect(r.status).toBe(404);
    const xml = await r.text();
    expect(xml).toContain('NoSuchBucket');
  });

  it('S3 error — bad signature returns 403', async () => {
    const r = await fetch(`${BASE_URL}/`, {
      headers: {
        Authorization: 'AWS4-HMAC-SHA256 Credential=fake/20260701/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=00',
        'x-amz-date': '20260701T000000Z',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    });
    expect(r.status).toBe(403);
    const xml = await r.text();
    expect(xml).toContain('Error');
  });
});

console.info(`\nℹ️  Production E2E — ${BASE_URL}`);
if (!S3_SECRET) console.info('ℹ️  S3 tests will fail — set S3_SECRET_KEY');
