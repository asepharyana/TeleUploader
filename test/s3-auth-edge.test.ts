import { describe, expect, it } from 'bun:test';
import { buildCanonicalQueryString, isS3Request, verifyBodyHash } from '../src/interfaces/s3/auth';

/**
 * Edge-case coverage for the exported pure helpers in the SigV4 auth module
 * that the existing s3-auth.test.ts does not exercise directly.
 */
describe('verifyBodyHash (body-integrity check)', () => {
  it('returns null when no x-amz-content-sha256 header is present (unsigned allowed)', () => {
    expect(verifyBodyHash('abc123', {})).toBeNull();
  });

  it('returns null for UNSIGNED-PAYLOAD', () => {
    expect(verifyBodyHash('anything', { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' })).toBeNull();
  });

  it('returns null for STREAMING-* payloads (checked after signature)', () => {
    expect(
      verifyBodyHash('anything', { 'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' }),
    ).toBeNull();
  });

  it('returns BadDigest when the claimed and actual hash differ', () => {
    const result = verifyBodyHash('actual-hash', { 'x-amz-content-sha256': 'claimed-hash' });
    expect(result).not.toBeNull();
    expect(result?.isValid).toBe(false);
    expect(result?.errorCode).toBe('BadDigest');
  });

  it('returns null when the claimed and actual hash match', () => {
    expect(verifyBodyHash('same', { 'x-amz-content-sha256': 'same' })).toBeNull();
  });
});

describe('isS3Request (Auth header detection)', () => {
  it('detects AWS4-HMAC-SHA256 authorization', () => {
    expect(isS3Request({ authorization: 'AWS4-HMAC-SHA256 Credential=...' })).toBe(true);
  });

  it('returns false for bearer/simple auth', () => {
    expect(isS3Request({ authorization: 'Bearer token' })).toBe(false);
  });

  it('returns false when no authorization header', () => {
    expect(isS3Request({})).toBe(false);
  });

  it('is case-sensitive on the AWS4-HMAC-SHA256 scheme prefix', () => {
    expect(isS3Request({ authorization: 'aws4-hmac-sha256 Credential=...' })).toBe(false);
  });
});

describe('buildCanonicalQueryString (SigV4 query canonicalization)', () => {
  it('returns empty string for no params', () => {
    expect(buildCanonicalQueryString(new URLSearchParams())).toBe('');
  });

  it('sorts params by encoded key then value (byte order)', () => {
    const sp = new URLSearchParams('b=2&a=1&c=3');
    expect(buildCanonicalQueryString(sp)).toBe('a=1&b=2&c=3');
  });

  it('sorts by encoded (key=value) pair, not raw key', () => {
    const sp = new URLSearchParams({ 'list-type': '2', prefix: 'x' });
    // 'list-type' (l...) sorts before 'prefix' (p...)
    expect(buildCanonicalQueryString(sp)).toBe('list-type=2&prefix=x');
  });

  it('excludes the X-Amz-Signature key when requested', () => {
    const sp = new URLSearchParams({
      'X-Amz-Signature': 'sig',
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    });
    const result = buildCanonicalQueryString(sp, new Set(['X-Amz-Signature']));
    expect(result).not.toContain('X-Amz-Signature');
    expect(result).toContain('X-Amz-Algorithm');
  });

  it('percent-encodes special characters', () => {
    const sp = new URLSearchParams();
    sp.set('key with space', 'a&b');
    const result = buildCanonicalQueryString(sp);
    // space → %20, & → %26
    expect(result).toContain('%20');
    expect(result).toContain('%26');
  });
});
