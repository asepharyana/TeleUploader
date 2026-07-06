import { describe, expect, it, beforeAll } from 'bun:test';

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
    const result = await verifyPresignedUrl(
      'http://localhost/bucket/key',
      'GET',
      'key',
      'secret',
      'us-east-1',
    );
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('AccessDenied');
  });
});
