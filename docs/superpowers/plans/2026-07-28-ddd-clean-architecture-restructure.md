# DDD & Clean Architecture Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure TeleUploader from flat architecture to DDD/Clean Architecture with repository abstraction, controller/use-case separation, and full JSDoc documentation.

**Architecture:** 5-layer DDD — domain (entities + ports), application (use cases + DTOs), infrastructure (persistence + telegram + cache), interfaces (HTTP controllers + routes + middleware + bot + S3 protocol), and shared/config foundation.

**Tech Stack:** Bun + TypeScript + Drizzle ORM + Telegraf

## Global Constraints

- Zero behavioral changes — only move/restructure code, never alter logic
- Old source files remain until Phase 8 (cleanup), so existing tests keep passing
- JSDoc on every exported function, interface, type, and class (English)
- All new imports use relative paths within new structure
- `config/` and `shared/` have zero dependencies on other new layers
- Domain `ports/` interfaces are implemented by `infrastructure/` repositories
- Use cases constructed via factory functions accepting repository interfaces (no DI framework)
- Controller = HTTP parsing + use case call + response formatting only; no business logic
- Domain entities reuse Drizzle types (no pure domain models)
- `bun test test/<file>` must pass at every phase (old files remain)

---

### Phase 1: Foundation Layer — Config + Shared Utilities

#### Task 1: Create config/index.ts

**Files:**
- Create: `src/config/index.ts`

**Interfaces:**
- Produces: `AppConfig` type, `config: AppConfig` singleton

- [ ] **Create `src/config/index.ts`** — Move content from `src/env.ts`. Same `AppConfig` interface, same `config` export. Add JSDoc to `AppConfig` interface (document every property), the `config` export, `parseNumber`, `parseTokens`, `parseDomains`, `maskSecret`, `maskDatabaseUrl`.

- [ ] **Run tests to verify nothing broken**

```bash
bun test test/env.test.ts
```
Expected: PASS

- [ ] **Create `src/config/__tests__/env.test.ts`** — Mirror of `test/env.test.ts` but imports from `../../config/index.ts`

- [ ] **Run both env tests to verify**

```bash
bun test test/env.test.ts
bun test src/config/__tests__/env.test.ts
```
Expected: Both PASS

- [ ] **Commit**

```bash
git add src/config/
git commit -m "feat: create config layer with JSDoc"
```

#### Task 2: Create shared/ errors and logger

**Files:**
- Create: `src/shared/errors/index.ts`
- Create: `src/shared/logger/index.ts`

**Interfaces:**
- Produces: `DomainError`, `FileNotFoundError`, `BucketNotFoundError`, `FileTooLargeError`, `DuplicateFileError`, `AuthenticationError`, `ValidationError`, `logger` singleton, type `Logger`

- [ ] **Create `src/shared/errors/index.ts`** — Export all error classes from spec Section 11. Add JSDoc for each class.

- [ ] **Create `src/shared/logger/index.ts`** — Move content from `src/utils/logger.ts`. Same implementation. Add JSDoc.

- [ ] **Quick compile check**

```bash
bun build src/config/index.ts --target=bun --outfile=/dev/null 2>&1 | head -5
bun build src/shared/errors/index.ts --target=bun --outfile=/dev/null 2>&1 | head -5
```
Expected: No errors

- [ ] **Commit**

```bash
git add src/shared/errors/ src/shared/logger/
git commit -m "feat: create shared errors and logger layer"
```

#### Task 3: Create shared/ metrics

**Files:**
- Create: `src/shared/metrics/index.ts`

**Interfaces:**
- Produces: `metricsCollector`, `MetricsCollector`, `getSnapshot()`

- [ ] **Create `src/shared/metrics/index.ts`** — Move content from `src/utils/metrics.ts`. Same implementation. Add JSDoc to class, all methods, and `getSnapshot()` return type.

- [ ] **Compile check**

```bash
bun build src/shared/metrics/index.ts --target=bun --outfile=/dev/null 2>&1 | head -5
```
Expected: No errors

- [ ] **Commit**

```bash
git add src/shared/metrics/
git commit -m "feat: create shared metrics layer"
```

#### Task 4: Create shared/utils (file, ip, retry, zip)

**Files:**
- Create: `src/shared/utils/file.ts`
- Create: `src/shared/utils/ip.ts`
- Create: `src/shared/utils/retry.ts`
- Create: `src/shared/utils/zip.ts`

