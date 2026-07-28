# DDD & Clean Architecture Restructure — TeleUploader (filedrop)

**Date:** 2026-07-28
**Author:** Claude
**Status:** Draft

## 1. Motivation

The current codebase uses a flat structure (`src/routes/`, `src/utils/`, `src/db/`) that mixes concerns:

- Route handlers contain inline DB queries, Telegram API calls, and business logic
- Domain entity types (from Drizzle ORM) leak into all layers
- No clear separation between HTTP concerns, application logic, and infrastructure
- Large files (`routes/s3.ts` at 1179 lines) are hard to maintain, test, and reason about

The goal is to restructure into **Domain-Driven Design (DDD)** with **Clean Architecture** principles, adding **JSDoc documentation** throughout, without changing behaviour or breaking existing tests.

## 2. Approach: Hybrid C

| Aspect | Decision |
|--------|----------|
| **Depth** | Structural DDD + repository abstraction + controller/use-case separation |
| **Domain entities** | Re-use Drizzle-generated types (pragmatic, not creating new pure domain models) |
| **Dependency inversion** | Repository interfaces defined in `domain/ports/`, implementations in `infrastructure/` |
| **Dependency injection** | Simple factory functions (no DI framework) |
| **Testing** | Test files restructured alongside source files |
| **Documentation** | JSDoc on all public functions, classes, interfaces, and types |
| **Language** | English for code and JSDoc |

## 3. Layer Architecture

```
┌─────────────────────────────────────────────┐
│          interfaces/  (Delivery)             │
│  HTTP controllers, routes, middleware        │
│  Bot handlers                                │
│  S3 protocol (SigV4, XML, range, stream)     │
├─────────────────────────────────────────────┤
│          application/  (Use Cases)           │
│  Upload file, get file, auth, bucket ops,    │
│  S3 object ops, multipart upload             │
├────────────────────┬────────────────────────┤
│    domain/         │   infrastructure/      │
│  entities/         │   persistence/         │
│  ports/ (interfaces)│   telegram/           │
│                    │   cache/               │
├────────────────────┴────────────────────────┤
│           config/ + shared/                  │
└─────────────────────────────────────────────┘
```

**Dependency Rule:** Outer layers depend on inner layers, never the reverse. Domain knows nothing about HTTP, Drizzle, or Telegram.

## 4. Full Directory Structure

