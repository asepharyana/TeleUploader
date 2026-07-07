import { serve } from 'bun';
import { startBot } from './bot';
import { config } from './env';
import { handleLogin, handleLogout, handleMe } from './routes/auth';
import { handleFileInfo, handleFileRedirect } from './routes/files';
import { handleHealth } from './routes/health';
import { handleHome } from './routes/home';
import { handleS3Request } from './routes/s3';
import { handleSwaggerHtml, handleSwaggerJson } from './routes/swagger';
import { handleUpload } from './routes/upload';
import { handleWebApiV1 } from './routes/web-api';
import { requireAuth } from './utils/auth';
import { fileInfoCache } from './utils/cache';
import logger from './utils/logger';
import { metricsCollector } from './utils/metrics';
import { cleanupRateLimitCache, withRateLimit } from './utils/rateLimit';
import { isS3Request } from './utils/s3/auth';
import { extractS3BucketFromHost } from './utils/s3/virtual-host';

// ─── Auto-run migration at startup ──────────────────────────────────────────
try {
  const { runMigration } = await import('./db/migrate');
  await runMigration();
} catch {
  logger.warn('Auto-migration skipped (non-fatal)');
}

// ─── Auto-run migration at startup ───
try {
  await import('./db/migrate');
} catch {
  // migrate.ts calls process.exit(1) on failure — if it throws, log and continue
  logger.warn('Auto-migration warning (non-fatal)');
}

const getS3RouteBucket = (req: Request): string | null => {
  const host = req.headers.get('host') || '';
  return extractS3BucketFromHost(host, config.s3VhostDomains);
};

const shouldHandleS3 = (req: Request, headers: Record<string, string>): boolean => {
  const url = new URL(req.url);
  return Boolean(
    getS3RouteBucket(req) || isS3Request(headers) || url.searchParams.has('X-Amz-Signature'),
  );
};

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

const server = serve({
  port: config.port,
  routes: {
    '/api/upload': {
      POST: withRateLimit(requireAuth(handleUpload)),
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
      GET: (req: Request) => {
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
  },
  fetch: async (req: Request) => {
    if (req.method === 'OPTIONS') {
      return handleS3Request(req, getS3RouteBucket(req));
    }
    const headers = Object.fromEntries(req.headers);
    if (shouldHandleS3(req, headers)) {
      return handleS3Request(req, getS3RouteBucket(req));
    }
    return new Response('Not Found', { status: 404 });
  },
});

const bot = await startBot();

logger.info('Server started', { port: config.port, url: config.baseUrl });

const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info('Graceful shutdown signal received', { signal });

  logger.info('Closing HTTP server');
  server.stop();

  logger.info('Stopping Telegram bot');
  bot.stop(signal);

  logger.info('Server shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Periodic maintenance intervals
setInterval(cleanupRateLimitCache, 60000);
setInterval(
  () => {
    const removed = fileInfoCache.cleanup();
    if (removed > 0) {
      logger.info(`Cleaned up ${removed} expired cache entries`);
    }
  },
  5 * 60 * 1000,
);
setInterval(
  () => {
    const snapshot = metricsCollector.getSnapshot();
    logger.info('Metrics snapshot', {
      uploadLatency: snapshot.uploadLatency,
      uploadThroughput: snapshot.uploadThroughput.toFixed(2),
      errorRate: snapshot.errorRate.toFixed(2),
      cacheHitRate: snapshot.cacheHitRate.toFixed(2),
    });
  },
  5 * 60 * 1000,
);

logger.info('Application running successfully');
