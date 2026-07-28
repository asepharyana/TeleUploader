import { config } from '../../../config/index';
import { handleLogin, handleLogout, handleMe } from '../controllers/auth-controller';
import { handleFileRedirect, handleFileInfo } from '../controllers/file-controller';
import { handleHealth } from '../controllers/health-controller';
import { handleHome } from '../controllers/home-controller';
import { handleS3Request } from '../controllers/s3-controller';
import { handleSwaggerHtml, handleSwaggerJson } from '../../../routes/swagger';
import { handleUpload } from '../controllers/upload-controller';
import { handleWebApiV1 } from '../controllers/web-api-controller';
import { requireAuth } from '../../../utils/auth';
import { withRateLimit } from '../../../utils/rateLimit';
import { isS3Request } from '../../../utils/s3/auth';
import { extractS3BucketFromHost } from '../../../utils/s3/virtual-host';

/**
 * Extracts the S3 bucket name from the request host
 * if it matches a virtual-hosted-style domain.
 *
 * @param req - The incoming HTTP request.
 * @returns The bucket name if found, or null.
 */
const getS3RouteBucket = (req: Request): string | null => {
  const host = req.headers.get('host') || '';
  return extractS3BucketFromHost(host, config.s3VhostDomains);
};

/**
 * Determines whether the incoming request appears to be an S3 API request
 * based on host headers, authorization headers, or query parameters.
 *
 * @param req - The incoming HTTP request.
 * @param headers - A record of parsed request headers.
 * @returns True if the request should be handled by the S3 handler.
 */
const shouldHandleS3 = (req: Request, headers: Record<string, string>): boolean => {
  const url = new URL(req.url);
  return Boolean(
    getS3RouteBucket(req) || isS3Request(headers) || url.searchParams.has('X-Amz-Signature'),
  );
};

/**
 * Handles non-GET requests to the root path by dispatching to the S3 handler
 * if the request matches S3 patterns (virtual-hosted bucket, S3 auth headers,
 * or presigned URL signature), or returning a 405 Method Not Allowed otherwise.
 *
 * @param req - The incoming HTTP request.
 * @returns A Response from the S3 handler or a 405 response.
 */
const handleMaybeS3Root = (req: Request): Response | Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return handleS3Request(req, getS3RouteBucket(req));
  }
  const headers = Object.fromEntries(req.headers);
  if (shouldHandleS3(req, headers)) {
    return handleS3Request(req, getS3RouteBucket(req));
  }
  return new Response('Not Allowed', { status: 405 });
};

/**
 * Defines all HTTP routes for the application.
 *
 * Each route maps a URL pattern to its corresponding handler function(s),
 * with middleware such as rate limiting and authentication applied where needed.
 * This table is designed to be passed as the `routes` option to `Bun.serve()`.
 *
 * Route patterns follow Bun's routing syntax:
 * - Static paths: `/health`
 * - Parameterized paths: `/f/:public_id`
 * - Wildcard paths: `/api/v1/*`
 */
export const routes = {
  '/api/upload': {
    POST: withRateLimit(handleUpload),
  },
  '/f/:public_id': {
    GET: withRateLimit(handleFileRedirect),
  },
  '/file/:public_id/info': {
    GET: withRateLimit(handleFileInfo),
  },
  '/health': {
    GET: handleHealth,
  },
  '/docs': {
    GET: handleSwaggerHtml,
  },
  '/swagger.json': {
    GET: handleSwaggerJson,
  },
  '/': {
    GET: (req: Request): Promise<Response> => {
      const headers = Object.fromEntries(req.headers);
      if (shouldHandleS3(req, headers)) {
        return handleS3Request(req, getS3RouteBucket(req));
      }
      return handleHome();
    },
    PUT: handleMaybeS3Root,
    HEAD: handleMaybeS3Root,
    DELETE: handleMaybeS3Root,
    POST: handleMaybeS3Root,
    OPTIONS: handleMaybeS3Root,
  },
  '/api/v1/auth/login': {
    POST: withRateLimit(handleLogin),
  },
  '/api/v1/auth/logout': {
    POST: handleLogout,
  },
  '/api/v1/auth/me': {
    GET: handleMe,
  },
  '/api/v1/*': {
    GET: requireAuth(handleWebApiV1),
    POST: requireAuth(handleWebApiV1),
    DELETE: requireAuth(handleWebApiV1),
    PUT: requireAuth(handleWebApiV1),
  },
};
