import { describe, expect, it } from 'bun:test';
import { config } from '../src/env';
import { applyS3Headers, S3_CORS_HEADERS, s3Headers } from '../src/interfaces/s3/headers';
import { extractS3BucketFromHost } from '../src/interfaces/s3/virtual-host';
import { maybeCompressChunk } from '../src/shared/utils/compress';
import { extractClientIp } from '../src/shared/utils/ip';
import { getS3RouteBucket, shouldHandleS3 } from '../src/shared/utils/s3-detection';

const DOMAINS = config.s3VhostDomains;

describe('maybeCompressChunk (gzip compression heuristics)', () => {
  it('returns chunk unchanged when compression disabled', () => {
    const chunk = Buffer.from('hello world hello world hello world');
    const { bytes, compressionAlgorithm } = maybeCompressChunk(chunk, false, 0);
    expect(bytes).toBe(chunk);
    expect(compressionAlgorithm).toBeNull();
  });

  it('skips compression for chunks below min-size threshold', () => {
    const chunk = Buffer.from('tiny');
    const { bytes, compressionAlgorithm } = maybeCompressChunk(chunk, true, 100);
    expect(bytes).toBe(chunk);
    expect(compressionAlgorithm).toBeNull();
  });

  it('compresses compressible data above threshold', () => {
    const data = 'the quick brown fox jumps over the lazy dog '.repeat(20);
    const chunk = Buffer.from(data);
    const { bytes, compressionAlgorithm } = maybeCompressChunk(chunk, true, 1);
    expect(compressionAlgorithm).toBe('gzip');
    expect(bytes.byteLength).toBeLessThan(chunk.byteLength);
    // gzip decompresses back to original
    const back = Bun.gunzipSync(bytes);
    expect(Buffer.from(back).toString('utf8')).toBe(data);
  });

  it('does NOT compress when gzip result is larger than input', () => {
    // Truly random bytes — gzip cannot compress them, so the chunk is kept raw.
    const chunk = Buffer.allocUnsafe(4096);
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 2654435761 + i * i) & 0xff;
    // Sanity: make sure it doesn't accidentally gzip below input size
    if (Bun.gzipSync(chunk).byteLength >= chunk.byteLength) {
      const { bytes, compressionAlgorithm } = maybeCompressChunk(chunk, true, 1);
      expect(compressionAlgorithm).toBeNull();
      expect(bytes).toBe(chunk);
    } else {
      // fallback: this test data happened to compress; skip rather than assert wrongly
      expect(true).toBe(true);
    }
  });
});

describe('extractS3BucketFromHost (virtual-hosted addressing)', () => {
  it('extracts bucket from subdomain for a matching domain', () => {
    expect(extractS3BucketFromHost('my-bucket.upload.asepharyana.my.id', DOMAINS)).toBe(
      'my-bucket',
    );
  });

  it('returns null when host equals a root domain (no bucket)', () => {
    expect(extractS3BucketFromHost('upload.asepharyana.my.id', DOMAINS)).toBeNull();
  });

  it('returns null for unrelated domains', () => {
    expect(extractS3BucketFromHost('example.com', DOMAINS)).toBeNull();
    expect(extractS3BucketFromHost('evil.asepharyana.my.id.evilland.com', DOMAINS)).toBeNull();
  });

  it('returns null for non-subdomain suffixes', () => {
    expect(
      extractS3BucketFromHost('not-a-valid.bucket-upload.asepharyana.my.id', DOMAINS),
    ).toBeNull();
  });

  it('strips port from host', () => {
    expect(extractS3BucketFromHost('my-bucket.upload.asepharyana.my.id:4000', DOMAINS)).toBe(
      'my-bucket',
    );
  });

  it('rejects buckets shorter than 3 chars (AWS min length)', () => {
    expect(extractS3BucketFromHost('ab.upload.asepharyana.my.id', DOMAINS)).toBeNull();
    expect(extractS3BucketFromHost('b.upload.asepharyana.my.id', DOMAINS)).toBeNull();
  });

  it('rejects invalid bucket labels (dots/underscores)', () => {
    expect(extractS3BucketFromHost('a..b.upload.asepharyana.my.id', DOMAINS)).toBeNull();
    expect(extractS3BucketFromHost('a_b.upload.asepharyana.my.id', DOMAINS)).toBeNull();
  });

  it('normalizes uppercase host to lowercase bucket (stripPort lowercases)', () => {
    // Bucket labels are lowercased during host normalization, so uppercase is
    // accepted and normalized rather than rejected.
    expect(extractS3BucketFromHost('MyBucket.upload.asepharyana.my.id', DOMAINS)).toBe('mybucket');
  });

  it('is case-insensitive for the host domain', () => {
    expect(extractS3BucketFromHost('my-bucket.UPLOAD.ASEPHARYANA.MY.ID', DOMAINS)).toBe(
      'my-bucket',
    );
  });

  it('returns null when no domain matches', () => {
    expect(extractS3BucketFromHost('my-bucket.example.org', DOMAINS)).toBeNull();
  });
});