**Interfaces:**
- Produces: `getErrorMessage`, `cleanupTempFile`, `getFileType`, `checkFileSize`, `ensureExtension`, `extractFileName`, `extractMimeType`, `computeHash`, `extractFileFromMessage`, `detectFileType`, `getFileSizeLimit`, `formatCreatedAt`, `buildUploadResponse`, `extractClientIp`, `withRetry`, `withTimeout`, `withFallback`, `createZip`, `extractZipEntry`, `locateZipEntry`

- [ ] **Create `src/shared/utils/file.ts`** — Move all exports from `src/utils/file.ts`. Add JSDoc to every export. Keep all logic identical.

- [ ] **Create `src/shared/utils/ip.ts`** — Move `extractClientIp` from `src/utils/ip.ts`. Add JSDoc.

- [ ] **Create `src/shared/utils/retry.ts`** — Move all exports from `src/utils/retry.ts`. Add JSDoc.

- [ ] **Create `src/shared/utils/zip.ts`** — Move all exports from `src/utils/zip.ts`. Add JSDoc.

- [ ] **Run existing tests to verify**

```bash
bun test test/rateLimit.test.ts
bun test test/file.test.ts
bun test test/zip.test.ts
```
Expected: PASS

- [ ] **Commit**

```bash
git add src/shared/utils/
git commit -m "feat: create shared utilities layer with JSDoc"
```

---

### Phase 2: Domain Layer — Entities + Ports

#### Task 5: Create domain/entities (File, Bucket, FilePart, Multipart)

**Files:**
- Create: `src/domain/entities/file.ts`
- Create: `src/domain/entities/bucket.ts`
- Create: `src/domain/entities/file-part.ts`
- Create: `src/domain/entities/multipart.ts`

**Interfaces:**
- Produces: `File`, `NewFile`, `FilePart`, `NewFilePart`, `Bucket`, `MultipartUpload`, `MultipartPart` types

- [ ] **Create `src/domain/entities/file.ts`** — Re-export `File` and `NewFile` types from Drizzle schema. Add domain JSDoc.

```typescript
// Re-export Drizzle types as domain entities
export type { File, NewFile } from '../../infrastructure/persistence/drizzle/schema';
```

Wait — this creates a circular dependency! Domain shouldn't import from infrastructure. Instead, define standalone interfaces:

```typescript
/**
 * Core domain entity representing a file stored in Telegram.
 * Contains both Telegram metadata and optional S3-compatible fields.
 */
export interface File {
  id: string;
  publicId: string;
  telegramFileId: string;
  telegramFileUniqueId: string;
  storageChatId: number;
  storageMessageId: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  fileType: string;
  uploaderId: number;
  fileHash: string | null;
  archiveTelegramFileId: string | null;
  archiveStorageMessageId: number | null;
  archiveFileName: string | null;
  archiveEntryName: string | null;
  archiveMimeType: string | null;
  archiveSizeBytes: number | null;
  bucketId: string | null;
  s3Key: string | null;
  storageBackend: string | null;
  isDeleted: boolean | null;
  multipartUploadId: string | null;
  partCount: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewFile = Omit<File, 'id' | 'createdAt' | 'updatedAt'>;
```

- [ ] **Create `src/domain/entities/bucket.ts`** — Standalone Bucket interface.

- [ ] **Create `src/domain/entities/file-part.ts`** — Standalone FilePart + NewFilePart types with `CompressionAlgorithm`.

- [ ] **Create `src/domain/entities/multipart.ts`** — Standalone MultipartUpload, MultipartPart types.

- [ ] **Compile check**

```bash
bun build src/domain/entities/file.ts --target=bun --outfile=/dev/null 2>&1 | head -5
```
Expected: No errors

- [ ] **Commit**

```bash
git add src/domain/entities/
git commit -m "feat: create domain entities with JSDoc"
```

#### Task 6: Create domain/ports (repository interfaces)

**Files:**
- Create: `src/domain/ports/file-repository.ts`
- Create: `src/domain/ports/bucket-repository.ts`
- Create: `src/domain/ports/file-part-repository.ts`
- Create: `src/domain/ports/multipart-repository.ts`

**Interfaces:**
- Produces: `IFileRepository`, `IBucketRepository`, `IFilePartRepository`, `IMultipartRepository`, `ITelegramService`, `S3FileRecord`, `CompressionAlgorithm`

- [ ] **Create `src/domain/ports/file-repository.ts`** — Define interface for all file operations currently in `db/files.ts` and `db/files-ext.ts`.

