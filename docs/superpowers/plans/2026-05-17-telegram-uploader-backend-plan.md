# Telegram Bot Uploader Backend Implementation Plan

> ⚠️ **LEGACY** — Dokumen historis (2026-05-17). Port & infrastruktur sudah berubah:
> produksi kini berjalan di port `4000` (Nix + systemd + Caddy, domain `upload.asepharyana.my.id`)
> dan database via PgBouncer pool `100.121.180.82:6432` (bukan port 5432, bukan localhost).


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-ready backend for Telegram file uploader with dual upload methods (bot + HTTP API), PostgreSQL storage, and redirect-based downloads.

**Architecture:** Bun.serve HTTP server + Telegraf bot + Drizzle ORM, running simultaneously with in-memory rate limiting and graceful shutdown.

**Tech Stack:** Bun runtime, Telegraf, PostgreSQL, Drizzle ORM, Winston, nanoid, ESM JavaScript

---

## File Structure

```
src/
  index.js           — entry point, start server & bot, graceful shutdown
  bot.js             — Telegraf bot setup, file handlers, forward to channel
  env.js             — validate bot_token, storage_channel_id, base_url, database_url, port
  db/
    index.js         — Drizzle setup, connection pool
    schema.js        — Drizzle schema definition for files table
  routes/
    files.js         — GET /f/:public_id, GET /file/:public_id/info
    upload.js        — POST /api/upload (multipart & base64)
    health.js        — GET /health
  utils/
    file.js          — file type validation, size checks against Telegram limits
    telegram.js      — forward to channel, getFile API calls
    logger.js        — Winston logger setup
    rateLimit.js     — in-memory rate limiter (30 req/min per IP)
package.json
.env.example
schema.sql
  README.md          — setup instructions, deploy guide
```

---

## Task 1: Setup Dependencies and Configuration

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `schema.sql`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "teleuploader",
  "version": "1.0.0",
  "description": "Telegram file uploader backend",
  "type": "module",
  "scripts": {
    "dev": "bun --hot index.js",
    "start": "NODE_ENV=production bun index.js",
    "db:migrate": "psql $DATABASE_URL -f schema.sql"
  },
  "dependencies": {
    "drizzle-orm": "^0.29.0",
    "telegraf": "^4.15.0",
    "winston": "^3.11.0",
    "nanoid": "^5.0.4",
    "@prisma/engines": "npm:prisma@5.8.0-standalone"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Create .env.example**

```bash
BOT_TOKEN=isi_token_bot_telegram
STORAGE_CHANNEL_ID=-1001234567890
BASE_URL=https://upload.asepharyana.my.id
DATABASE_URL=postgresql://asephs:***@100.121.180.82:6432/uploader
PORT=4000
NODE_ENV=production
LOG_LEVEL=info
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=30
```

- [ ] **Step 3: Create schema.sql**

```sql
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id VARCHAR(21) UNIQUE NOT NULL,
  telegram_file_id VARCHAR NOT NULL,
  telegram_file_unique_id VARCHAR NOT NULL,
  storage_chat_id BIGINT NOT NULL,
  storage_message_id BIGINT NOT NULL,
  file_name VARCHAR NOT NULL,
  mime_type VARCHAR NOT NULL,
  size_bytes BIGINT NOT NULL,
  file_type VARCHAR NOT NULL,
  uploader_id BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_files_public_id ON files(public_id);
CREATE INDEX idx_files_telegram_file_id ON files(telegram_file_id);
CREATE INDEX idx_files_uploader_id ON files(uploader_id);
CREATE INDEX idx_files_created_at ON files(created_at DESC);
```

- [ ] **Step 4: Create README.md**

```markdown
# Telegram Bot Uploader Backend

Backend production-ready untuk upload file ke Telegram yang tersimpan di private channel.

## Setup

1. Install PostgreSQL database
2. Buat database: `createdb telegram_uploader`
3. Setup environment: `cp .env.example .env`
4. Edit `.env` dengan nilai yang sesuai
5. Create table: `bun run db:migrate`
6. Install dependencies: `bun install`

## Telegram Private Channel Setup

1. Buat private channel Telegram
2. Tambah bot sebagai admin di channel
3. Dapatkan `STORAGE_CHANNEL_ID` (misalnya -1001234567890)

## Running

```bash
bun run dev      # Development mode
bun run start    # Production mode
```

## API Endpoints

- `POST /api/upload` - Upload file
- `GET /f/:public_id` - Download redirect
- `GET /file/:public_id/info` - File metadata
- `GET /health` - Health check

## FAQ

**URL permanen maksudnya apa?**
URL backend tetap permanen: `https://upload.asepharyana.my.id/f/{public_id}`
Ini berarti URL service Anda fix, bukan jaminan file Telegram abadi.

## Testing

Gunakan bot Telegram untuk upload, atau upload API langsung via HTTP.
```

- [ ] **Step 5: Commit**

```bash
git add package.json .env.example schema.sql README.md
git commit -m "chore: add dependencies and configuration"
```

---

## Task 2: Setup Winston Logger

**Files:**
- Create: `src/utils/logger.js`

- [ ] **Step 1: Create logger.js**

```javascript
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'teleuploader' },
  transports: [
    // Write all logs including error logs to file
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

// If not production, also log to console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

export default logger;
```

- [ ] **Step 2: Create logs directory**

```bash
mkdir -p logs
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/logger.js logs
git commit -m "feat: add Winston logger setup"
```

---

## Task 3: Setup Environment Variables Validation

**Files:**
- Create: `src/env.js`

- [ ] **Step 1: Create env.js**

```javascript
import logger from './utils/logger.js';

const requiredEnv = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  STORAGE_CHANNEL_ID: process.env.STORAGE_CHANNEL_ID,
  BASE_URL: process.env.BASE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  PORT: process.env.PORT
};

