# Telegram Bot Uploader Backend Design

> ⚠️ **LEGACY** — Dokumen historis (2026-05-17). Port & infrastruktur sudah berubah:
> produksi kini berjalan di port `4000` (Nix + systemd + Caddy, domain `upload.asepharyana.my.id`)
> dan database via PgBouncer pool `100.121.180.82:6432` (bukan port 5432, bukan localhost).


**Date:** 2026-05-17  
**Status:** Approved  
**Stack:** Bun, Telegraf, PostgreSQL, Drizzle ORM, Winston, nanoid

## Overview

Production-ready backend untuk Telegram file uploader dengan dual upload methods (bot + HTTP API), persistent storage di private Telegram channel, dan redirect-based download untuk minimal bandwidth usage.

## Architecture

### Components

1. **HTTP Server** (Bun.serve)
   - Handle REST endpoints
   - Rate limiting (in-memory, per IP)
   - Request/response logging

2. **Telegram Bot** (Telegraf)
   - Listen file uploads from users
   - Forward files to private storage channel
   - Extract and persist metadata

3. **Database Layer** (Drizzle + PostgreSQL)
   - Persist file metadata
   - Indexed queries by public_id, telegram_file_id, uploader_id

### Data Flow

#### Upload via Telegram Bot
1. User sends file to bot (document/photo/video/audio/voice/animation)
2. Bot validates file size against Telegram limits
3. Bot forwards file to private storage channel
4. Bot extracts `telegram_file_id`, `telegram_file_unique_id`, `storage_message_id`
5. Bot generates `public_id` using nanoid
6. Bot saves metadata to PostgreSQL
7. Bot replies with download link: `https://upload.asepharyana.my.id/f/{public_id}`

#### Upload via HTTP API
1. Client POSTs to `/api/upload` with file (multipart or base64)
2. Server validates file size
3. Server forwards file to private storage channel
4. Server extracts file IDs and message ID
5. Server generates `public_id`
6. Server saves metadata to PostgreSQL
7. Server returns full metadata JSON

#### Download (Redirect)
1. User accesses `GET /f/:public_id`
2. Server checks rate limit (30 req/min per IP, in-memory)
3. Server queries DB by `public_id`
4. Server calls Telegram Bot API `getFile()`
5. Server redirects to Telegram CDN URL
6. Browser downloads from Telegram (VPS bandwidth minimal)

#### File Info
1. User accesses `GET /file/:public_id/info`
2. Server queries DB by `public_id`
3. Server returns full metadata (no rate limit)

## Database Schema

### Table: files

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

## API Endpoints

### POST /api/upload
Upload file via HTTP API.

**Request (Multipart):**
```
Content-Type: multipart/form-data
file: <binary>
fileName: optional_filename.ext
```

**Request (Base64):**
```json
{
  "file": "base64encodedstring",
  "fileName": "filename.ext"
}
```

**Response (200):**
```json
{
  "public_id": "abc123xyz",
  "file_name": "document.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 1024000,
  "file_type": "document",
  "created_at": "2026-05-17T23:42:19Z",
  "download_url": "https://upload.asepharyana.my.id/f/abc123xyz"
}
```

**Response (400):**
```json
{
  "error": "File size exceeds limit"
}
```

### GET /f/:public_id
Redirect to Telegram CDN for download.

**Response (302):**
```
Location: https://api.telegram.org/file/bot.../...
```

**Response (404):**
```json
{
  "error": "File not found"
}
```

**Response (429):**
```json
{
  "error": "Rate limit exceeded"
}
```

### GET /file/:public_id/info
Get file metadata.

**Response (200):**
```json
{
  "public_id": "abc123xyz",
  "file_name": "document.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 1024000,
  "file_type": "document",
  "uploader_id": 123456789,
  "created_at": "2026-05-17T23:42:19Z"
}
```

**Response (404):**
```json
{
  "error": "File not found"
}
```

### GET /health
Health check endpoint.

**Response (200):**
```json
{
  "status": "ok"
}
```

## Project Structure

```
src/
  index.js           — entry point, start server & bot
  bot.js             — Telegraf bot setup & handlers
  env.js             — environment validation
  db/
    index.js         — Drizzle setup & connection
    schema.js        — Drizzle schema definition
  routes/
    files.js         — GET /f/:public_id, GET /file/:public_id/info
    upload.js        — POST /api/upload (multipart & base64)
    health.js        — GET /health
  utils/
    file.js          — file type validation, size check
    telegram.js      — Telegram API helpers, forward file
    logger.js        — Winston logger setup
    rateLimit.js     — in-memory rate limiter
package.json
.env.example
schema.sql
```

## Configuration

### Environment Variables

```
BOT_TOKEN=<telegram_bot_token>
STORAGE_CHANNEL_ID=<private_channel_id>
BASE_URL=https://upload.asepharyana.my.id
DATABASE_URL=postgresql://asephs:***@100.121.180.82:6432/uploader
PORT=4000
NODE_ENV=production
LOG_LEVEL=info
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=30
```

## Error Handling

- **Winston logger** with levels: error, warn, info, debug
- **Structured logging** (JSON format) for production
- **Try-catch** in all async operations
- **Graceful error responses:**
  - 400 Bad Request — invalid input
  - 404 Not Found — file not found
  - 429 Too Many Requests — rate limit exceeded
  - 500 Internal Server Error — server error
- **Telegram API errors** — log and retry logic for transient failures

## Rate Limiting

- **In-memory rate limiter** per IP address
- **Window-based:** reset every minute
- **Limit:** 30 requests/minute per IP (configurable)
- **Response:** 429 Too Many Requests if exceeded
- **Applies to:** `GET /f/:public_id` only

## Graceful Shutdown

1. Stop accepting new requests
2. Wait for pending requests to complete
3. Close database connection pool
4. Stop Telegram bot polling
5. Exit process

## File Type Support

Accepts all Telegram file types:
- document
- photo
- video
- audio
- voice
- animation

File size limits per Telegram API:
- Documents: 2GB
- Photos: 10MB
- Videos: 2GB
- Audio: 200MB
- Voice: 200MB
- Animation: 2GB

## Security Considerations

- No authentication on `/api/upload` (public endpoint)
- Rate limiting on download endpoint to prevent abuse
- File size validation against Telegram limits
- Input validation on file names
- SQL injection prevention via Drizzle ORM
- CORS headers if needed for cross-origin requests

## Deployment Notes

- **Single instance:** in-memory rate limiter sufficient
- **Multiple instances:** consider Redis-based rate limiter (future enhancement)
- **Database:** PostgreSQL 12+
- **Telegram Bot:** must be admin in private storage channel
- **URL stability:** backend URL is permanent, Telegram CDN URLs may change

## Testing Strategy

- Unit tests for utility functions (file validation, rate limiter)
- Integration tests for database operations
- E2E tests for upload and download flows
- Manual testing with actual Telegram bot

## Future Enhancements

- Redis-based rate limiter for multi-instance deployments
- File expiration/cleanup policies
- Download analytics
- API key authentication for `/api/upload`
- Webhook support for upload notifications