```
src/
├── index.ts                           # Entry point: server bootstrap, lifecycle
├── domain/
│   ├── entities/
│   │   ├── file.ts                    # File entity type (re-export from drizzle)
│   │   ├── bucket.ts                  # Bucket entity type
│   │   ├── file-part.ts               # FilePart entity type
│   │   └── multipart.ts               # MultipartUpload, MultipartPart types
│   └── ports/
│       ├── file-repository.ts         # IFileRepository interface
│       ├── bucket-repository.ts       # IBucketRepository interface
│       ├── file-part-repository.ts    # IFilePartRepository interface
│       └── multipart-repository.ts    # IMultipartRepository interface
├── application/
│   ├── dto/
│   │   ├── upload.ts                  # Upload request/response DTOs
│   │   ├── file.ts                    # File response DTOs
│   │   ├── bucket.ts                  # Bucket DTOs
│   │   ├── s3.ts                      # S3 operation DTOs
│   │   └── auth.ts                    # Auth DTOs
│   └── use-cases/
│       ├── upload-file.ts             # Upload logic (multipart, JSON base64)
│       ├── get-file.ts                # File redirect/stream logic
│       ├── manage-bucket.ts            # Bucket CRUD logic
│       ├── s3-object.ts               # S3 get/put/delete/copy logic
│       ├── multipart-upload.ts        # S3 multipart upload logic
│       └── authenticate.ts            # Login/logout/session logic
├── infrastructure/
│   ├── persistence/
│   │   ├── drizzle/
│   │   │   ├── index.ts               # DB client + Drizzle init (from db/index.ts)
│   │   │   └── schema.ts              # Drizzle table definitions (from db/schema.ts)
│   │   │   └── migrate.ts             # Migration runner (from db/migrate.ts)
│   │   └── repositories/
│   │       ├── file-repository.ts     # IFileRepository implementation (Drizzle)
│   │       ├── bucket-repository.ts   # IBucketRepository implementation
│   │       ├── file-part-repository.ts# IFilePartRepository implementation
│   │       └── multipart-repository.ts# IMultipartRepository implementation
│   ├── telegram/
│   │   ├── bot-pool.ts                # Multi-bot pool + retry (from utils/telegram.ts)
│   │   ├── upload-queue.ts            # P-Queue wrapper (from utils/telegramQueue.ts)
│   │   ├── upload-batcher.ts          # Batch upload (from utils/uploadBatcher.ts)
│   │   ├── chunked-storage.ts         # Chunked file storage (from utils/chunked-storage.ts)
│   │   └── types.ts                   # Telegram-related types
│   └── cache/
│       └── index.ts                   # Generic TTL cache (from utils/cache.ts)
├── interfaces/
│   ├── http/
│   │   ├── controllers/
│   │   │   ├── upload-controller.ts   # Upload HTTP handler
│   │   │   ├── file-controller.ts     # File redirect + info handler
│   │   │   ├── auth-controller.ts     # Login/logout/me handler
│   │   │   ├── home-controller.ts     # Home dashboard handler
│   │   │   ├── health-controller.ts   # Health check handler
│   │   │   ├── s3-controller.ts       # S3-compatible API handler
│   │   │   └── web-api-controller.ts  # JSON REST API handler
│   │   ├── middleware/
│   │   │   ├── auth.ts                # requireAuth, getAuthSession
│   │   │   └── rate-limit.ts          # Rate limiter
│   │   └── routes/
│   │       └── index.ts               # All route definitions
│   ├── bot/
│   │   └── handler.ts                 # Telegram bot event handlers (from bot.ts)
│   └── s3/
│       ├── auth.ts                    # SigV4 verification (from utils/s3/auth.ts)
│       ├── headers.ts                 # CORS/response headers
│       ├── object-stream.ts            # Part streaming for GetObject
│       ├── range.ts                   # HTTP Range header parser
│       ├── virtual-host.ts            # Virtual-hosted bucket extraction
│       └── xml.ts                     # S3 XML response builders/parsers
├── config/
│   └── index.ts                       # Environment config (from env.ts)
├── shared/
│   ├── errors/
│   │   └── index.ts                   # Domain + application error classes
│   ├── logger/
│   │   └── index.ts                   # Winston logger (from utils/logger.ts)
│   ├── metrics/
│   │   └── index.ts                   # Metrics collector (from utils/metrics.ts)
│   └── utils/
│       ├── file.ts                    # File type, MIME, hash, extension (from utils/file.ts)
│       ├── ip.ts                      # Client IP extraction (from utils/ip.ts)
│       ├── retry.ts                   # Retry/timeout/fallback (from utils/retry.ts)
│       └── zip.ts                     # ZIP create/extract (from utils/zip.ts)
```

## 5. Dependency Injection Pattern

No DI framework. Use-case factories accept repository interfaces:

```typescript
// domain/ports/file-repository.ts
export interface IFileRepository {
  findByHash(hash: string): Promise<File | null>;
  findByPublicId(publicId: string): Promise<File | null>;
  findByUniqueId(uniqueId: string): Promise<File | null>;
  findByBucketAndKey(bucketId: string, key: string): Promise<File | null>;
  create(file: NewFile): Promise<File>;
  softDelete(bucketId: string, key: string): Promise<boolean>;
  listByPrefix(...): Promise<{ objects: File[]; prefixes: string[] }>;
}

// application/use-cases/upload-file.ts
export function createUploadFileUseCase(repos: {
  fileRepo: IFileRepository;
  filePartRepo: IFilePartRepository;
  telegramService: ITelegramService;
  config: AppConfig;
}) {
  return async (input: UploadInput): Promise<UploadOutput> => {
    // business logic here, using repos.xxx() not db directly
  };
}
```

This keeps use cases testable — inject mock repositories in tests.

## 6. Controller / Use-Case Boundary

**Controller responsibilities:**
- Parse HTTP request (body, params, headers)
- Call use case
- Format HTTP response

**Use case responsibilities:**
- Business logic (file size checks, dedup, chunking decisions)
- Orchestrate infrastructure calls (Telegram, DB, cache)
- Return DTOs