const missing = Object.entries(requiredEnv)
  .filter(([_, value]) => value === undefined || value === '')
  .map(([key]) => key);

if (missing.length > 0) {
  logger.error('Missing required environment variables:', missing);
  throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

export const config = {
  botToken: process.env.BOT_TOKEN,
  storageChatId: parseInt(process.env.STORAGE_CHANNEL_ID, 10),
  baseUrl: process.env.BASE_URL,
  databaseUrl: process.env.DATABASE_URL,
  port: parseInt(process.env.PORT, 10) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 30
};

logger.info('Environment variables loaded', { config: { ...config, botToken: config.botToken?.substring(0, 10) + '...' } });
```

- [ ] **Step 2: Commit**

```bash
git add src/env.js
git commit -m "feat: add environment variables validation"
```

---

## Task 4: Setup Drizzle ORM Database Layer

**Files:**
- Create: `src/db/index.js`
- Create: `src/db/schema.js`

- [ ] **Step 1: Install Drizzle dependencies**

```bash
bun install drizzle-orm @prisma/engines
bun install -D drizzle-kit
```

- [ ] **Step 2: Create schema.js**

```javascript
import { sqliteTable, text, bigint, timestamp } from 'drizzle-orm/pg-core';

export const files = sqliteTable('files', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  publicId: text('public_id').unique().notNull(),
  telegramFileId: text('telegram_file_id').notNull(),
  telegramFileUniqueId: text('telegram_file_unique_id').notNull(),
  storageChatId: bigint('storage_chat_id', { mode: 'number' }).notNull(),
  storageMessageId: bigint('storage_message_id', { mode: 'number' }).notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  fileType: text('file_type').notNull(),
  uploaderId: bigint('uploader_id', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
```

- [ ] **Step 3: Create index.js**

```javascript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import logger from '../utils/logger.js';
import { files } from './schema.js';

const client = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10
});

export const db = drizzle(client, { schema: { files } });
export { files };
export default db;
```

- [ ] **Step 4: Commit**

```bash
git add src/db/index.js src/db/schema.js
git commit -m "feat: add Drizzle ORM database layer"
```

---

## Task 5: Setup Rate Limiter

**Files:**
- Create: `src/utils/rateLimit.js`

- [ ] **Step 1: Create rateLimit.js**

```javascript
import logger from './logger.js';

const rateLimitMap = new Map();

export const checkRateLimit = (key) => {
  const now = Date.now();
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000;
  const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 30;

  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, { count: 0, reset: now + windowMs });
  }

  const record = rateLimitMap.get(key);

  if (now > record.reset) {
    record.count = 0;
    record.reset = now + windowMs;
  }

  if (record.count >= maxRequests) {
    logger.warn('Rate limit exceeded', { key, count: record.count, reset: record.reset });
    return false;
  }

  record.count++;
  return true;
};

