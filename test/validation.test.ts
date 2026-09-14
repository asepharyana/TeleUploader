import { describe, expect, it } from 'bun:test';
import {
  BucketNameSchema,
  CompleteMultipartBodySchema,
  clampMaxKeys,
  DeleteObjectsBodySchema,
  JsonUploadPayloadSchema,
  LoginBodySchema,
  parseOrNull,
} from '../src/shared/validation/schemas';

describe('BucketNameSchema (single canonical validator)', () => {
  it('accepts valid bucket names', () => {
    expect(BucketNameSchema.safeParse('gitea').success).toBe(true);
    expect(BucketNameSchema.safeParse('my.bucket-01').success).toBe(true);
  });

  it('rejects invalid names (format, dots, IP, xn--)', () => {
    expect(BucketNameSchema.safeParse('ab').success).toBe(false);
    expect(BucketNameSchema.safeParse('UPPERCASE').success).toBe(false);
    expect(BucketNameSchema.safeParse('a..b').success).toBe(false);
    expect(BucketNameSchema.safeParse('192.168.1.1').success).toBe(false);
    expect(BucketNameSchema.safeParse('xn--bcher-kva').success).toBe(false);
  });
});

describe('JsonUploadPayloadSchema', () => {
  it('accepts file + optional fileName', () => {
    expect(
      JsonUploadPayloadSchema.safeParse({ file: 'aGVsbG8=', fileName: 'hi.txt' }).success,
    ).toBe(true);
  });

  it('defaults fileName and rejects missing/empty file', () => {
    const parsed = JsonUploadPayloadSchema.safeParse({ file: 'aGVsbG8=' });
    expect(parsed.success && parsed.data.fileName).toBe('file');
    expect(JsonUploadPayloadSchema.safeParse({}).success).toBe(false);
    expect(JsonUploadPayloadSchema.safeParse({ file: '' }).success).toBe(false);
  });
});

describe('LoginBodySchema', () => {
  it('accepts a non-empty token and rejects the rest', () => {
    expect(LoginBodySchema.safeParse({ token: 'secret' }).success).toBe(true);
    expect(LoginBodySchema.safeParse({}).success).toBe(false);
    expect(LoginBodySchema.safeParse({ token: '' }).success).toBe(false);
    expect(LoginBodySchema.safeParse({ token: 42 }).success).toBe(false);
  });
});

describe('DeleteObjectsBodySchema', () => {
  it('accepts parsed keys and enforces the 1000-key S3 limit', () => {
    expect(DeleteObjectsBodySchema.safeParse({ keys: ['a', 'b'], quiet: false }).success).toBe(
      true,
    );
    expect(
      DeleteObjectsBodySchema.safeParse({ keys: new Array(1001).fill('k'), quiet: true }).success,
    ).toBe(false);
  });
});

describe('CompleteMultipartBodySchema', () => {
  it('accepts parsed parts and rejects bad part numbers', () => {
    expect(
      CompleteMultipartBodySchema.safeParse({ parts: [{ partNumber: 1, etag: 'abc' }] }).success,
    ).toBe(true);
    expect(
      CompleteMultipartBodySchema.safeParse({ parts: [{ partNumber: 0, etag: 'abc' }] }).success,
    ).toBe(false);
  });
});

describe('clampMaxKeys (unified listing clamp)', () => {
  it('clamps into [1, 1000] and falls back to 1000 on garbage', () => {
    expect(clampMaxKeys(null)).toBe(1000);
    expect(clampMaxKeys('5')).toBe(5);
    expect(clampMaxKeys('99999')).toBe(1000);
    expect(clampMaxKeys('0')).toBe(1000);
    expect(clampMaxKeys('-3')).toBe(1000);
    expect(clampMaxKeys('abc')).toBe(1000);
  });
});

describe('parseOrNull', () => {
  it('returns the value on success and null on failure', () => {
    expect(parseOrNull(LoginBodySchema, { token: 'x' })).toEqual({ token: 'x' });
    expect(parseOrNull(LoginBodySchema, {})).toBeNull();
  });
});