**Example flow for upload:**
```
UploadController.handleUpload(req)
  → parse multipart form data
  → write to temp file
  → call uploadFileUseCase({ tempPath, fileName, mimeType, ... })
      → check dedup (fileRepo.findByHash)
      → check file size limits
      → if chunked: telegramService.uploadChunks(...), filePartRepo.create(...)
      → if batch: telegramService.enqueueBatch(...)
      → fileRepo.create(...)
      → return UploadOutput
  → format response (buildUploadResponse)
  → return Response
```

## 7. Migration Strategy

The restructure will be done in one pass per layer, with tests updated in lockstep:

1. Create new folder structure
2. Move `shared/` utilities first (no dependencies on other layers)
3. Move `config/`
4. Move `domain/` entities + ports
5. Move `infrastructure/` persistence + telegram + cache
6. Move `application/` use cases + DTOs
7. Move `interfaces/` controllers + middleware + routes
8. Update `src/index.ts` entry point
9. Restructure test files matching new layout
10. Run all tests, fix import paths
11. Delete old folders

## 8. Entity Architecture

```
┌──────────────────────────────────────────────┐
│              Domain Layer                     │
│  Entities: File, Bucket, FilePart,            │
│            MultipartUpload, MultipartPart      │
│  Ports: IFileRepository, IBucketRepository,   │
│         IFilePartRepository,                   │
│         IMultipartRepository                   │
├──────────────────────────────────────────────┤
│           Application Layer                    │
│  UploadFileUseCase                             │
│  ├── depends on IFileRepository               │
│  ├── depends on IFilePartRepository            │
│  └── depends on ITelegramService              │
│                                               │
│  S3ObjectUseCase                               │
│  ├── depends on IFileRepository               │
│  ├── depends on IBucketRepository             │
│  ├── depends on IMultipartRepository          │
│  └── depends on ITelegramService              │
└──────────────────────────────────────────────┘
```

## 9. Telegram Service Interface

A new `ITelegramService` interface in `domain/ports/` to abstract Telegram operations:

```typescript
export interface ITelegramService {
  forwardToStorage(fileChunk: unknown, fileName: string, fileType: string): Promise<ForwardResult>;
  getFileInfo(telegramFileId: string): Promise<TelegramFileInfo>;
  enqueueUpload<T>(task: () => Promise<T>): Promise<T>;
}
```

Implementation stays in `infrastructure/telegram/`.

## 10. JSDoc Standards

Every exported function, interface, type, and class gets JSDoc:

```typescript
/**
 * Uploads a file to Telegram storage, handling chunking for large files
 * and batch deduplication for small files.
 *
 * @param input - The prepared upload data and metadata
 * @param input.tempPath - Path to the temporary file on disk
 * @param input.fileName - Display name for the file
 * @param input.mimeType - MIME type of the file
 * @param input.fileType - Telegram file category (document, photo, etc.)
 * @param input.sizeBytes - File size in bytes
 * @returns The stored file entity with Telegram metadata
 * @throws {FileTooLargeError} If file exceeds Telegram size limits
 */
```

## 11. Error Handling

Custom error classes replacing generic `Error` throws:

```typescript
// shared/errors/index.ts
export class DomainError extends Error { constructor(msg: string) { super(msg); this.name = 'DomainError'; } }
export class FileNotFoundError extends DomainError {}
export class BucketNotFoundError extends DomainError {}
export class FileTooLargeError extends DomainError {}
export class DuplicateFileError extends DomainError {}
export class AuthenticationError extends DomainError {}
export class ValidationError extends DomainError {}
```

Use cases throw domain errors. Controllers catch and format HTTP responses.

## 12. Existing Files That Remain Unchanged

Files that are purely structural (no business logic restructuring needed):

| Old Path | New Path |
|----------|----------|
| `src/home.html` | `src/interfaces/http/controllers/home.html` (or alongside home controller) |
| `src/utils/s3/*` | `src/interfaces/s3/*` (moved as-is) |
| `src/db/migrate.ts` | `src/infrastructure/persistence/drizzle/migrate.ts` |

## 13. State After Migration

- **Total source files:** ~60 (was ~30) — more focused files, each with clear responsibility
- **JSDoc coverage:** 100% of exported APIs
- **Test files:** ~24, restructured to mirror source layout
- **Behaviour changes:** Zero. No logic is altered, only moved
- **External interfaces:** All API endpoints, S3 XML formats, and response shapes unchanged