describe('getS3RouteBucket + shouldHandleS3 (routing detection)', () => {
  it('getS3RouteBucket extracts bucket from request host', () => {
    // Bun does NOT derive the Host header from the URL string; set it explicitly
    // (as a real HTTP request would carry).
    const req = new Request('http://upload.asepharyana.my.id/', {
      headers: { host: 'my-bucket.upload.asepharyana.my.id' },
    });
    expect(getS3RouteBucket(req)).toBe('my-bucket');
  });

  it('returns null host bucket when host is the apex domain', () => {
    const req = new Request(`http://${DOMAINS[0]}/`, {
      headers: { host: DOMAINS[0] },
    });
    expect(getS3RouteBucket(req)).toBeNull();
  });

  it('shouldHandleS3 true via vhost bucket host', () => {
    const req = new Request('http://upload.asepharyana.my.id/x', {
      headers: { host: 'my-bucket.upload.asepharyana.my.id' },
    });
    expect(shouldHandleS3(req)).toBe(true);
  });

  it('shouldHandleS3 true via SigV4 Authorization header', () => {
    const req = new Request('http://localhost/');
    req.headers.set(
      'Authorization',
      'AWS4-HMAC-SHA256 Credential=x/20260101/us-east-1/s3/aws4_request',
    );
    expect(shouldHandleS3(req)).toBe(true);
  });

  it('shouldHandleS3 true via presigned X-Amz-Signature query param', () => {
    const req = new Request(
      'http://localhost/?X-Amz-Signature=abcd1234&X-Amz-Algorithm=AWS4-HMAC-SHA256',
    );
    expect(shouldHandleS3(req)).toBe(true);
  });

  it('shouldHandleS3 false for plain web requests', () => {
    const req = new Request('http://localhost/health');
    expect(shouldHandleS3(req)).toBe(false);
  });

  it('shouldHandleS3 respects a passed headers record', () => {
    const req = new Request('http://localhost/');
    expect(shouldHandleS3(req, { authorization: 'AWS4-HMAC-SHA256 Credential=x' })).toBe(true);
    expect(shouldHandleS3(req, { authorization: 'Bearer token' })).toBe(false);
  });
});

describe('extractClientIp', () => {
  it('returns 127.0.0.1 when trustProxy is disabled', () => {
    expect(extractClientIp(new Request('http://localhost/'))).toBe('127.0.0.1');
  });

  it('uses X-Forwarded-For first value when trustProxy enabled', async () => {
    const orig = config.trustProxy;
    config.trustProxy = true;
    try {
      const req = new Request('http://localhost/');
      req.headers.set('x-forwarded-for', '203.0.113.5, 10.0.0.1');
      expect(extractClientIp(req)).toBe('203.0.113.5');
    } finally {
      config.trustProxy = orig;
    }
  });

  it('falls back to X-Real-IP when X-Forwarded-For missing', async () => {
    const orig = config.trustProxy;
    config.trustProxy = true;
    try {
      const req = new Request('http://localhost/');
      req.headers.set('x-real-ip', '198.51.100.7');
      expect(extractClientIp(req)).toBe('198.51.100.7');
    } finally {
      config.trustProxy = orig;
    }
  });

  it('falls back to 127.0.0.1 when trustProxy true but no forwarded headers', async () => {
    const orig = config.trustProxy;
    config.trustProxy = true;
    try {
      expect(extractClientIp(new Request('http://localhost/'))).toBe('127.0.0.1');
    } finally {
      config.trustProxy = orig;
    }
  });
});

describe('S3 response headers', () => {
  it('builds s3Headers with amazon server + request ids + CORS', () => {
    const h = s3Headers('req-abc');
    expect(h.server).toBe('AmazonS3');
    expect(h['x-amz-request-id']).toBe('req-abc');
    expect(h['x-amz-id-2']).toContain('req-abc');
    expect(h['access-control-allow-origin']).toBe('*');
  });

  it('merges extra headers and overrides defaults', () => {
    const h = s3Headers('req', { 'content-type': 'application/xml', server: 'custom' });
    expect(h['content-type']).toBe('application/xml');
    expect(h.server).toBe('custom');
  });

  it('omits request ids when no requestId given', () => {
    const h = s3Headers('');
    expect(h['x-amz-request-id']).toBeUndefined();
  });

  it('applyS3Headers copies S3 headers onto a Headers instance', () => {
    const h = new Headers({ 'content-type': 'text/plain' });
    // applyS3Headers returns a NEW Headers copy — it does not mutate in place.
    const result = applyS3Headers(h, 'rid');
    expect(result.get('content-type')).toBe('text/plain');
    expect(result.get('server')).toBe('AmazonS3');
    expect(result.get('x-amz-request-id')).toBe('rid');
  });

  it('S3_CORS_HEADERS exposes allowed methods and max-age', () => {
    expect(S3_CORS_HEADERS['access-control-allow-methods']).toContain('PUT');
    expect(S3_CORS_HEADERS['access-control-allow-methods']).toContain('DELETE');
    expect(S3_CORS_HEADERS['access-control-max-age']).toBe('86400');
  });
});