```typescript
import type { File, NewFile } from '../entities/file';

export interface S3FileRecord extends File {
  bucketId: string;
  s3Key: string;
}

export interface IFileRepository {
  findByHash(hash: string): Promise<File | null>;
  findByPublicId(publicId: string): Promise<File | null>;
  findByUniqueId(telegramFileUniqueId: string): Promise<File | null>;
  findByBucketAndKey(bucketId: string, s3Key: string): Promise<File | null>;
  create(file: NewFile): Promise<File>;
  listByPrefix(
    bucketId: string,
    prefix: string,
    delimiter: string | null,
    maxKeys: number,
    startAfter: string | null,
  ): Promise<{ objects: S3FileRecord[]; prefixes: string[] }>;
  softDelete(bucketId: string, s3Key: string): Promise<boolean>;
  softDeleteBatch(bucketId: string, keys: string[]): Promise<number>;
  countByBucket(bucketId: string): Promise<number>;
  findOrphansByBucket(bucketId: string): Promise<File[]>;
}
```

- [ ] **Create `src/domain/ports/bucket-repository.ts`** — Interface for bucket CRUD.

- [ ] **Create `src/domain/ports/file-part-repository.ts`** — Interface for file parts operations.

- [ ] **Create `src/domain/ports/multipart-repository.ts`** — Interface for multipart upload operations.

- [ ] **Create `src/domain/ports/telegram-service.ts`** — Interface for Telegram operations.

```typescript
/** Result of forwarding a file to Telegram storage */
export interface ForwardResult {
  telegramFileId: string;
  telegramFileUniqueId: string;
  storageMessageId: number;
}

/** File information returned by Telegram's getFile API */
export interface TelegramFileInfo {
  file_size: number;
  mime_type: string;
  file_path: string;
  bot_token: string;
}

/** Abstraction over Telegram bot API operations */
export interface ITelegramService {
  forwardToStorage(fileChunk: unknown, fileName: string, fileType: string): Promise<ForwardResult>;
  getFileInfo(telegramFileId: string): Promise<TelegramFileInfo>;
  enqueueUpload<T>(task: () => Promise<T>): Promise<T>;
}
```

- [ ] **Compile check**

```bash
bun build src/domain/ports/file-repository.ts --target=bun --outfile=/dev/null 2>&1
bun build src/domain/ports/telegram-service.ts --target=bun --outfile=/dev/null 2>&1
```
Expected: No errors (domain has no infrastructure dependencies)

- [ ] **Commit**

```bash
git add src/domain/ports/
git commit -m "feat: create domain port interfaces with JSDoc"
```

---

### Phase 3: Infrastructure Layer — Persistence, Telegram, Cache

#### Task 7: Create infrastructure/persistence/drizzle (DB init, schema, migrate)

**Files:**
- Create: `src/infrastructure/persistence/drizzle/index.ts`
- Create: `src/infrastructure/persistence/drizzle/schema.ts`
- Create: `src/infrastructure/persistence/drizzle/migrate.ts`

**Interfaces:**
- Consumes: domain entities (for type alignment)
- Produces: `db` client, `files`, `fileParts` table definitions, `runMigration()`, Drizzle schema types

- [ ] **Create `src/infrastructure/persistence/drizzle/index.ts`** — Move content from `src/db/index.ts`. Same implementation. Add JSDoc to exports.

- [ ] **Create `src/infrastructure/persistence/drizzle/schema.ts`** — Move content from `src/db/schema.ts`. Same implementation. Add JSDoc to table definitions and exported types.

- [ ] **Create `src/infrastructure/persistence/drizzle/migrate.ts`** — Move content from `src/db/migrate.ts`. Same implementation. Add JSDoc.

- [ ] **Compile check**

```bash
bun build src/infrastructure/persistence/drizzle/index.ts --target=bun --outfile=/dev/null 2>&1 | head -10
```
Expected: No errors

- [ ] **Commit**

```bash
git add src/infrastructure/persistence/drizzle/
git commit -m "feat: create persistence drizzle layer"
```

#### Task 8: Create infrastructure/persistence/repositories (implement ports)

**Files:**
- Create: `src/infrastructure/persistence/repositories/file-repository.ts`
- Create: `src/infrastructure/persistence/repositories/bucket-repository.ts`
- Create: `src/infrastructure/persistence/repositories/file-part-repository.ts`
- Create: `src/infrastructure/persistence/repositories/multipart-repository.ts`

