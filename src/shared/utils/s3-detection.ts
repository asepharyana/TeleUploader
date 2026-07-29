import { config } from '../../env';
import { isS3Request } from '../../interfaces/s3/auth';
import { extractS3BucketFromHost } from '../../interfaces/s3/virtual-host';

/**
 * Extracts the S3 bucket name from the request host
 * if it matches a virtual-hosted-style domain.
 *
 * @param req - The incoming HTTP request.
 * @returns The bucket name if found, or null.
 */
export const getS3RouteBucket = (req: Request): string | null => {
  const host = req.headers.get('host') || '';
  return extractS3BucketFromHost(host, config.s3VhostDomains);
};

/**
 * Determines whether the incoming request appears to be an S3 API request
 * based on host headers, authorization headers, or query parameters.
 *
 * @param req - The incoming HTTP request.
 * @param headers - A record of parsed request headers (optional — derived from req if omitted).
 * @returns True if the request should be handled by the S3 handler.
 */
export const shouldHandleS3 = (req: Request, headers?: Record<string, string>): boolean => {
  const resolvedHeaders = headers ?? Object.fromEntries(req.headers);
  const url = new URL(req.url);
  return Boolean(
    getS3RouteBucket(req) ||
      isS3Request(resolvedHeaders) ||
      url.searchParams.has('X-Amz-Signature'),
  );
};
