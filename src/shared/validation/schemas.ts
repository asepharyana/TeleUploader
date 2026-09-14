import { z } from 'zod';

/**
 * Boundary validation schemas (zod) for all system entry points.
 *
 * Every HTTP/S3/bot boundary parses untrusted input through one of these
 * schemas before touching domain logic. Controllers map a failed parse to
 * the transport-appropriate error (400 JSON / S3 XML error) — see
 * `parseOrNull` usage at each call site.
 *
 * @module shared/validation/schemas
 */

/**
 * S3 bucket name — the single canonical validator.
 *
 * Replaces three divergent variants: the inline regex in s3-controller
 * (`handleCreateBucket`), `BUCKET_NAME_REGEX` in
 * `application/use-cases/manage-bucket.ts`, and `isValidBucketLabel` in
 * `interfaces/s3/virtual-host.ts`.
 *
 * Rules: 3–63 chars, lowercase letters/digits/dots/hyphens, start/end with
 * letter-or-digit, plus the stricter M13 rules (no consecutive dots, no IP
 * format, no `xn--` prefix).
 */
export const BucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Bucket name has invalid format')
  .refine((name) => !name.includes('..'), 'Bucket name must not contain consecutive dots')
  .refine(
    (name) => !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name),
    'Bucket name must not be formatted as an IP address',
  )
  .refine((name) => !name.startsWith('xn--'), 'Bucket name must not start with "xn--"');

/** Inferred bucket-name type. */
export type BucketName = z.infer<typeof BucketNameSchema>;

/**
 * JSON upload endpoint body (`POST /api/upload` with
 * `Content-Type: application/json`).
 *
 * Replaces the bare `as JsonUploadPayload` cast in
 * `interfaces/http/controllers/upload-controller.ts`.
 */
export const JsonUploadPayloadSchema = z.object({
  /** Base64-encoded file data, optionally with a `data:` URI prefix. */
  file: z.string().min(1, 'Invalid JSON. Must include "file" (base64) and optional "fileName"'),
  /** Optional file name. */
  fileName: z.string().default('file'),
});

/** Inferred JSON-upload payload type. */
export type JsonUploadPayload = z.infer<typeof JsonUploadPayloadSchema>;

/**
 * Login endpoint body (`POST /api/v1/auth/login`).
 *
 * Replaces the manual `typeof token` check in `readLoginBody`
 * (`interfaces/http/controllers/auth-controller.ts`).
 */
export const LoginBodySchema = z.object({
  /** Admin API token. */
  token: z.string().min(1, 'Token is required'),
});

/** Inferred login-body type. */
export type LoginBody = z.infer<typeof LoginBodySchema>;

/** A single key entry in an S3 DeleteObjects (`?delete`) XML body. */
export const DeleteObjectKeySchema = z.string().min(1);

/**
 * S3 multi-object delete body (`POST /{bucket}?delete`).
 *
 * Validates the *parsed* output of `parseDeleteObjectsBody` (`interfaces/s3/xml.ts`).
 * The regex parser is kept (low-risk), its output is validated here — including
 * the M11 S3 limit of 1000 keys per request.
 */
export const DeleteObjectsBodySchema = z.object({
  /** Object keys to delete. */
  keys: z.array(DeleteObjectKeySchema).max(1000, 'Max 1000 keys per request'),
  /** Quiet mode — return only errors. */
  quiet: z.boolean(),
});

/** Inferred delete-objects body type. */
export type DeleteObjectsBody = z.infer<typeof DeleteObjectsBodySchema>;

/** A single part entry in a CompleteMultipartUpload XML body. */
export const CompletePartSchema = z.object({
  /** 1-based part number (1–10000 per S3 spec). */
  partNumber: z.number().int().min(1).max(10000),
  /** Part ETag as returned by UploadPart (quotes already stripped by the parser). */
  etag: z.string().min(1),
});

/**
 * S3 CompleteMultipartUpload body (`POST /{bucket}/{key}?uploadId=`).
 *
 * Validates the *parsed* output of `parseCompleteMultipartBody`
 * (`interfaces/s3/xml.ts`).
 */
export const CompleteMultipartBodySchema = z.object({
  /** Parts in the order submitted by the client. */
  parts: z.array(CompletePartSchema),
});

/** Inferred complete-multipart body type. */
export type CompleteMultipartBody = z.infer<typeof CompleteMultipartBodySchema>;

/**
 * Shared clamp for paginated S3 listing query params (`max-keys`,
 * `max-uploads`, `max-parts`).
 *
 * Replaces four divergent inline clamps (ListObjectsV1 used `Math.max(1, …)`,
 * V2/ListUploads/ListParts used bare `Math.min(…, 1000)` which admitted 0,
 * negatives and NaN). Garbage input now falls back to the S3 default of 1000.
 *
 * @param raw - Raw query-param value (may be null when absent).
 * @param fallback - Default when the value is missing or invalid (default 1000).
 * @returns An integer in [1, 1000].
 */
export const clampMaxKeys = (raw: string | null, fallback = 1000): number => {
  const parsed = z.coerce.number().int().min(1).max(1000).safeParse(raw);
  if (parsed.success) return parsed.data;
  if (raw === null) return fallback;
  return 1000;
};

/**
 * S3 part number from `?partNumber=` (UploadPart).
 *
 * Mirrors the M14 inline check in `handleUploadPart` (integer 1–10000).
 */
export const PartNumberSchema = z.coerce.number().int().min(1).max(10000);

/**
 * Strictly positive integer coercion for numeric env config (e.g. `PORT`).
 *
 * Unlike the old `parseNumber` fallback in `src/env.ts` (garbage → silent
 * default), invalid values fail so startup fails fast instead of running
 * misconfigured.
 */
export const PositiveIntSchema = z.coerce.number().int().positive();

/**
 * Parses unknown input with a zod schema, returning the typed value or
 * `null` on failure. Use at transport boundaries where the caller maps
 * failure to its own error shape (JSON 400 vs S3 XML error).
 *
 * @param schema - The zod schema to parse with.
 * @param input - Untrusted input.
 * @returns The parsed value, or `null` when invalid.
 */
export const parseOrNull = <T>(schema: z.ZodType<T>, input: unknown): T | null => {
  const result = schema.safeParse(input);
  return result.success ? result.data : null;
};