**Interfaces:**
- Consumes: `IFileRepository`, `IBucketRepository`, `IFilePartRepository`, `IMultipartRepository` from domain/ports
- Produces: Concrete repository classes implementing each interface

- [ ] **Create `src/infrastructure/persistence/repositories/file-repository.ts`** — Implement `IFileRepository` using Drizzle. Extract logic from `src/db/files.ts` and `src/db/files-ext.ts`. Methods delegate to Drizzle queries (same SQL as original).

```typescript
import { eq, and, sql } from 'drizzle-orm';
import { db, files as fileSchema } from '../drizzle/index';
import type { File, NewFile } from '../../../domain/entities/file';
import type { IFileRepository, S3FileRecord } from '../../../domain/ports/file-repository';

export class DrizzleFileRepository implements IFileRepository {
  async findByHash(hash: string): Promise<File | null> {
    const result = await db.select().from(fileSchema).where(eq(fileSchema.fileHash, hash)).limit(1);
    return result[0] || null;
  }
  // ... all methods from original files.ts + files-ext.ts
}
```

- [ ] **Create `src/infrastructure/persistence/repositories/bucket-repository.ts`** — Implement `IBucketRepository` from `src/db/buckets.ts`.

- [ ] **Create `src/infrastructure/persistence/repositories/file-part-repository.ts`** — Implement `IFilePartRepository` from `src/db/file-parts.ts`.

- [ ] **Create `src/infrastructure/persistence/repositories/multipart-repository.ts`** — Implement `IMultipartRepository` from `src/db/multipart.ts`.

- [ ] **Compile check**

```bash
bun build src/infrastructure/persistence/repositories/file-repository.ts --target=bun --outfile=/dev/null 2>&1 | head -10
```
Expected: No errors

- [ ] **Commit**

```bash
git add src/infrastructure/persistence/repositories/
git commit -m "feat: create Drizzle repository implementations"
```

#### Task 9: Create infrastructure/telegram (bot-pool, queue, batcher, chunked-storage)

**Files:**
- Create: `src/infrastructure/telegram/types.ts`
- Create: `src/infrastructure/telegram/bot-pool.ts`
- Create: `src/infrastructure/telegram/upload-queue.ts`
- Create: `src/infrastructure/telegram/upload-batcher.ts`
- Create: `src/infrastructure/telegram/chunked-storage.ts`

**Interfaces:**
- Consumes: `ITelegramService`, `IFilePartRepository`, `IFileRepository` from domain/ports
- Produces: `DrizzleFileRepository`, `BotPool`, etc.

- [ ] **Create `src/infrastructure/telegram/types.ts`** — Extract Telegram-specific types from `src/utils/telegram.ts` (no longer inline).

- [ ] **Create `src/infrastructure/telegram/bot-pool.ts`** — Move multi-bot pool + retry logic from `src/utils/telegram.ts`. Implement `ITelegramService` interface. Add JSDoc.

- [ ] **Create `src/infrastructure/telegram/upload-queue.ts`** — Move P-Queue wrapper from `src/utils/telegramQueue.ts`. Add JSDoc.

- [ ] **Create `src/infrastructure/telegram/upload-batcher.ts`** — Move batch upload logic from `src/utils/uploadBatcher.ts`. Add JSDoc. Accept repository interface instead of importing `db` directly.

- [ ] **Create `src/infrastructure/telegram/chunked-storage.ts`** — Move chunked storage logic from `src/utils/chunked-storage.ts`. Accept repository interfaces. Add JSDoc.

- [ ] **Compile check**

```bash
bun build src/infrastructure/telegram/bot-pool.ts --target=bun --outfile=/dev/null 2>&1 | head -10
bun build src/infrastructure/telegram/upload-batcher.ts --target=bun --outfile=/dev/null 2>&1 | head -10
```
Expected: No errors

- [ ] **Commit**

```bash
git add src/infrastructure/telegram/
git commit -m "feat: create infrastructure telegram layer"
```

#### Task 10: Create infrastructure/cache

**Files:**
- Create: `src/infrastructure/cache/index.ts`

**Interfaces:**
- Produces: `Cache<T>`, `fileInfoCache` singleton

- [ ] **Create `src/infrastructure/cache/index.ts`** — Move generic TTL cache from `src/utils/cache.ts`. Add JSDoc. Same implementation.

- [ ] **Compile check**

```bash
bun build src/infrastructure/cache/index.ts --target=bun --outfile=/dev/null 2>&1 | head -5
```
Expected: No errors

