import { nanoid } from 'nanoid';

export const S3_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, HEAD, DELETE, POST, OPTIONS',
  'access-control-allow-headers': [
    'Authorization',
    'Content-Type',
    'Content-MD5',
    'Range',
    'If-Match',
    'If-None-Match',
    'If-Modified-Since',
    'If-Unmodified-Since',
    'X-Amz-*',
    'x-amz-*',
  ].join(', '),
  'access-control-expose-headers': [
    'Accept-Ranges',
    'Content-Length',
    'Content-Range',
    'Content-Type',
    'ETag',
    'Last-Modified',
    'x-amz-id-2',
    'x-amz-request-id',
  ].join(', '),
  'access-control-max-age': '86400',
};

export const s3Headers = (
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> => ({
  ...S3_CORS_HEADERS,
  server: 'AmazonS3',
  ...(requestId
    ? {
        'x-amz-request-id': requestId,
        'x-amz-id-2': `${requestId}+${nanoid(16)}`,
      }
    : {}),
  ...extraHeaders,
});

export const applyS3Headers = (headers: Headers, requestId: string): Headers => {
  const result = new Headers(headers);
  for (const [key, value] of Object.entries(s3Headers(requestId))) {
    result.set(key, value);
  }
  return result;
};
