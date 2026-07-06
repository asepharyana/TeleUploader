import { serve } from 'bun';
import { startBot } from './bot';
import { config } from './env';
import { handleFileInfo, handleFileRedirect } from './routes/files';
import { handleHealth } from './routes/health';
import { handleSwaggerHtml, handleSwaggerJson } from './routes/swagger';
import { handleUpload } from './routes/upload';
import { handleHome } from './routes/home';
import { handleWebApiV1 } from './routes/web-api';
import { handleS3Request } from './routes/s3';
import { isS3Request } from './utils/s3/auth';
import { fileInfoCache } from './utils/cache';
import logger from './utils/logger';
import { metricsCollector } from './utils/metrics';
import { cleanupRateLimitCache, withRateLimit } from './utils/rateLimit';

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

const server = serve({
  port: config.port,
  routes: {
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
      GET: (req: Request) => {
        const headers = Object.fromEntries(req.headers);
        const url = new URL(req.url);
        if (isS3Request(headers) || url.searchParams.has('X-Amz-Signature')) {
          return handleS3Request(req);
        }
        return handleHome();
      },
      PUT: (req: Request) => {
        const headers = Object.fromEntries(req.headers);
        if (isS3Request(headers)) {
          return handleS3Request(req);
        }
        return new Response('Not Allowed', { status: 405 });
      },
      HEAD: (req: Request) => {
        const headers = Object.fromEntries(req.headers);
        if (isS3Request(headers)) {
          return handleS3Request(req);
        }
        return new Response('Not Allowed', { status: 405 });
      },
      DELETE: (req: Request) => {
        const headers = Object.fromEntries(req.headers);
        if (isS3Request(headers)) {
          return handleS3Request(req);
        }
        return new Response('Not Allowed', { status: 405 });
      },
      POST: (req: Request) => {
        const headers = Object.fromEntries(req.headers);
        if (isS3Request(headers)) {
          return handleS3Request(req);
        }
        return new Response('Not Allowed', { status: 405 });
      },
    },
    '/api/v1/*': {
      GET: handleWebApiV1,
      POST: handleWebApiV1,
      DELETE: handleWebApiV1,
      PUT: handleWebApiV1,
    },
  },
  fetch: async (req: Request) => {
    const headers = Object.fromEntries(req.headers);
    if (isS3Request(headers) || new URL(req.url).searchParams.has('X-Amz-Signature')) {
      return handleS3Request(req);
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
