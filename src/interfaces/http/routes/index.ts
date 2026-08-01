import { handleSwaggerHtml, handleSwaggerJson } from '../../../routes/swagger';
import { getS3RouteBucket, shouldHandleS3 } from '../../../shared/utils/s3-detection';
import { handleLogin, handleLogout, handleMe } from '../controllers/auth-controller';
import { handleFileInfo, handleFileRedirect } from '../controllers/file-controller';
import { handleHealth } from '../controllers/health-controller';
import { handleHome } from '../controllers/home-controller';
import { handleS3Request } from '../controllers/s3-controller';
import { handleUpload } from '../controllers/upload-controller';
import { handleWebApiV1 } from '../controllers/web-api-controller';
import { requireAuth } from '../middleware/auth';
import { withRateLimit } from '../middleware/rate-limit';

/**
 * Dispatches an S3 request directly, bypassing rate limiting.
 *
 * S3 API calls (used by Docker registry for blob pushes) must not be
 * rate-limited — large concurrent layer uploads would hit the limit and
 * fail. The Docker registry client retries on 5xx, not 4xx, so a 429
 * would abort the entire push.
 *
 * @param req - The incoming S3 request.
 * @returns The S3 response.
 */
const handleS3Direct = (req: Request): Promise<Response> => {
  return handleS3Request(req, getS3RouteBucket(req));
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
      if (shouldHandleS3(req)) return handleS3Direct(req);
      return handleHome();
    },
    PUT: (req: Request): Promise<Response> => {
      const headers = Object.fromEntries(req.headers);
      if (shouldHandleS3(req, headers)) return handleS3Direct(req);
      return Promise.resolve(new Response('Not Allowed', { status: 405 }));
    },
    HEAD: handleS3Direct,
    DELETE: handleS3Direct,
    POST: handleS3Direct,
    OPTIONS: handleS3Direct,
  },
  // Catch-all for S3 path-style requests (/{bucket}/{key} ...)
  // Only intercepts requests with S3 auth headers; others get 404.
  '/*': {
    GET: (req: Request): Promise<Response> => {
      if (shouldHandleS3(req, Object.fromEntries(req.headers))) return handleS3Direct(req);
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    },
    PUT: (req: Request): Promise<Response> => {
      if (shouldHandleS3(req, Object.fromEntries(req.headers))) return handleS3Direct(req);
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    },
    HEAD: (req: Request): Promise<Response> => {
      if (shouldHandleS3(req, Object.fromEntries(req.headers))) return handleS3Direct(req);
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    },
    DELETE: (req: Request): Promise<Response> => {
      if (shouldHandleS3(req, Object.fromEntries(req.headers))) return handleS3Direct(req);
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    },
    POST: (req: Request): Promise<Response> => {
      if (shouldHandleS3(req, Object.fromEntries(req.headers))) return handleS3Direct(req);
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    },
    PATCH: (req: Request): Promise<Response> => {
      if (shouldHandleS3(req, Object.fromEntries(req.headers))) return handleS3Direct(req);
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    },
    OPTIONS: handleS3Direct,
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
  // Read endpoints (GET) are public — anyone can list buckets/objects and
  // download files. Write endpoints (POST/DELETE/PUT) require admin auth so
  // visitors cannot upload, edit, copy, or delete.
  '/api/v1/*': {
    GET: handleWebApiV1,
    POST: requireAuth(handleWebApiV1),
    DELETE: requireAuth(handleWebApiV1),
    PUT: requireAuth(handleWebApiV1),
  },
};