- [ ] **Commit**

```bash
git add src/infrastructure/cache/
git commit -m "feat: create infrastructure cache layer"
```

---

### Phase 4: Application Layer — DTOs + Use Cases

#### Task 11: Create application/dto

**Files:**
- Create: `src/application/dto/upload.ts`
- Create: `src/application/dto/file.ts`
- Create: `src/application/dto/bucket.ts`
- Create: `src/application/dto/s3.ts`
- Create: `src/application/dto/auth.ts`

**Interfaces:**
- Produces: `UploadInput`, `UploadOutput`, `FileInfoResponse`, `BucketResponse`, `S3ObjectResponse`, `AuthSession`, etc.

- [ ] **Create `src/application/dto/upload.ts`** — Define upload request/response DTOs.

```typescript
/** Input for the upload file use case */
export interface UploadInput {
  tempPath: string;
  fileHash: string;
  fileName: string;
  mimeType: string;
  fileType: string;
  sizeBytes: number;
  uploaderId?: number;
  bucketId?: string | null;
  s3Key?: string | null;
}

/** Output from the upload file use case */
export interface UploadOutput {
  publicId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  fileType: string;
  createdAt: Date;
  downloadUrl: string;
}
```

- [ ] **Create `src/application/dto/file.ts`** — File info response DTOs.

- [ ] **Create `src/application/dto/bucket.ts`** — Bucket CRUD DTOs.

- [ ] **Create `src/application/dto/s3.ts`** — S3 operation DTOs (list, copy, multipart).

- [ ] **Create `src/application/dto/auth.ts`** — Auth request/response DTOs (login input, session info).

- [ ] **Compile check**

```bash
bun build src/application/dto/upload.ts --target=bun --outfile=/dev/null 2>&1 | head -5
```
Expected: No errors

- [ ] **Commit**

```bash
git add src/application/dto/
git commit -m "feat: create application DTOs"
```

#### Task 12: Create application/use-cases (upload, get-file, auth)

**Files:**
- Create: `src/application/use-cases/upload-file.ts`
- Create: `src/application/use-cases/get-file.ts`
- Create: `src/application/use-cases/authenticate.ts`

**Interfaces:**
- Consumes: Repository interfaces from domain/ports, DTOs from application/dto
- Produces: Factory functions returning use case closures

- [ ] **Create `src/application/use-cases/upload-file.ts`** — Extract upload business logic from `src/routes/upload.ts` + `src/utils/chunked-storage.ts`. Factory function pattern:

```typescript
import { nanoid } from 'nanoid';
import type { IFileRepository } from '../../domain/ports/file-repository';
import type { IFilePartRepository } from '../../domain/ports/file-part-repository';
import type { ITelegramService } from '../../domain/ports/telegram-service';
import type { AppConfig } from '../../config/index';
import type { UploadInput, UploadOutput } from '../dto/upload';

export interface UploadFileUseCaseDeps {
  fileRepo: IFileRepository;
  filePartRepo: IFilePartRepository;
  telegramService: ITelegramService;
  config: AppConfig;
}

export function createUploadFileUseCase(deps: UploadFileUseCaseDeps) {
  return async (input: UploadInput): Promise<UploadOutput> => {
    // 1. Check dedup (fileRepo.findByHash)
    // 2. Check file size limits
    // 3. Determine storage strategy: chunked vs single vs batch
    // 4. Store via telegramService
    // 5. Insert DB record via fileRepo
    // 6. Build and return UploadOutput
  };
}
```

- [ ] **Create `src/application/use-cases/get-file.ts`** — Extract file redirect/stream logic from `src/routes/files.ts`.

- [ ] **Create `src/application/use-cases/authenticate.ts`** — Extract login/logout/session logic from `src/routes/auth.ts` + `src/utils/auth.ts`.

- [ ] **Compile check**

```bash
bun build src/application/use-cases/upload-file.ts --target=bun --outfile=/dev/null 2>&1 | head -15
```
Expected: No errors (may have non-functional code until controllers wired up — skip if not compile-ready)

- [ ] **Commit**

```bash
git add src/application/use-cases/authenticate.ts src/application/use-cases/upload-file.ts src/application/use-cases/get-file.ts
git commit -m "feat: create application use cases (upload, get-file, auth)"
```

#### Task 13: Create application/use-cases (bucket, s3-object, multipart)

**Files:**
- Create: `src/application/use-cases/manage-bucket.ts`
- Create: `src/application/use-cases/s3-object.ts`
- Create: `src/application/use-cases/multipart-upload.ts`