export const cleanupRateLimitCache = () => {
  const now = Date.now();
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000;
  const keysToDelete = [];

  for (const [key, record] of rateLimitMap.entries()) {
    if (now > record.reset) {
      keysToDelete.push(key);
    }
  }

  keysToDelete.forEach(key => rateLimitMap.delete(key));
};
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/rateLimit.js
git commit -m "feat: add in-memory rate limiter"
```

---

## Task 6: Setup File Utility Functions

**Files:**
- Create: `src/utils/file.js`

- [ ] **Step 1: Create file.js**

```javascript
import logger from './logger.js';

const FILE_TYPES = {
  document: 2 * 1024 * 1024 * 1024, // 2GB
  photo: 10 * 1024 * 1024, // 10MB
  video: 2 * 1024 * 1024 * 1024, // 2GB
  audio: 200 * 1024 * 1024, // 200MB
  voice: 200 * 1024 * 1024, // 200MB
  animation: 2 * 1024 * 1024 * 1024 // 2GB
};

export const getFileType = (mime, caption) => {
  const mimeUpper = mime?.split('/')[0]?.toLowerCase();
  const captionLower = caption?.toLowerCase();

  if (mimeUpper === 'video') return 'video';
  if (mimeUpper === 'audio') return 'audio';
  if (mimeUpper === 'document') return 'document';
  if (mimeUpper === 'image') return captionLower?.includes('gif') ? 'animation' : 'photo';
  if (captionLower?.includes('voice')) return 'voice';
  if (captionLower?.includes('animation')) return 'animation';

  return mimeUpper || 'document';
};

export const checkFileSize = (sizeBytes, fileType) => {
  const limit = FILE_TYPES[fileType] || FILE_TYPES.document;
  return sizeBytes <= limit;
};

export const extractFileName = (msg, request) => {
  if (request?.headers?.['x-file-name']) {
    return request.headers['x-file-name'];
  }
  return msg.document?.fileName || msg.photo?.slice(-1)[0]?.fileName || msg.audio?.fileName ||
         msg.voice?.fileName || msg.animation?.fileName || 'file';
};

export const extractMimeType = (msg, request) => {
  if (request?.headers?.['x-mime-type']) {
    return request.headers['x-mime-type'];
  }
  return msg.document?.mimeType || msg.photo?.slice(-1)[0]?.mimeType || msg.audio?.mimeType ||
         msg.voice?.mimeType || msg.animation?.mimeType || 'application/octet-stream';
};
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/file.js
git commit -m "feat: add file validation utilities"
```

---

## Task 7: Setup Telegram API Utilities

**Files:**
- Create: `src/utils/telegram.js`

- [ ] **Step 1: Create telegram.js**

```javascript
import { Telegraf } from 'telegraf';
import logger from './logger.js';
import { config } from '../env.js';

const bot = new Telegraf(config.botToken);
const TELEGRAM_API_URL = `https://api.telegram.org/bot${config.botToken}/`;

export const forwardToStorage = async (fileChunk, fileName, forceDocument = false) => {
  try {
    const caption = forceDocument ? `📁 ${fileName}` : fileName;
    const input = forceDocument ? { document: fileChunk, caption } : { photo: [fileChunk], caption };

    const result = await bot.api.sendPhoto(config.storageChatId, input);

    logger.info('File forwarded to storage', { fileName, message: result.message_id });

    return {
      telegramFileId: result.photo?.slice(-1)[0]?.file_id,
      telegramFileUniqueId: result.photo?.slice(-1)[0]?.file_unique_id,
      storageMessageId: result.message_id
    };
  } catch (error) {
    logger.error('Failed to forward file to storage', { fileName, error: error.message });
    throw error;
  }
};

