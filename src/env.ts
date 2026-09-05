import logger from './shared/logger/index';
import { TELEGRAM_CHUNK_SIZE_MAX_BYTES } from './shared/utils/validation';

interface AppConfig {
  /** Application version (read from package.json, kept in sync by semantic-release prepare.mjs) */
  appVersion: string;
  /** All bot tokens merged from BOT_TOKENS (or BOT_TOKEN + ADDITIONAL_BOT_TOKENS fallback) */
  botTokens: string[];
  /** Per-bot concurrency for Telegram API calls (default 1). */
  telegramBotConcurrency: number;
  storageChatId: number;
  baseUrl: string;
  databaseUrl: string;
  port: number;
  nodeEnv: string;
  logLevel: string;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  trustProxy: boolean;
  batchMaxItems: number;
  batchMaxSizeBytes: number;
  maxRequestBodyBytes: number;
  telegramChunkSizeBytes: number;
  compressChunkedUploads: boolean;
  chunkCompressionMinSizeBytes: number;
  adminApiToken: string;
  sessionCookieName: string;
  sessionMaxAgeMs: number;
  s3AccessKey: string;
  s3SecretKey: string;
  s3DefaultRegion: string;
  proxyS3Get: boolean;
  s3VhostDomains: string[];
}

// Validate bot tokens: BOT_TOKENS (new) or fallback to BOT_TOKEN + ADDITIONAL_BOT_TOKENS
const botTokensRaw =
  process.env.BOT_TOKENS ||
  [process.env.BOT_TOKEN, process.env.ADDITIONAL_BOT_TOKENS].filter(Boolean).join(',');

if (!botTokensRaw) {
  logger.error(
    'Missing required environment variables: BOT_TOKENS (or BOT_TOKEN + ADDITIONAL_BOT_TOKENS)',
  );
  throw new Error(
    'Missing environment variables: BOT_TOKENS (or BOT_TOKEN + ADDITIONAL_BOT_TOKENS)',
  );
}