**Interfaces:**
- Consumes: Repository interfaces from domain/ports, DTOs from application/dto
- Produces: Factory functions for bucket CRUD, S3 object ops, multipart upload

- [ ] **Create `src/application/use-cases/manage-bucket.ts`** — Extract bucket CRUD logic from `src/routes/web-api.ts` + `src/routes/s3.ts`.

- [ ] **Create `src/application/use-cases/s3-object.ts`** — Extract S3 get/put/delete/copy logic from `src/routes/s3.ts`. This is the biggest extraction.

- [ ] **Create `src/application/use-cases/multipart-upload.ts`** — Extract S3 multipart upload logic from `src/routes/s3.ts`.

- [ ] **Commit**

```bash
git add src/application/use-cases/manage-bucket.ts src/application/use-cases/s3-object.ts src/application/use-cases/multipart-upload.ts
git commit -m "feat: create application use cases (bucket, s3-object, multipart)"
```

---

### Phase 5: Interfaces Layer — Controllers, Middleware, Routes, S3, Bot

#### Task 14: Create interfaces/s3 protocol files

**Files:**
- Create: `src/interfaces/s3/auth.ts`
- Create: `src/interfaces/s3/headers.ts`
- Create: `src/interfaces/s3/object-stream.ts`
- Create: `src/interfaces/s3/range.ts`
- Create: `src/interfaces/s3/virtual-host.ts`
- Create: `src/interfaces/s3/xml.ts`

**Interfaces:**
- Produces: SigV4 auth, S3 headers, object streaming, range parsing, virtual-host extraction, XML builders — all same as `src/utils/s3/*`

- [ ] **Create each file** — Move content from `src/utils/s3/auth.ts`, `src/utils/s3/headers.ts`, etc. Add JSDoc to each exported function. Same implementations.

- [ ] **Compile check**

```bash
bun build src/interfaces/s3/auth.ts --target=bun --outfile=/dev/null 2>&1 | head -5
```
Expected: No errors

- [ ] **Commit**

```bash
git add src/interfaces/s3/
git commit -m "feat: create interfaces/s3 protocol layer"
```

#### Task 15: Create HTTP middleware (auth, rate-limit)

**Files:**
- Create: `src/interfaces/http/middleware/auth.ts`
- Create: `src/interfaces/http/middleware/rate-limit.ts`

**Interfaces:**
- Produces: `requireAuth`, `getAuthSession`, `withRateLimit`, `checkRateLimit`, `cleanupRateLimitCache`

- [ ] **Create `src/interfaces/http/middleware/auth.ts`** — Move auth middleware from `src/utils/auth.ts`. Update imports to use `config` from `../../config/index`. Add JSDoc.

- [ ] **Create `src/interfaces/http/middleware/rate-limit.ts`** — Move rate limiter from `src/utils/rateLimit.ts`. Add JSDoc.

- [ ] **Compile check**

```bash
bun build src/interfaces/http/middleware/auth.ts --target=bun --outfile=/dev/null 2>&1 | head -10
```
Expected: No errors

- [ ] **Commit**

```bash
git add src/interfaces/http/middleware/
git commit -m "feat: create HTTP middleware layer"
```

#### Task 16: Create HTTP controllers

**Files:**
- Create: `src/interfaces/http/controllers/upload-controller.ts`
- Create: `src/interfaces/http/controllers/file-controller.ts`
- Create: `src/interfaces/http/controllers/auth-controller.ts`
- Create: `src/interfaces/http/controllers/home-controller.ts`
- Create: `src/interfaces/http/controllers/health-controller.ts`
- Create: `src/interfaces/http/controllers/s3-controller.ts`
- Create: `src/interfaces/http/controllers/web-api-controller.ts`

**Interfaces:**
- Consumes: Use case factory functions from application layer
- Produces: HTTP handler functions compatible with `Bun.serve()` routes

- [ ] **Create `src/interfaces/http/controllers/upload-controller.ts`** — Extract upload HTTP handling from `src/routes/upload.ts`. Controller parses request, calls use case, formats response:

```typescript
import { createUploadFileUseCase } from '../../../application/use-cases/upload-file';
// ... setup use case with dependencies
// ... handler functions for multipart and JSON upload paths
```

- [ ] **Create `src/interfaces/http/controllers/file-controller.ts`** — Extract from `src/routes/files.ts`. Controller handles params, calls getFile use case, handles redirect/stream.

