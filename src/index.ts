import { serve } from 'bun';
import { startBot } from './bot';
import { config } from './env';
import { handleFileInfo, handleFileRedirect } from './routes/files';
import { handleHealth } from './routes/health';
import { handleSwaggerHtml, handleSwaggerJson } from './routes/swagger';
import { handleUpload } from './routes/upload';
import { fileInfoCache } from './utils/cache';
import logger from './utils/logger';
import { metricsCollector } from './utils/metrics';
import { cleanupRateLimitCache, withRateLimit } from './utils/rateLimit';

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
