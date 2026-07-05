import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { config } from '../src/env';
import logger from '../src/utils/logger';

let realPhotoBuffer: Buffer;

beforeAll(async () => {
  try {
    const res = await fetch(
      'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
    );
    if (!res.ok) throw new Error('Wikimedia download failed');
    const arrayBuffer = await res.arrayBuffer();
    realPhotoBuffer = Buffer.from(arrayBuffer);
  } catch {
    // Fallback 1x1px JPEG
    realPhotoBuffer = Buffer.from(
      'ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010110000000000000000000000102030405060708ffda000c03010002110311003f00a0ffd9',
      'hex',
    );
  }
});

// Mock Telegraf and fetch
mock.module('telegraf', () => {
  return {
    Telegraf: class {
      constructor(token) {
        this.token = token;
        this.telegram = {
          token: token,
          sendPhoto: mock(() =>
            Promise.resolve({
              message_id: 12345,
              photo: [
                { file_id: 'photo_id_low', file_unique_id: 'unique_id_low' },
                { file_id: 'photo_id_high', file_unique_id: 'unique_id_high' },
              ],
            }),
          ),
          sendDocument: mock(() =>
            Promise.resolve({
              message_id: 54321,
              document: {
                file_id: 'document_id',
                file_unique_id: 'document_unique_id',
              },
            }),
          ),
          getFile: mock(() =>
            Promise.resolve({
              file_id: 'some_file_id',
              file_size: 98765,
              mime_type: 'image/jpeg',
              file_path: 'photos/file_0.jpg',
            }),
          ),
        };
      }
    },
  };
});

const infoSpy = spyOn(logger, 'info');
const errorSpy = spyOn(logger, 'error');

describe('Telegram API Utilities', () => {
  let forwardToStorage: typeof import('../src/utils/telegram').forwardToStorage;
  let getFileInfo: typeof import('../src/utils/telegram').getFileInfo;
  let getBot: typeof import('../src/utils/telegram').getBot;

  beforeEach(async () => {
    infoSpy.mockClear();
    errorSpy.mockClear();
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ ok: true }))));

    // Import dynamically so mocking is applied first
    const telegramUtils = await import('../src/utils/telegram');
    forwardToStorage = telegramUtils.forwardToStorage;
    getFileInfo = telegramUtils.getFileInfo;
    getBot = telegramUtils.getBot;
  });

  afterEach(() => {
    delete global.fetch;
  });

  describe('getBot', () => {
    it('should return the telegraf bot instance', () => {
      const bot = getBot();
      expect(bot).toBeDefined();
      expect(bot.telegram).toBeDefined();
    });
  });

  describe('forwardToStorage', () => {
    it('should forward photo to storage chat and return file details', async () => {
      const chunk = realPhotoBuffer;
      const fileName = 'test_photo.png';
      const result = await forwardToStorage(chunk, fileName, 'photo');

      expect(result).toEqual({
        telegramFileId: 'photo_id_high',
        telegramFileUniqueId: 'unique_id_high',
        storageMessageId: 12345,
      });
      expect(infoSpy).toHaveBeenCalledWith('File forwarded to storage', {
        fileName,
        message: 12345,
      });
    });

    it('should forward documents with source and filename payload', async () => {
      const bot = getBot();
      const chunk = Buffer.from('fake document data');
      const fileName = 'document.pdf';

      const result = await forwardToStorage(chunk, fileName, 'document');

      expect(bot.telegram.sendDocument).toHaveBeenCalledWith(
        config.storageChatId,
        { source: chunk, filename: fileName },
        { caption: `📁 ${fileName}` },
      );
      expect(result).toEqual({
        telegramFileId: 'document_id',
        telegramFileUniqueId: 'document_unique_id',
        storageMessageId: 54321,
      });
    });

    it('should handle error when forwarding fails', async () => {
      const bot = getBot();
      bot.telegram.sendPhoto = mock(() => Promise.reject(new Error('Telegram send failed')));

      const chunk = realPhotoBuffer;
      const fileName = 'test_photo.png';

      await expect(forwardToStorage(chunk, fileName, 'photo')).rejects.toThrow(
        'Telegram send failed',
      );
      expect(errorSpy).toHaveBeenCalledWith('Failed to forward file to storage', {
        fileName,
        error: 'Telegram send failed',
      });
    });

    it('should retry when telegram returns 429 Too Many Requests', async () => {
      const bot = getBot();
      let calls = 0;
      bot.telegram.sendPhoto = mock(() => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new Error('429: Too Many Requests: retry after 1'));
        }
        return Promise.resolve({
          message_id: 999,
          photo: [{ file_id: 'retry_photo_id', file_unique_id: 'retry_unique_id' }],
        });
      });

      const chunk = realPhotoBuffer;
      const fileName = 'test_photo.png';

      const startTime = Date.now();
      const result = await forwardToStorage(chunk, fileName, 'photo');
      const duration = Date.now() - startTime;

      expect(calls).toBe(2);
      expect(duration).toBeGreaterThanOrEqual(1000);
      expect(result).toEqual({
        telegramFileId: 'retry_photo_id',
        telegramFileUniqueId: 'retry_unique_id',
        storageMessageId: 999,
      });
    });
  });

  describe('getFileInfo', () => {
    it('should fetch file details successfully', async () => {
      const result = await getFileInfo('some_file_id');

      expect(result).toEqual({
        file_size: 98765,
        mime_type: 'image/jpeg',
        file_path: 'photos/file_0.jpg',
        bot_token: config.botToken,
      });
    });
  });
});