- [ ] **Create `src/interfaces/http/controllers/auth-controller.ts`** — Extract from `src/routes/auth.ts`.

- [ ] **Create `src/interfaces/http/controllers/home-controller.ts`** — Move from `src/routes/home.ts`.

- [ ] **Create `src/interfaces/http/controllers/health-controller.ts`** — Move from `src/routes/health.ts`.

- [ ] **Create `src/interfaces/http/controllers/s3-controller.ts`** — Extract S3 dispatching from `src/routes/s3.ts`. This is the largest extraction — split into clear sections (bucket ops, object ops, multipart ops). The 1179-line file becomes a focused controller that delegates to use cases.

- [ ] **Create `src/interfaces/http/controllers/web-api-controller.ts`** — Extract from `src/routes/web-api.ts`.

- [ ] **Move `src/home.html` to `src/interfaces/http/controllers/home.html`** — Update reference in home-controller.

- [ ] **Commit**

```bash
git add src/interfaces/http/controllers/
git commit -m "feat: create HTTP controller layer"
```

#### Task 17: Create HTTP route definitions

**Files:**
- Create: `src/interfaces/http/routes/index.ts`

**Interfaces:**
- Consumes: All controller handler functions
- Produces: Route table for `Bun.serve()`

- [ ] **Create `src/interfaces/http/routes/index.ts`** — Define route table matching current `src/index.ts` routes. Each route maps to its controller handler. Add JSDoc.

```typescript
import type { Server } from 'bun';
import { handleUpload } from '../controllers/upload-controller';
import { handleFileRedirect, handleFileInfo } from '../controllers/file-controller';
// ... other imports

/** Defines all HTTP routes for the application */
export const routes: Server['routes'] = {
  '/api/upload': { POST: handleUpload },
  '/f/:public_id': { GET: handleFileRedirect },
  '/file/:public_id/info': { GET: handleFileInfo },
  '/health': { GET: handleHealth },
  '/docs': { GET: handleSwaggerHtml },
  '/swagger.json': { GET: handleSwaggerJson },
  // ... etc
};
```

- [ ] **Commit**

```bash
git add src/interfaces/http/routes/
git commit -m "feat: create HTTP route definitions"
```

#### Task 18: Create interfaces/bot

**Files:**
- Create: `src/interfaces/bot/handler.ts`

**Interfaces:**
- Consumes: `ITelegramService`, use cases
- Produces: `startBot()` function for Telegram bot lifecycle

- [ ] **Create `src/interfaces/bot/handler.ts`** — Move bot handler logic from `src/bot.ts`. Add JSDoc. Update imports to use new structure.

- [ ] **Commit**

```bash
git add src/interfaces/bot/
git commit -m "feat: create bot interface layer"
```

---

### Phase 6: Entry Point Rewire

#### Task 19: Rewrite src/index.ts

**Files:**
- Modify: `src/index.ts`
- Modify (delete): `src/bot.ts`

- [ ] **Rewrite `src/index.ts`** — Update to import from new structure. Server bootstrap, S3 detection, route table from `interfaces/http/routes/index`, lifecycle management.

```typescript
import { serve } from 'bun';
import { config } from './config/index';
import { startBot } from './interfaces/bot/handler';
import { routes } from './interfaces/http/routes/index';
import { isS3Request } from './interfaces/s3/auth';
import { handleS3Request } from './interfaces/http/controllers/s3-controller';
import { extractS3BucketFromHost } from './interfaces/s3/virtual-host';
import { fileInfoCache } from './infrastructure/cache/index';
import { cleanupRateLimitCache } from './interfaces/http/middleware/rate-limit';
import { logger } from './shared/logger/index';
import { metricsCollector } from './shared/metrics/index';
```

- [ ] **Remove `src/bot.ts`** (replaced by `src/interfaces/bot/handler.ts`)

- [ ] **Run full test suite**

```bash
bun test
```
Expected: All tests PASS (old src files still exist for backward compat)

- [ ] **Commit**

```bash
git add src/index.ts src/interfaces/bot/handler.ts
git rm src/bot.ts
git commit -m "feat: rewire entry point to new architecture"
```

---

### Phase 7: Test Restructure

#### Task 20: Create mirror test structure

**Files:**
- Create: `test/unit/domain/entities/` (entity type tests)
- Create: `test/unit/application/use-cases/` (use case tests)
- Create: `test/unit/shared/` (util tests)
- Create: `test/integration/interfaces/http/` (route tests)
- Create: `test/integration/infrastructure/` (repo tests)