const requiredEnv = {
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

// Validate S3 credentials: if S3_ACCESS_KEY is explicitly set (env var present,
// not relying on default), S3_SECRET_KEY must also be set. An empty secret key
// would cause HMAC-SHA256 to "succeed" silently — a security hole.
const s3AccessKeyExplicit = 'S3_ACCESS_KEY' in process.env;
const s3SecretKeyExplicit = 'S3_SECRET_KEY' in process.env;
if (s3AccessKeyExplicit || s3SecretKeyExplicit) {
  const s3Key = (process.env.S3_ACCESS_KEY || '').trim();
  const s3Secret = (process.env.S3_SECRET_KEY || '').trim();
  if (s3Key && !s3Secret) {
    logger.error('S3_ACCESS_KEY is set but S3_SECRET_KEY is empty — this is a security risk');
    throw new Error(
      'S3_ACCESS_KEY requires S3_SECRET_KEY to be set. Set S3_SECRET_KEY or unset S3_ACCESS_KEY.',
    );
  }
  if (s3Secret && !s3Key) {
    logger.warn('S3_SECRET_KEY is set but S3_ACCESS_KEY is not — S3 auth will use the default key');
  }
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

// Fail-fast guard for TELEGRAM_CHUNK_SIZE_BYTES: chunked uploads store every
// part as a Telegram document and later resolve it via getFile, which only
// supports files up to 20 MB ("Bad Request: file is too big" above that).
// A chunk above the limit makes every part undownloadable — refuse to start
// instead of failing on the first large-file download.
const telegramChunkSizeBytes = parseNumber(
  process.env.TELEGRAM_CHUNK_SIZE_BYTES,
  TELEGRAM_CHUNK_SIZE_MAX_BYTES,
);
if (telegramChunkSizeBytes > TELEGRAM_CHUNK_SIZE_MAX_BYTES) {
  logger.error(
    `TELEGRAM_CHUNK_SIZE_BYTES=${telegramChunkSizeBytes} exceeds the maximum allowed chunk size ` +
      `${TELEGRAM_CHUNK_SIZE_MAX_BYTES} bytes (${TELEGRAM_CHUNK_SIZE_MAX_BYTES / (1024 * 1024)} MB). ` +
      'Telegram Bot API getFile cannot download files larger than 20 MB, so every stored part would ' +
      'be undownloadable ("Bad Request: file is too big"). ' +
      `Set TELEGRAM_CHUNK_SIZE_BYTES to ${TELEGRAM_CHUNK_SIZE_MAX_BYTES} or lower.`,
  );
  throw new Error(
    `TELEGRAM_CHUNK_SIZE_BYTES=${telegramChunkSizeBytes} exceeds the maximum allowed chunk size ` +
      `${TELEGRAM_CHUNK_SIZE_MAX_BYTES} bytes (${TELEGRAM_CHUNK_SIZE_MAX_BYTES / (1024 * 1024)} MB)`,
  );
}

/**
 * Reads the application version from package.json.
 *
 * Prefers the resolved node_modules/teleuploader package version (set by
 * semantic-release when the repo is installed as a published artifact) and
 * falls back to reading the repo's own package.json when running from a
 * checkout. Both files are updated by prepare.mjs on every release, so the
 * value always matches the deployed build.
 */
const readPackageVersion = (): string => {
  try {
    const candidates = [
      // node_modules resolution is only available when installed as a dep
      import.meta.dir ? `${import.meta.dir}/../package.json` : undefined,
      `${process.cwd()}/package.json`,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const pkg = JSON.parse(import.meta.require(candidate).default ?? '{}') as {
          version?: string;
        };
        if (pkg.version) return pkg.version;
      } catch {
        // try next candidate
      }
    }
  } catch {
    // fall through
  }
  return '0.0.0';
};

export const config: AppConfig = {
  appVersion: readPackageVersion(),
  botTokens: parseTokens(botTokensRaw),
  telegramBotConcurrency: parseNumber(process.env.TELEGRAM_BOT_CONCURRENCY, 1),
  storageChatId: parseInt(process.env.STORAGE_CHANNEL_ID!, 10),
  baseUrl: process.env.BASE_URL!,
  databaseUrl: process.env.DATABASE_URL!,
  port: parseInt(process.env.PORT!, 10) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  rateLimitWindowMs: parseNumber(process.env.RATE_LIMIT_WINDOW_MS, 60000),
  rateLimitMaxRequests: parseNumber(process.env.RATE_LIMIT_MAX_REQUESTS, 150),
  trustProxy: process.env.TRUST_PROXY === 'true',
  batchMaxItems: parseNumber(process.env.BATCH_MAX_ITEMS, 20),
  batchMaxSizeBytes: parseNumber(process.env.BATCH_MAX_SIZE_BYTES, 500 * 1024 * 1024),
  maxRequestBodyBytes: parseNumber(process.env.MAX_REQUEST_BODY_BYTES, 2 * 1024 * 1024 * 1024),
  telegramChunkSizeBytes,
  compressChunkedUploads: process.env.COMPRESS_CHUNKED_UPLOADS !== 'false',
  chunkCompressionMinSizeBytes: parseNumber(process.env.CHUNK_COMPRESSION_MIN_SIZE_BYTES, 4096),
  adminApiToken: process.env.ADMIN_API_TOKEN || '',
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'tu_session',
  sessionMaxAgeMs: parseNumber(process.env.SESSION_COOKIE_MAX_AGE_SECONDS, 86400) * 1000,
  s3AccessKey: process.env.S3_ACCESS_KEY || 'filedrop-admin',
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
    botTokens: config.botTokens.map(maskSecret),
    databaseUrl: maskDatabaseUrl(config.databaseUrl),
    adminApiToken: maskSecret(config.adminApiToken),
    adminApiTokenEnabled: config.adminApiToken.length > 0,
    s3AccessKey: maskSecret(config.s3AccessKey),
    s3SecretKey: maskSecret(config.s3SecretKey),
  },
});
