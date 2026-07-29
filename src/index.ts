import { serve } from 'bun';
import { config } from './env';
import { fileInfoCache } from './infrastructure/cache/index';
import { startBot } from './interfaces/bot/handler';
import { handleS3Request } from './interfaces/http/controllers/s3-controller';
import { cleanupRateLimitCache } from './interfaces/http/middleware/rate-limit';
import { routes } from './interfaces/http/routes/index';
import { isS3Request } from './interfaces/s3/auth';
import { extractS3BucketFromHost } from './interfaces/s3/virtual-host';
import { logger } from './shared/logger/index';
import { metricsCollector } from './shared/metrics/index';

// ─── Auto-run migration at startup ──────────────────────────────────────────
try {
  const { runMigration } = await import('./infrastructure/persistence/drizzle/migrate');
  await runMigration();
} catch {
  logger.warn('Auto-migration skipped (non-fatal)');
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

const _handleMaybeS3Root = (req: Request): Response | Promise<Response> => {
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
  routes,
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

  logger.info('Closing HTTP server — no new requests accepted');
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