export const getFileInfo = async (telegramFileId, telegramFileUniqueId) => {
  try {
    const result = await fetch(`${TELEGRAM_API_URL}getFile`);
    const data = await result.json();

    if (!data.ok) {
      throw new Error(data.description || 'Telegram API error');
    }

    const fileId = data.result.file_id === telegramFileId ? telegramFileId : telegramFileUniqueId;
    const fileResult = await fetch(`${TELEGRAM_API_URL}getInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId })
    });
    const fileInfo = await fileResult.json();

    if (!fileInfo.ok) {
      throw new Error(fileInfo.description || 'Telegram info error');
    }

    return {
      file_size: fileInfo.result.file_size,
      mime_type: fileInfo.result.mime_type,
      file_path: fileInfo.result.file_path
    };
  } catch (error) {
    logger.error('Failed to get file info', { error: error.message });
    throw error;
  }
};

export const getBot = () => bot;
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/telegram.js
git commit -m "feat: add Telegram API utilities"
```

---

## Task 8: Setup Upload API Handler

**Files:**
- Create: `src/routes/upload.js`

- [ ] **Step 1: Create upload.js**

```javascript
import { Request, Response } from 'bun';
import logger from '../utils/logger.js';
import { db, files as fileSchema } from '../db/index.js';
import { nanoid } from 'nanoid';
import { forwardToStorage, getBot } from '../utils/telegram.js';
import { getFileType, checkFileSize, extractFileName, extractMimeType } from '../utils/file.js';
import { config } from '../env.js';

export const handleUpload = async (req, res) => {
  try {
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      return handleMultipartUpload(req, res);
    } else if (contentType.includes('application/json')) {
      return handleJSONUpload(req, res);
    }

    return res.status(400).json({ error: 'Unsupported content type. Use multipart/form-data or application/json' });
  } catch (error) {
    logger.error('Upload error', { error: error.message });
    return res.status(500).json({ error: error.message });
  }
};

const handleMultipartUpload = async (req, res) => {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const fileName = formData.get('fileName') || extractFileName({}, null);

    if (!file || !(file instanceof File)) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const fileBytes = await file.arrayBuffer();
    const fileBuffer = Buffer.from(fileBytes);
    const fileType = getFileType(null, fileName);

    if (!checkFileSize(fileBuffer.byteLength, fileType)) {
      return res.status(400).json({ error: `File size exceeds ${fileType} limit` });
    }

    const uploadTelegram = async (forceDocument = false) => {
      const result = await forwardToStorage(fileBuffer, fileName, forceDocument || fileName.endsWith('.pdf') || fileName.endsWith('.txt'));
      const bot = getBot();
      const fileInfo = await bot.api.getFile(result.telegramFileId);

      return {
        public_id: nanoid(),
        telegram_file_id: result.telegramFileId,
        telegram_file_unique_id: result.telegramFileUniqueId,
        storage_chat_id: config.storageChatId,
        storage_message_id: result.storageMessageId,
        file_name: fileName,
        mime_type: fileInfo.mime_type || 'application/octet-stream',
        size_bytes: fileInfo.file_size,
        file_type: fileType,
        uploader_id: 0,
        created_at: new Date().toISOString(),
        download_url: `${config.baseUrl}/f/${nanoid()}`
      };
    };

    const uploaded = await uploadTelegram(fileName.endsWith('.pdf') || fileName.endsWith('.txt') || !['photo', 'video', 'audio', 'voice', 'animation'].includes(fileType));

    await db.insert(fileSchema).values(uploaded);

    res.status(200).json(uploaded);
  } catch (error) {
    logger.error('Multipart upload error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
};

const handleJSONUpload = async (req, res) => {
  try {
    const { file, fileName = 'file' } = await req.json();

    if (!file || typeof file !== 'string') {
      return res.status(400).json({ error: 'Invalid JSON. Must include "file" (base64) and optional "fileName"' });
    }

    const fileBytes = Buffer.from(file, 'base64');
    const fileType = getFileType(null, fileName);

    if (!checkFileSize(fileBytes.byteLength, fileType)) {
      return res.status(400).json({ error: `File size exceeds ${fileType} limit` });
    }

    const result = await forwardToStorage(fileBytes, fileName);
    const bot = getBot();
    const fileInfo = await bot.api.getFile(result.telegramFileId);

    const uploaded = {
      public_id: nanoid(),
      telegram_file_id: result.telegramFileId,
      telegram_file_unique_id: result.telegramFileUniqueId,
      storage_chat_id: config.storageChatId,
      storage_message_id: result.storageMessageId,
      file_name: fileName,
      mime_type: fileInfo.mime_type || 'application/octet-stream',
      size_bytes: fileInfo.file_size,
      file_type: fileType,
      uploader_id: 0,
      created_at: new Date().toISOString(),
      download_url: `${config.baseUrl}/f/${nanoid()}`
    };

    await db.insert(fileSchema).values(uploaded);

    res.status(200).json(uploaded);
  } catch (error) {
    logger.error('JSON upload error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
};
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/upload.js
git commit -m "feat: add upload API handler (multipart & base64)"
```

---

## Task 9: Setup File Routes

**Files:**
- Create: `src/routes/files.js`

- [ ] **Step 1: Create files.js**

```javascript
import { Request, Response } from 'bun';
import logger from '../utils/logger.js';
import { db, files as fileSchema } from '../db/index.js';
import { checkRateLimit } from '../utils/rateLimit.js';

export const handleFileRedirect = async (req, res) => {
  try {
    const { public_id } = req.params;

    if (!public_id || !checkRateLimit(req.ip)) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }

    const result = await db.select().from(fileSchema).where(fileSchema.public_id.equals(public_id)).limit(1);

    if (!result.length) {
      logger.warn('File not found', { public_id });
      return res.status(404).json({ error: 'File not found' });
    }

    const file = result[0];
    const bot = (await import('../utils/telegram.js')).getBot();
    const fileInfo = await bot.api.getFile(file.telegram_file_id);

    const redirectUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;
    res.status(302).headers.set('Location', redirectUrl);
  } catch (error) {
    logger.error('File redirect error', { public_id, error: error.message });
    res.status(500).json({ error: 'Server error' });
  }
};

export const handleFileInfo = async (req, res) => {
  try {
    const { public_id } = req.params;

    const result = await db.select().from(fileSchema).where(fileSchema.public_id.equals(public_id)).limit(1);

    if (!result.length) {
      logger.warn('File not found', { public_id });
      return res.status(404).json({ error: 'File not found' });
    }

    const file = result[0];
    res.status(200).json({
      public_id: file.public_id,
      file_name: file.file_name,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      file_type: file.file_type,
      uploader_id: file.uploader_id,
      created_at: file.created_at
    });
  } catch (error) {
    logger.error('File info error', { public_id, error: error.message });
    res.status(500).json({ error: 'Server error' });
  }
};
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/files.js
git commit -m "feat: add file routes (download redirect & info)"
```

---

## Task 10: Setup Health Route

**Files:**
- Create: `src/routes/health.js`

- [ ] **Step 1: Create health.js**

```javascript
import { Response } from 'bun';
import logger from '../utils/logger.js';
import { db } from '../db/index.js';

export const handleHealth = async (req, res) => {
  try {
    await db.execute('SELECT 1');

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(500).json({ status: 'error', error: error.message });
  }
};
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/health.js
git commit -m "feat: add health check route"
```

---

## Task 11: Setup Telegram Bot Handler

**Files:**
- Create: `src/bot.js`

- [ ] **Step 1: Create bot.js**

```javascript
import { Telegraf } from 'telegraf';
import logger from './utils/logger.js';
import { config } from './env.js';
import { db, files as fileSchema } from './db/index.js';
import { nanoid } from 'nanoid';
import { forwardToStorage } from './utils/telegram.js';

export const startBot = async () => {
  try {
    const bot = new Telegraf(config.botToken);

    bot.command('start', async (ctx) => {
      await ctx.reply(
        `👋 Halo! Kirimkan file (document, photo, video, audio, voice, animation) ke bot ini. ` +
        `File akan disimpan di private channel dan kamu dapat download link permanen.`
      );
    });

    bot.on(['document', 'photo', 'video', 'audio', 'voice', 'animation'], async (ctx) => {
      try {
        const fileType = ctx.message.document ? 'document' :
                        ctx.message.photo ? 'photo' :
                        ctx.message.video ? 'video' :
                        ctx.message.audio ? 'audio' :
                        ctx.message.voice ? 'voice' : 'animation';

        const { file_id, file_unique_id, file_size, mime_type } = ctx.message[fileType];
        const fileName = ctx.message.document?.fileName ||
                        ctx.message.photo?.slice(-1)[0]?.fileName ||
                        ctx.message.video?.fileName ||
                        ctx.message.audio?.fileName ||
                        ctx.message.voice?.fileName ||
                        'file';

        const maxSize = fileType === 'photo' ? 10 * 1024 * 1024 :
                       fileType === 'audio' ? 200 * 1024 * 1024 :
                       fileType === 'voice' ? 200 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;

        if (file_size > maxSize) {
          return ctx.reply(`File size exceeds ${maxSize / (1024 * 1024)}MB limit`);
        }

        const result = await forwardToStorage(file_id, fileName);
        const publicId = nanoid();

        const uploaded = {
          public_id: publicId,
          telegram_file_id: result.telegramFileId,
          telegram_file_unique_id: result.telegramFileUniqueId,
          storage_chat_id: config.storageChatId,
          storage_message_id: result.storageMessageId,
          file_name: fileName,
          mime_type: mime_type,
          size_bytes: file_size,
          file_type: fileType,
          uploader_id: ctx.from.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        await db.insert(fileSchema).values(uploaded);

        const url = `${config.baseUrl}/f/${publicId}`;
        await ctx.reply(`File berhasil diupload! 📎\n\nDownload: ${url}`, {
          reply_parameters: { message_id: ctx.message.message_id }
        });

        logger.info('File uploaded via bot', { public_id, fileType, fileName, uploader: ctx.from.id });
      } catch (error) {
        logger.error('Bot file handler error', { error: error.message, chat_id: ctx.chat.id });
        await ctx.reply('❌ Gagal mengupload file. Coba lagi nanti.');
      }
    });

    bot.use((ctx, next) => {
      logger.info('Telegram event received', { type: ctx.update.type, chat_id: ctx.chat?.id });
      return next();
    });

    await bot.launch();

    logger.info('Telegram bot started', { botToken: config.botToken?.substring(0, 10) + '...' });

    return bot;
  } catch (error) {
    logger.error('Failed to start bot', { error: error.message });
    throw error;
  }
};
```

- [ ] **Step 2: Commit**

```bash
git add src/bot.js
git commit -m "feat: add Telegram bot handler"
```

---

## Task 12: Setup HTTP Server and Bootstrap

**Files:**
- Create: `src/index.js`

- [ ] **Step 1: Create index.js**

```javascript
import { serve } from 'bun';
import logger from './utils/logger.js';
import { config } from './env.js';
import { startBot } from './bot.js';
import { handleUpload } from './routes/upload.js';
import { handleFileRedirect, handleFileInfo } from './routes/files.js';
import { handleHealth } from './routes/health.js';
import { cleanupRateLimitCache } from './utils/rateLimit.js';

const server = serve({
  port: config.port,
  routes: {
    '/api/upload': {
      POST: handleUpload
    },
    '/f/:public_id': {
      GET: handleFileRedirect
    },
    '/file/:public_id/info': {
      GET: handleFileInfo
    },
    '/health': {
      GET: handleHealth
    }
  }
});

const bot = await startBot();

logger.info('Server started', { port: config.port, url: config.baseUrl });

const gracefulShutdown = async (signal) => {
  logger.info('Graceful shutdown signal received', { signal });

  logger.info('Closing HTTP server');
  server.stop();

  logger.info('Stopping Telegram bot');
  await bot.stop();

  logger.info('Server shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

setInterval(cleanupRateLimitCache, 60000);

logger.info('Application running successfully');
```

- [ ] **Step 2: Commit**

```bash
git add src/index.js
git commit -m "feat: setup HTTP server and bootstrap application"
```

---

## Task 13: Update Existing Files

**Files:**
- Modify: `package.json`
- Modify: `index.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Remove TypeScript files**

```bash
rm index.ts tsconfig.json
```

- [ ] **Step 2: Update package.json to remove TypeScript devDependency**

```bash
# Edit package.json to remove lines 6-10 (devDependencies @types/bun and typescript peerDependency)
```

- [ ] **Step 3: Install dependencies**

```bash
bun install
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: replace TypeScript with ESM JavaScript"
```

---

## Task 14: Test and Verify

**Commands:**

- [ ] **Step 1: Run development server**

```bash
bun run dev
```

- [ ] **Step 2: Test health endpoint**

```bash
curl http://localhost:4000/health
# Expected: {"status":"ok"}
```

- [ ] **Step 3: Upload test file via HTTP API (multipart)**

```bash
curl -X POST http://localhost:4000/api/upload \
  -F "file=@/path/to/testfile.txt" \
  -F "fileName=test.txt"
```

- [ ] **Step 4: Check file info endpoint**

```bash
curl http://localhost:4000/file/{public_id}/info
# Expected: JSON with file metadata
```

- [ ] **Step 5: Download redirect**

```bash
curl -I http://localhost:4000/f/{public_id}
# Expected: HTTP 302 with Location header to Telegram CDN
```

- [ ] **Step 6: Test bot upload on Telegram**

```
1. Start bot: /start
2. Send test file to bot
3. Check if file is forwarded to storage channel
4. Verify response contains download link
```

- [ ] **Step 7: Test error handling (file too large)**

```bash
curl -X POST http://localhost:4000/api/upload \
  -F "file=@/dev/null" \
  -H "Content-Length: 10000000000"
# Expected: HTTP 400 with error message
```

- [ ] **Step 8: Test rate limiting**

```bash
# Send 31 requests within 1 minute
for i in {1..31}; do curl http://localhost:4000/f/{public_id} & done
wait
# Expected: First 30 succeed, last one returns 429
```

- [ ] **Step 9: Test graceful shutdown**

```bash
# In terminal 1: bun run dev
# In terminal 2: curl http://localhost:4000/health && sleep 0.1 && curl http://localhost:4000/health
# Send SIGINT to server (Ctrl+C in terminal 1)
# Check if server stops cleanly, logs show shutdown sequence
```

- [ ] **Step 10: Review logs**

```bash
# Check logs directory
ls -la logs/
# Expected: error.log and combined.log created
# View error logs: tail -f logs/error.log
# View combined logs: tail -f logs/combined.log
```

---

## Task 15: Production Ready

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Update .env.example with production-ready defaults**

```bash
# Copy .env.example to .env and update values for production
```

- [ ] **Step 2: Update README.md with production deployment notes**

```bash
# Update README.md with:
# - PM2 setup for production
# - Reverse proxy (Nginx) configuration
# - SSL certificate setup
# - Database backup strategy
```

- [ ] **Step 3: Commit production-ready changes**

```bash
git add .env.example README.md
git commit -m "docs: add production deployment guide"
```

---

## Summary

This plan implements a complete production-ready Telegram bot uploader backend with:

✅ Bun runtime with ESM JavaScript
✅ Telegraf bot listening for file uploads
✅ HTTP API accepting multipart and base64 uploads
✅ PostgreSQL storage with Drizzle ORM
✅ Redirect-based downloads (minimal VPS bandwidth)
✅ In-memory rate limiting (30 req/min per IP)
✅ Winston structured logging
✅ Graceful shutdown handling
✅ All required endpoints (health, upload, download, info)
✅ Environment variable validation
✅ Comprehensive error handling

**Plan complete and saved to `docs/superpowers/plans/2026-05-17-telegram-uploader-backend-plan.md`**

Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**