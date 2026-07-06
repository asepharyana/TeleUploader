# S3-Compatible TeleUploader + Web File Manager

**Date:** 2026-07-06
**Status:** Approved

Objective: Transform TeleUploader into an S3-compatible storage server (Telegram-backed) with a web file manager UI. Existing upload/download API paths remain unchanged.

---

## 1. Architecture Overview

```
S3 Client (aws-cli, rclone, s3cmd, MinIO Client)
         │
         ▼  AWS SigV4 + XML
┌─────────────────────────────────────┐
│          S3 Protocol Dispatcher     │  src/routes/s3.ts
│  - Parses path, query, auth headers │
│  - Routes to S3 operation handlers  │
├─────────────────────────────────────┤
│   JSON API v1 (for Web UI)          │  src/routes/web-api.ts
│  - Bucket CRUD                      │
│  - Object list/upload/copy/delete   │
├─────────────────────────────────────┤
│         Web File Manager            │  src/routes/home.ts + home.html
│  - Bucket browser, upload/download  │
├─────────────────────────────────────┤
│       Database Layer                │  src/db/buckets.ts
│  - buckets, files (extended),       │  src/db/multipart.ts
│  - multipart_uploads, parts         │
├─────────────────────────────────────┤
│       Telegram Storage Layer        │  src/utils/telegram.ts (existing)
│  - Single Telegram channel           │
│  - Files stored as Telegram docs    │
└─────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **S3 Protocol Dispatcher** | S3 fallback route (`$`). Parse Auth header, detect SigV4, route by method+path+query |
| **S3 Operations** | ~20 operations (ListBuckets, GetObject, PutObject, ListObjectsV2, MultipartUpload, DeleteObjects, etc) |
| **Auth (SigV4)** | Verify AWS SigV4 signatures, reject invalid/missing with 403 XML error |
| **XML Builder** | Template functions to construct S3 XML responses. Parse incoming XML (DeleteObjects body) |
| **JSON API v1** | JSON wrapper for web UI to avoid XML parsing in browser |
| **Web File Manager** | Single-page app served at `/` with bucket browser, upload, delete, search |
| **DB Layer** | New tables: buckets, multipart_uploads, multipart_parts. Extended files table |
| **Telegram Storage** | Existing forwardToStorage/getFileInfo; unchanged |

### Routing Priority

Route matching order (existing unchanged, S3 added as catch-all):

| Priority | Route | Handler |
|----------|-------|---------|
| 1 | `/api/upload` | Existing upload handler |
| 2 | `/f/:public_id` | Existing file redirect |
| 3 | `/file/:public_id/info` | Existing file info |
| 4 | `/health` | Existing health |
| 5 | `/docs` / `/swagger.json` | Existing swagger |
| 6 | `/` | Web file manager UI (NEW) |
| 7 | `/api/v1/*` | JSON API for Web UI (NEW) |
| 8 | `$` (catch-all) | S3 dispatcher (NEW) |

The catch-all route (`$` in Bun.serve()) inspects the `Authorization` header:
- Contains `AWS4-HMAC-SHA256` → handle as S3 request
- Otherwise → 404

---

## 2. Database Schema

### 2.1 buckets Table (NEW)

```sql
CREATE TABLE buckets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Bucket name constraints: lowercase, no underscore, 3-63 chars (S3 spec)
```

### 2.2 files Table — Extended

New columns added alongside existing ones:

```sql
ALTER TABLE files ADD COLUMN bucket_id UUID REFERENCES buckets(id);
ALTER TABLE files ADD COLUMN s3_key TEXT;           -- e.g. "images/logo.png"
ALTER TABLE files ADD COLUMN storage_backend TEXT DEFAULT 'telegram';
ALTER TABLE files ADD COLUMN is_deleted BOOLEAN DEFAULT false;
ALTER TABLE files ADD COLUMN multipart_upload_id TEXT;

CREATE UNIQUE INDEX idx_files_bucket_key ON files(bucket_id, s3_key) WHERE is_deleted = false;
CREATE INDEX idx_files_bucket_prefix ON files(bucket_id, s3_key text_pattern_ops);
```

- `s3_key` is the full object key path
- `is_deleted` enables soft-delete for S3 DeleteObject
- `multipart_upload_id` links parts to their parent completed multipart object
- `public_id` (existing) remains primary identifier for Telegram redirect
- Existing non-S3 uploads have `bucket_id = NULL, s3_key = NULL`

### 2.3 multipart_uploads Table (NEW)

```sql
CREATE TABLE multipart_uploads (
  upload_id TEXT PRIMARY KEY,
  bucket_id UUID NOT NULL REFERENCES buckets(id),
  s3_key TEXT NOT NULL,
  initiated_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'aborted')),
  initiated_by TEXT
);
```

### 2.4 multipart_parts Table (NEW)

```sql
CREATE TABLE multipart_parts (
  id SERIAL PRIMARY KEY,
  upload_id TEXT NOT NULL REFERENCES multipart_uploads(upload_id) ON DELETE CASCADE,
  part_number INT NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT NOT NULL,
  storage_message_id BIGINT NOT NULL,
  size_bytes BIGINT NOT NULL,
  etag TEXT NOT NULL,                     -- SHA256 hash as etag
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(upload_id, part_number)
);

CREATE INDEX idx_multipart_parts_upload ON multipart_parts(upload_id, part_number);
```

### 2.5 Multipart Storage Strategy

Each part is stored as an independent file in the Telegram channel. The DB links them logically:

- **UploadPart**: forward part to Telegram via forwardToStorage → record in multipart_parts
- **CompleteMultipartUpload**: create a single `files` row with `multipart_upload_id` pointing to the parts. No new Telegram upload needed.
- **GetObject for multipart object**: query parts ordered by part_number, stream sequentially via Telegram CDN URLs. Client sees a single continuous download.
- **AbortMultipartUpload**: delete DB records only (Telegram orphan files are accepted as GC is not feasible)

---

## 3. S3 Protocol Layer

### 3.1 Full Endpoint Coverage (~20 endpoints)

#### Bucket Operations

| Method | Path | Query Params | Handler Description |
|--------|------|-------------|-------------------|
| GET | `/` | — | List all buckets → `<ListAllMyBucketsResult>` XML |
| PUT | `/{bucket}` | — | Create bucket (reject if exists) → 200 |
| HEAD | `/{bucket}` | — | Check bucket exists → 200 or 404 |
| DELETE | `/{bucket}` | — | Delete empty bucket → 204 |

#### Object Operations

| Method | Path | Query / Special | Handler Description |
|--------|------|----------------|-------------------|
| GET | `/{bucket}/{key+}` | — | GetObject: redirect to Telegram CDN (same as existing `/f/:public_id`) |
| HEAD | `/{bucket}/{key+}` | — | Return metadata headers (Content-Length, Content-Type, ETag, Last-Modified) |
| PUT | `/{bucket}/{key+}` | `x-amz-copy-source`? | Without copy header: upload multipart form → Telegram. With copy header: copy existing object in DB |
| DELETE | `/{bucket}/{key+}` | — | Soft-delete (is_deleted = true) → 204 |
| POST | `/{bucket}/{key+}` | `?tagging` | Return 204 (no-op, tagging not implemented) |

#### Object Listing

| Method | Path | Query Params | Handler Description |
|--------|------|-------------|-------------------|
| GET | `/{bucket}` | — | ListObjects v1 → `<ListBucketResult>` XML |
| GET | `/{bucket}` | `?list-type=2` | ListObjectsV2 → `<ListBucketResultV2>` XML |

Supports: `prefix`, `delimiter`, `max-keys` (default 1000), `continuation-token` (v2), `marker` (v1), `encoding-type=url`.

#### Batch Operations

| Method | Path | Query Params | Handler Description |
|--------|------|-------------|-------------------|
| POST | `/{bucket}` | `?delete` | Parse XML body `<Delete><Object><Key>...</Key></Object></Delete>` → soft-delete each → `<DeleteResult>` XML |

#### Multipart Upload

| Method | Path | Query Params | Handler Description |
|--------|------|-------------|-------------------|
| POST | `/{bucket}/{key+}` | `?uploads` | Initiate: create multipart_uploads row → `<InitiateMultipartUploadResult>` XML with UploadId |
| PUT | `/{bucket}/{key+}` | `?partNumber=N&uploadId=X` | Upload part: stream to Telegram → record in multipart_parts → return ETag header |
| POST | `/{bucket}/{key+}` | `?uploadId=X` | Complete: parse `<CompleteMultipartUpload><Part><PartNumber>N<ETag>...</Part></CompleteMultipartUpload>` → create files row with multipart_upload_id → `<CompleteMultipartUploadResult>` XML |
| DELETE | `/{bucket}/{key+}` | `?uploadId=X` | Abort: delete records, update status → 204 |
| GET | `/{bucket}/{key+}` | `?uploadId=X` | List parts → `<ListPartsResult>` XML |

### 3.2 AWS Signature V4 (SigV4)

Authentication process for each S3 request:

```
1. Extract Authorization header
2. Parse credential scope (date/region/service)
3. Reconstruct CanonicalRequest
4. Compute expected signing key
5. Compare signatures
6. Match → proceed; Mismatch → 403 Forbidden with AWS XML error
```

**Canonical Request construction:**
```
<HTTPMethod>\n
<CanonicalURI>\n
<CanonicalQueryString>\n
<CanonicalHeaders>\n
<SignedHeaders>\n
<HashedPayload>
```

**Implementation notes:**
- Only verify signature; do not validate timestamp freshness (simplified, acceptable for single-server setup behind reverse proxy)
- Hard-code `region = 'us-east-1'` (irrelevant for functionality; S3 clients accept any region)
- Single set of S3 credentials (`S3_ACCESS_KEY` + `S3_SECRET_KEY` in env)
- Chunked transfer encoding (`aws-chunked`) — not supported initially; client must use standard PUT. Return 501 if detected.

### 3.3 XML Serialization

No external XML library. Template strings for responses:

```typescript
// Example: ListBuckets response
const listBucketsXml = (buckets: Bucket[]) => `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Buckets>
    ${buckets.map(b => `<Bucket>
      <Name>${escapeXml(b.name)}</Name>
      <CreationDate>${b.createdAt.toISOString()}</CreationDate>
    </Bucket>`).join('')}
  </Buckets>
</ListAllMyBucketsResult>`;
```

**XML parsing** (only for DeleteObjects body): use simple string matching / regex on `<Key>...</Key>` tags. The DeleteObjects XML is simple and well-structured enough for this without a parser library.

### 3.4 Error Responses

All S3 errors return XML with HTTP status:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <Resource>/bucket/key</Resource>
  <RequestId>...</RequestId>
</Error>
```

Common error codes: `NoSuchBucket`, `NoSuchKey`, `BucketAlreadyExists`, `BucketNotEmpty`, `InvalidPartOrder`, `NoSuchUpload`, `SignatureDoesNotMatch`, `AccessDenied`, `InternalError`.

### 3.5 Presigned URL Support

`GET /{bucket}/{key+}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-SignedHeaders=host&X-Amz-Expires=3600&X-Amz-Signature=...`

For presigned GET URLs:
- Verify signature (much simpler — no body hash required, querystring-based)
- If valid → return redirect to Telegram CDN (same as GetObject)
- If expired → 403

Only presigned GET is essential; presigned PUT is optional for v1.

---

## 4. Web File Manager UI

### 4.1 Served At

Route `'/'` → `home.html` (single HTML file with embedded CSS + JS)

### 4.2 Layout (responsive)

```
┌─────────────────────────────────────────┐
│ ☰ TeleUploader    ◉ my-bucket ▼ [+]     │  ← Top bar
├─────────────────────────────────────────┤
│ ─────────────────────────────────────── │
│ 🗂  images/            Jul 06   2 items  │
│ 🗂  documents/         Jul 05   5 items  │
│ 📄 logo.png    2.4 MB Jul 06  [⋮ ▼]     │  ← Actions dropdown
│ 📄 report.pdf  1.2 MB Jul 05  [⋮ ▼]     │
│ 📄 photo.jpg   3.1 MB Jul 04  [⋮ ▼]     │
│ ─────────────────────────────────────── │
│                              ↑ Load more │
└─────────────────────────────────────────┘
│ Drag & drop upload area (footer)        │
└─────────────────────────────────────────┘
```

### 4.3 Features

| Feature | Implementation |
|---------|----------------|
| **Bucket selector** | Dropdown, fetches bucket list from `/api/v1/buckets` |
| **Create bucket** | Prompt for name → POST `/api/v1/buckets` |
| **Delete bucket** | Confirm → DELETE `/api/v1/buckets/{name}` |
| **Object listing** | GET `/api/v1/buckets/{name}/objects?prefix=X&delimiter=/` |
| **Folder navigation** | Breadcrumb from prefix, click to drill down |
| **Upload** | Drag-drop or click → POST `/api/v1/buckets/{name}/upload` |
| **Upload progress** | XMLHttpRequest.upload.onprogress |
| **Download** | Direct download via GET `/api/v1/buckets/{name}/download/{key}` |
| **Copy link** | Copy full S3 URL to clipboard |
| **Delete** | Confirm → soft delete |
| **Search** | Filter by key prefix (debounced) |
| **Credentials info** | Show S3_ACCESS_KEY + S3_SECRET_KEY (from env) in a modal |
| **Dark/light mode** | CSS variables, @media prefers-color-scheme |

### 4.4 Web API v1 (JSON)

These endpoints enable the UI without XML:

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/v1/buckets` | `{buckets: [{id, name, createdAt, objectCount}]}` |
| POST | `/api/v1/buckets` | `{id, name}` |
| DELETE | `/api/v1/buckets/{name}` | `{success: true}` |
| GET | `/api/v1/buckets/{name}/objects?prefix=&delimiter=/&continuationToken=` | `{objects, prefixes, isTruncated}` |
| POST | `/api/v1/buckets/{name}/upload` | Multipart form → `{key, size, etag}` |
| DELETE | `/api/v1/buckets/{name}/{key+}` | `{success: true}` |
| POST | `/api/v1/buckets/{name}/copy` | `{sourceKey, destKey}` |

### 4.5 Download via Web UI

For the web UI, download doesn't use S3 headers. Instead:
- `GET /api/v1/buckets/{name}/download/{key+}` → redirects to Telegram CDN, similar to `/f/:public_id`
- This bypasses S3 auth (which the browser can't do with SigV4)

---

## 5. Existing Routes — Unchanged

All existing functionality remains intact:

- `POST /api/upload` — multipart + JSON file upload
- `GET /f/:public_id` — file redirect to Telegram CDN
- `GET /file/:public_id/info` — file metadata
- `GET /health` — database health
- `GET /docs` + `/swagger.json` — API docs

The existing upload flow does not interact with S3 bucket/keys. This is intentional: the JSON API remains for simple programmatic upload without S3 complexity.

---

## 6. Security Model

| Layer | Mechanism |
|-------|-----------|
| **S3 API** | SigV4 signature verification. Single credential pair from env |
| **Web UI** | No auth (internal tool). Relies on network-level security / reverse proxy |
| **JSON API** (existing) | Rate-limited only (same as now). No additional auth |
| **Rate limiting** | Applied to S3 operations per IP |

---

## 7. Implementation Order

The following build sequence minimizes blocked dependencies:

| Phase | Tasks | Depends On |
|-------|-------|------------|
| **1. DB schema** | Create `buckets`, `multipart_uploads`, `multipart_parts` tables. Migrate existing DB | Nothing |
| **2. DB layer** | CRUD functions for buckets, multipart, files extended | Phase 1 |
| **3. S3 Auth + XML** | SigV4 verification, XML builder templates | Nothing (parallel with 1) |
| **4. S3 Bucket Ops** | ListBuckets, CreateBucket, HeadBucket, DeleteBucket | Phase 1, 3 |
| **5. S3 Object Ops** | PutObject, GetObject, HeadObject, DeleteObject, CopyObject, DeleteObjects | Phase 2, 3, 4 |
| **6. S3 Listing** | ListObjects, ListObjectsV2 | Phase 2, 3, 4 |
| **7. S3 Multipart** | CreateMultipartUpload, UploadPart, Complete, Abort, ListParts | Phase 2, 3, 4 |
| **8. S3 Dispatcher** | Wire up catch-all route with auth detection | Phase 4-7 |
| **9. JSON Web API** | All `/api/v1/*` endpoints | Phase 2, 4 |
| **10. Web UI** | home.html with bucket browser, upload, delete, search | Phase 9 |
| **11. Tests** | S3 auth test, bucket operations test, object operations test, multipart test | Phase 4-8 |

---

## 8. Configuration (New Env Vars)

```env
# S3-compatible API credentials
S3_ACCESS_KEY=teleuploader-admin       # Access key for SigV4 auth
S3_SECRET_KEY=your-secret-key-here     # Secret key for SigV4 auth
S3_DEFAULT_REGION=us-east-1            # S3 region (cosmetic, affects signature scope)

# Existing vars unchanged:
# BOT_TOKEN, ADDITIONAL_BOT_TOKENS, STORAGE_CHANNEL_ID, BASE_URL, ...
```

---

## 9. Testing Strategy

| Test Focus | Scope | 
|------------|-------|
| SigV4 auth | Verify signature verification, reject invalid signatures |
| S3 Bucket operations | Create, list, head, delete buckets |
| S3 Object operations | Put, get, head, delete objects (via Telegram) |
| S3 ListObjects | Pagination, prefix, delimiter, continuation token |
| S3 Multipart | Create, upload parts, complete, abort |
| S3 DeleteObjects | Batch delete XML body parsing |
| S3 Error responses | Correct XML error format per status code |
| Web API | JSON endpoints return correct data |
| Non-S3 routes | Existing routes still work (regression) |

---

## 10. Open Questions / Future

1. **Presigned URL support** — GET presigned URLs in v1; PUT presigned for v2
2. **CORS headers** — if web UI served from different origin than S3 API calls
3. **Versioning** — not supported (single version per key)
4. **ACL / Bucket policies** — not supported (single user model)
5. **Lifecycle rules** — not supported
6. **Website hosting** — not supported
7. **Default bucket** — consider creating a default bucket on first start for convenience
8. **Upload via S3 API directly to web UI** — web UI could also call S3 API directly for maximum compatibility demo
9. **S3-compatible client list** — tested clients: aws-cli, rclone, s3cmd, MinIO Client, Cyberduck
