import { beforeAll, describe, expect, it } from 'bun:test';

describe('S3 Auth (SigV4)', () => {
  let verifySignature: typeof import('../src/utils/s3/auth').verifySignature;
  let verifyPresignedUrl: typeof import('../src/utils/s3/auth').verifyPresignedUrl;
  let isS3Request: typeof import('../src/utils/s3/auth').isS3Request;

  beforeAll(async () => {
    const auth = await import('../src/utils/s3/auth');
    verifySignature = auth.verifySignature;
    verifyPresignedUrl = auth.verifyPresignedUrl;
    isS3Request = auth.isS3Request;
  });

  it('detects S3 requests by Authorization header', () => {
    expect(isS3Request({ authorization: 'AWS4-HMAC-SHA256 Credential=...' })).toBe(true);
    expect(isS3Request({ authorization: 'Bearer token123' })).toBe(false);
    expect(isS3Request({})).toBe(false);
  });

  it('rejects missing Authorization header', async () => {
    const result = await verifySignature(
      'GET',
      'http://localhost/',
      {},
      null,
      'key',
      'secret',
      'us-east-1',
    );
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('AccessDenied');
  });

  it('rejects wrong access key before signature calculation succeeds', async () => {
    const headers = {
      authorization:
        'AWS4-HMAC-SHA256 Credential=wrongkey/20260706/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=abc123',
      'x-amz-date': '20260706T120000Z',
      host: 'localhost',
    };
    const result = await verifySignature(
      'GET',
      'http://localhost/',
      headers,
      null,
      'correctkey',
      'secret',
      'us-east-1',
    );
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('SignatureDoesNotMatch');
  });

  it('rejects region mismatch in Authorization credential scope', async () => {
    const headers = {
      authorization:
        'AWS4-HMAC-SHA256 Credential=testkey/20260706/eu-west-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc123',
      'x-amz-date': '20260706T120000Z',
      host: 'localhost',
    };
    const result = await verifySignature(
      'GET',
      'http://localhost/',
      headers,
      null,
      'testkey',
      'secret',
      'us-east-1',
    );
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('SignatureDoesNotMatch');
  });

  it('rejects malformed presigned URLs', async () => {
    const result = await verifyPresignedUrl({
      url: 'http://localhost/bucket/key',
      method: 'GET',
      headers: { host: 'localhost' },
      s3AccessKey: 'key',
      s3SecretKey: 'secret',
      region: 'us-east-1',
    });
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('AccessDenied');
  });

  const sha256hex = (data: string): string => {
    const h = new Bun.CryptoHasher('sha256');
    h.update(data);
    return Array.from(h.digest())
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  const hmacSha256 = (key: Uint8Array, msg: string): Uint8Array => {
    const h = new Bun.CryptoHasher('sha256', key);
    h.update(msg);
    return h.digest();
  };

  const signingKey = (secret: string, date: string, region: string): Uint8Array => {
    const enc = (s: string) => new TextEncoder().encode(s);
    let k = hmacSha256(enc(`AWS4${secret}`), date);
    k = hmacSha256(k, region);
    k = hmacSha256(k, 's3');
    return hmacSha256(k, 'aws4_request');
  };

  const hex = (bytes: Uint8Array): string =>
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  it('verifies presigned GET using the public request host', async () => {
    const accessKey = 'filedrop-admin';
    const secret = 'unit-test-secret';
    const host = 'upload.example.test';
    const path = '/bucket/key.txt';
    const amzDate = '20260707T120000Z';
    const dateStamp = '20260707';
    const sp = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${accessKey}/${dateStamp}/us-east-1/s3/aws4_request`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': '3600',
      'X-Amz-SignedHeaders': 'host',
    });
    const canonicalQs = [...sp.entries()]
      .sort(([aKey, aVal], [bKey, bVal]) => `${aKey}=${aVal}`.localeCompare(`${bKey}=${bVal}`))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const canonicalRequest = `GET\n${path}\n${canonicalQs}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
    const hashedCanonical = sha256hex(canonicalRequest);
    const scope = `${dateStamp}/us-east-1/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hashedCanonical}`;
    const sig = hex(hmacSha256(signingKey(secret, dateStamp, 'us-east-1'), stringToSign));
    sp.set('X-Amz-Signature', sig);

    const result = await verifyPresignedUrl({
      url: `https://${host}${path}?${sp.toString()}`,
      method: 'GET',
      headers: { host },
      s3AccessKey: accessKey,
      s3SecretKey: secret,
      region: 'us-east-1',
      now: new Date('2026-07-07T12:05:00Z'),
    });

    expect(result.isValid).toBe(true);
  });

  it('rejects presigned URLs signed for a different host', async () => {
    const result = await verifyPresignedUrl({
      url: 'https://wrong.example.test/bucket/key.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=filedrop-admin%2F20260707%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260707T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=00',
      method: 'GET',
      headers: { host: 'upload.example.test' },
      s3AccessKey: 'filedrop-admin',
      s3SecretKey: 'unit-test-secret',
      region: 'us-east-1',
      now: new Date('2026-07-07T12:05:00Z'),
    });

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('SignatureDoesNotMatch');
  });
});