- [ ] **Create test folder structure mirroring src/**

```bash
mkdir -p test/unit/domain/entities \
  test/unit/application/use-cases \
  test/unit/shared \
  test/integration/interfaces/http \
  test/integration/infrastructure/persistence \
  test/integration/infrastructure/telegram
```

- [ ] **Move util tests** — Copy `test/env.test.ts` → `test/unit/config/env.test.ts`, update import path to `src/config/index`. Copy `test/file.test.ts` → `test/unit/shared/file.test.ts`, update imports. Copy `test/zip.test.ts` → `test/unit/shared/zip.test.ts`.

- [ ] **Move route tests** — Copy `test/upload.test.ts` → `test/integration/interfaces/http/upload.test.ts`, update imports. Copy `test/files.test.ts` → `test/integration/interfaces/http/files.test.ts`. Copy `test/auth-routes.test.ts`, `test/health.test.ts`, `test/swagger.test.ts`.

- [ ] **Move S3 tests** — Copy `test/s3-auth.test.ts` → `test/unit/interfaces/s3/auth.test.ts`. Copy `test/s3-range.test.ts`, `test/s3-operations.test.ts`, `test/s3-bucket-config.test.ts`, `test/s3-object-stream.test.ts`.

- [ ] **Move infrastructure tests** — Copy `test/db.test.ts` → `test/unit/infrastructure/persistence/drizzle/schema.test.ts`. Copy `test/chunked-storage.test.ts` → `test/unit/infrastructure/telegram/chunked-storage.test.ts`. Copy `test/telegram.test.ts`, `test/telegramQueue.test.ts`.

- [ ] **Keep original test files** — Do NOT delete them yet. Original tests still reference old source paths and need to keep passing for now.

- [ ] **Update test runner scripts in package.json** — Add test patterns for new test locations:

```json
"test:new": "bun test test/unit/ test/integration/",
"test:all": "bun test && bun test test/unit/ test/integration/"
```

- [ ] **Run both old and new tests**

```bash
bun test test/env.test.ts
bun test test/unit/config/env.test.ts
```
Expected: Both PASS

- [ ] **Commit**

```bash
git add test/unit/ test/integration/ package.json
git commit -m "test: restructure tests to mirror new architecture"
```

---

### Phase 8: Cleanup — Delete Old Files

#### Task 21: Remove old source directories

**Files:** Delete old source directories once new structure is verified.

- [ ] **Delete old directories** (only after all tests pass with new imports)

```bash
rm -rf src/db src/routes src/utils src/env.ts src/bot.ts
```

- [ ] **Run full test suite to confirm nothing is broken**

```bash
bun test
bun test test/unit/ test/integration/
```
Expected: All PASS

- [ ] **Commit**

```bash
git rm -r src/db src/routes src/utils src/env.ts src/bot.ts
git commit -m "chore: remove legacy source directories after migration"
```

#### Task 22: Final verification

- [ ] **Full test suite**

```bash
bun run test:all
```
Expected: All PASS

- [ ] **Build verification**

```bash
bun run build
```
Expected: dist/index.js and dist/migrate.js compile without errors

- [ ] **Lint check**

```bash
bunx biome check src test/unit test/integration
```
Expected: No errors

- [ ] **Final commit** if any fixes were needed

```bash
git add -A
git commit -m "chore: final cleanup after architecture migration"
```

---

## Spec Coverage Check

| Spec Requirement | Covered In |
|-----------------|------------|
| New folder structure | Task 5-19 (all phases) |
| DDD layers | Phase 2 (domain), Phase 4 (application), Phase 3 (infrastructure), Phase 5 (interfaces) |
| Repository interfaces | Task 6 |
| Repository implementations | Task 8 |
| Controller/use-case separation | Task 12-13 (use cases), Task 16 (controllers) |
| Dependency injection (factory functions) | Task 12 |
| Telegram service interface | Task 6 (ITelegramService port) |
| Bot moved to interfaces/bot | Task 18 |
| S3 protocol moved to interfaces/s3 | Task 14 |
| Config moved to config/ | Task 1 |
| Shared utilities moved to shared/ | Task 2-4 |
| Error classes | Task 2 |
| JSDoc on all exports | All creation tasks |
| Test restructure | Task 20 |
| Zero behavior changes | No logic altered — only moved/extracted |
| Delete old files | Task 21 |
| Final verification | Task 22 |
