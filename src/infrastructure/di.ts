/**
 * Dependency Injection container.
 *
 * Wires up singleton instances of all repositories and application services,
 * making them available to controllers and other adapters without requiring
 * a full DI framework.
 *
 * @module infrastructure/di
 */

import type { IBucketRepository } from '../domain/ports/bucket-repository';
import type { IFilePartRepository } from '../domain/ports/file-part-repository';
import type { IFileRepository } from '../domain/ports/file-repository';
import type { IMultipartRepository } from '../domain/ports/multipart-repository';
import type { ITelegramService } from '../domain/ports/telegram-service';
import { DrizzleBucketRepository } from './persistence/repositories/bucket-repository';
import { DrizzleFilePartRepository } from './persistence/repositories/file-part-repository';
import { DrizzleFileRepository } from './persistence/repositories/file-repository';
import { DrizzleMultipartRepository } from './persistence/repositories/multipart-repository';
import { botPool } from './telegram/bot-pool';
import { ChunkedStorage } from './telegram/chunked-storage';

// ─── Repository Singletons ──────────────────────────────────────────

/** Singleton IFileRepository instance backed by Drizzle ORM. */
export const fileRepository: IFileRepository = new DrizzleFileRepository();

/** Singleton IBucketRepository instance backed by Drizzle ORM. */
export const bucketRepository: IBucketRepository = new DrizzleBucketRepository();

/** Singleton IFilePartRepository instance backed by Drizzle ORM. */
export const filePartRepository: IFilePartRepository = new DrizzleFilePartRepository();

/** Singleton IMultipartRepository instance backed by Drizzle ORM. */
export const multipartRepository: IMultipartRepository = new DrizzleMultipartRepository();

/** Singleton ITelegramService instance backed by the bot pool. */
export const telegramService: ITelegramService = botPool;

// ─── Service Singletons ─────────────────────────────────────────────

/** Singleton ChunkedStorage for large file chunked uploads. */
export const chunkedStorage = new ChunkedStorage(
  fileRepository,
  filePartRepository,
  telegramService,
);
