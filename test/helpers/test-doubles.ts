import { mock } from 'bun:test';
import type { ITelegramService } from '../../src/domain/ports/telegram-service';

/**
 * Shared test doubles for the TeleUploader unit test suite.
 *
 * Consolidates the mock patterns that were previously copy-pasted across
 * test files (`MockTelegraf` in bot-pool/bot/telegram tests, stub DI repos
 * in upload/files tests, deterministic nanoid counters in upload tests).
 *
 * Rules:
 * - Import from this module inside individual test files only — never as a
 *   global preload (avoids cross-file mock pollution; see CLAUDE.md).
 * - Prefer `mock.module` with these factories over hand-rolled inline mocks
 *   so behavior stays consistent when the doubles evolve.
 *
 * @module test/helpers/test-doubles
 */

/** Minimal Telegram message result shape used by the MockTelegraf doubles. */
export interface MockTelegramMessage {
  /** Telegram message identifier. */
  message_id: number;
  /** Document payload (present for document uploads). */
  document?: { file_id: string; file_unique_id: string };
  /** Photo payload (present for photo uploads). */
  photo?: Array<{ file_id: string; file_unique_id: string }>;
}

/**
 * Creates a Telegraf mock payload (`mock.module('telegraf', …)` factory).
 *
 * Mirrors the `MockTelegraf` pattern from `bot-pool.test.ts` / `bot.test.ts` /
 * `telegram.test.ts` with controllable per-method implementations.
 *
 * @param overrides - Optional per-method implementations.
 * @returns A `{ Telegraf }` module shape for `mock.module`.
 */
export const mockTelegrafModule = (overrides?: {
  sendDocument?: (chatId: unknown, file: unknown, extra?: unknown) => Promise<MockTelegramMessage>;
  sendPhoto?: (chatId: unknown, file: unknown, extra?: unknown) => Promise<MockTelegramMessage>;
  getFile?: (fileId: string) => Promise<{ file_path?: string }>;
}) => {
  const sendDocument =
    overrides?.sendDocument ??
    (async () => ({
      message_id: 54321,
      document: { file_id: 'document_id', file_unique_id: 'document_unique_id' },
    }));
  const sendPhoto =
    overrides?.sendPhoto ??
    (async () => ({
      message_id: 12345,
      photo: [
        { file_id: 'photo_id_low', file_unique_id: 'unique_id_low' },
        { file_id: 'photo_id_high', file_unique_id: 'unique_id_high' },
      ],
    }));
  const getFile = overrides?.getFile ?? (async () => ({ file_path: 'documents/file.dat' }));

  return {
    Telegraf: class {
      token: unknown;
      telegram: {
        sendDocument: typeof sendDocument;
        sendPhoto: typeof sendPhoto;
        getFile: typeof getFile;
      };

      constructor(token: unknown) {
        this.token = token;
        this.telegram = { sendDocument, sendPhoto, getFile };
      }
    },
  };
};

/**
 * Creates a minimal {@link ITelegramService} stub backed by `bun:test` mocks.
 *
 * Mirrors the hand-rolled stub in `chunked-storage.test.ts` (real
 * `ChunkedStorage` + stub telegram service + no-op repos).
 *
 * @param overrides - Optional per-method implementations.
 * @returns An `ITelegramService` implementation whose methods are mocks.
 */
export const makeTelegramServiceStub = (
  overrides?: Partial<ITelegramService>,
): ITelegramService & {
  forwardToStorage: ReturnType<typeof mock>;
  getFileInfo: ReturnType<typeof mock>;
} => {
  const forwardToStorage = mock(
    overrides?.forwardToStorage ??
      (async (_bytes: unknown, fileName: string) => ({
        telegramFileId: `tg-${fileName}`,
        telegramFileUniqueId: `tg-unique-${fileName}`,
        storageMessageId: 1,
      })),
  );
  const getFileInfo = mock(
    overrides?.getFileInfo ??
      (async (telegramFileId: string) => ({
        file_size: 100,
        mime_type: 'application/octet-stream',
        file_path: 'documents/file.dat',
        bot_token: '123456:ABC-DEF',
        telegramFileId,
      })),
  );
  return {
    forwardToStorage: forwardToStorage as unknown as ITelegramService['forwardToStorage'],
    getFileInfo: getFileInfo as unknown as ITelegramService['getFileInfo'],
  };
};

/**
 * Creates a deterministic `nanoid` module mock — each call returns
 * `prefix-1`, `prefix-2`, … instead of random IDs.
 *
 * Replaces the ad-hoc `mock.module('nanoid')` counters in `upload.test.ts`.
 *
 * @param prefix - Prefix for generated IDs (default `"test-id"`).
 * @returns A `{ nanoid }` module shape for `mock.module`.
 */
export const mockNanoidModule = (prefix = 'test-id') => {
  let counter = 0;
  return {
    nanoid: mock(() => `${prefix}-${++counter}`),
  };
};

/**
 * Builds a signed S3 test request with valid SigV4 headers.
 *
 * Request-signing is covered by `s3-auth.test.ts`; this helper exists for
 * handler-level tests that mock `../src/interfaces/s3/auth` to accept any
 * signature and only need a well-formed request object.
 *
 * @param url - Request URL (path-style `/bucket/key` or `/`).
 * @param init - Optional `RequestInit` overrides (method defaults to GET).
 * @returns A `Request` with stub SigV4 headers.
 */
export const s3TestRequest = (url: string, init?: RequestInit): Request =>
  new Request(url, {
    method: 'GET',
    ...init,
    headers: {
      authorization: 'AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request',
      'x-amz-date': '20260101T000000Z',
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      ...(init?.headers ?? {}),
    },
  });

/** 1x1px JPEG fallback binary (offline-safe fixture, no network fetch). */
export const TINY_JPEG_HEX =
  'ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0b000080100010101011100ffc4001f0000010501010110000000000000000000000102030405060708ffda000c03010002110311003f00a0ffd9';

/**
 * Returns the tiny-JPEG fixture as a `Buffer` without any network access.
 *
 * Replaces the Wikimedia-fetch-with-fallback pattern in `telegram.test.ts`
 * and `upload.test.ts` for tests that only need *some* valid image bytes.
 * Tests that genuinely need a real PNG must stay in quarantine (see
 * `test:quarantine` in package.json).
 *
 * @returns A 1x1px JPEG buffer.
 */
export const tinyJpegBuffer = (): Buffer => Buffer.from(TINY_JPEG_HEX, 'hex');
