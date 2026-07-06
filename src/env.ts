import logger from './utils/logger';

interface AppConfig {
  botToken: string;
  additionalBotTokens: string[];
  storageChatId: number;
  baseUrl: string;
  databaseUrl: string;
  port: number;
  nodeEnv: string;
  logLevel: string;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  trustProxy: boolean;
  uploadConcurrency: number;
  batchMaxItems: number;
  batchMaxSizeBytes: number;
  maxRequestBodyBytes: number;
  s3AccessKey: string;
  s3SecretKey: string;
  s3DefaultRegion: string;
  proxyS3Get: boolean;
  s3VhostDomains: string[];
}

const requiredEnv = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  STORAGE_CHANNEL_ID: process.env.STORAGE_CHANNEL_ID,
  BASE_URL: process.env.BASE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  PORT: process.env.PORT,
};

const missing = Object.entries(requiredEnv)
  .filter(([_, value]) => value === undefined || value === '')
  .map(([key]) => key);

if (missing.length > 0) {
  logger.error('Missing required environment variables:', missing);
  throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseTokens = (value: string | undefined): string[] =>
  (value || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');

const parseDomains = (value: string | undefined): string[] =>
  parseTokens(value).map((domain) =>
    domain
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .toLowerCase(),
  );

const maskSecret = (value: string): string => {
  if (!value) return '';
  if (value.length <= 10) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

const maskDatabaseUrl = (value: string): string =>
  value.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');

export const config: AppConfig = {
  botToken: process.env.BOT_TOKEN!,
  additionalBotTokens:
    process.env.NODE_ENV === 'test' ? [] : parseTokens(process.env.ADDITIONAL_BOT_TOKENS),
  storageChatId: parseInt(process.env.STORAGE_CHANNEL_ID!, 10),
  baseUrl: process.env.BASE_URL!,
  databaseUrl: process.env.DATABASE_URL!,
  port: parseInt(process.env.PORT!, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  rateLimitWindowMs: parseNumber(process.env.RATE_LIMIT_WINDOW_MS, 60000),
  rateLimitMaxRequests: parseNumber(process.env.RATE_LIMIT_MAX_REQUESTS, 150),
  trustProxy: process.env.TRUST_PROXY === 'true',
  uploadConcurrency: parseNumber(process.env.UPLOAD_CONCURRENCY, 8),
  batchMaxItems: parseNumber(process.env.BATCH_MAX_ITEMS, 20),
  batchMaxSizeBytes: parseNumber(process.env.BATCH_MAX_SIZE_BYTES, 500 * 1024 * 1024),
  maxRequestBodyBytes: parseNumber(process.env.MAX_REQUEST_BODY_BYTES, 2 * 1024 * 1024 * 1024),
  s3AccessKey: process.env.S3_ACCESS_KEY || 'teleuploader-admin',
  s3SecretKey: process.env.S3_SECRET_KEY || '',
  s3DefaultRegion: process.env.S3_DEFAULT_REGION || 'us-east-1',
  proxyS3Get: process.env.PROXY_S3_GET !== 'false',
  s3VhostDomains: parseDomains(
    process.env.S3_VHOST_DOMAINS ||
      'upload.asepharyana.my.id,asepharyana.web.id,upload.asepharyana.web.id',
  ),
};

logger.info('Environment variables loaded', {
  config: {
    ...config,
    botToken: maskSecret(config.botToken),
    additionalBotTokens: config.additionalBotTokens.map(maskSecret),
    databaseUrl: maskDatabaseUrl(config.databaseUrl),
    s3AccessKey: maskSecret(config.s3AccessKey),
    s3SecretKey: maskSecret(config.s3SecretKey),
  },
});
