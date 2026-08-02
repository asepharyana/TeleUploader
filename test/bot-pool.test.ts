import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

process.env.BOT_TOKENS = 'bot1:token,bot2:token,bot3:token';
process.env.STORAGE_CHANNEL_ID = '-1001234567890';
process.env.BASE_URL = 'https://example.com';
process.env.DATABASE_URL = 'sqlite://test.db';
process.env.PORT = '4000';

// Track mock queue instances for per-bot assertions
const queueInstances: Array<{
  concurrency: number;
  add: ReturnType<typeof mock>;
  pending: number;
  size: number;
}> = [];

// Mock PQueue so we can verify concurrency
const mockAdd = mock(function addFn(this: any, fn: () => Promise<any>) {
  return Promise.resolve().then(() => fn());
});

mock.module('p-queue', () => {
  return {
    default: mock(function MockQueue(this: any, opts?: { concurrency?: number }) {
      const instance = {
        concurrency: opts?.concurrency ?? 1,
        add: mockAdd,
        pending: 0,
        size: 0,
      };
      queueInstances.push(instance);
      return instance;
    }),
  };
});

// Mock Telegraf — use a class so `new Telegraf(token)` works correctly
const mockTelegramInstances: Record<
  string,
  {
    token: string;
    sendDocument: ReturnType<typeof mock>;
    sendPhoto: ReturnType<typeof mock>;
    getFile: ReturnType<typeof mock>;
  }
> = {};

class MockTelegraf {
  token: string;
  telegram: {
    token: string;
    sendDocument: ReturnType<typeof mock>;
    sendPhoto: ReturnType<typeof mock>;
    getFile: ReturnType<typeof mock>;
  };

  constructor(token: string) {
    this.token = token;
    this.telegram = {
      token,
      sendDocument: mock(() =>
        Promise.resolve({
          message_id: 1,
          document: { file_id: `file_${token}`, file_unique_id: `uniq_${token}` },
        }),
      ),
      sendPhoto: mock(() =>
        Promise.resolve({
          message_id: 1,
          photo: [{ file_id: `photo_${token}`, file_unique_id: `photo_uniq_${token}` }],
        }),
      ),
      getFile: mock(() =>
        Promise.resolve({ file_size: 100, mime_type: 'text/plain', file_path: 'path' }),
      ),
    };
    mockTelegramInstances[token] = this.telegram;
  }
}

mock.module('telegraf', () => ({
  Telegraf: MockTelegraf,
}));

describe('BotPool', () => {
  let BotPool: typeof import('../src/infrastructure/telegram/bot-pool').BotPool;
  let botPool: import('../src/infrastructure/telegram/bot-pool').BotPool;

  beforeEach(async () => {
    mockAdd.mockClear();
    queueInstances.length = 0;
    for (const token of Object.keys(mockTelegramInstances)) {
      const tg = mockTelegramInstances[token];
      if (tg) {
        tg.sendDocument?.mockClear();
        tg.getFile?.mockClear();
      }
    }
    const mod = await import('../src/infrastructure/telegram/bot-pool');
    BotPool = mod.BotPool;
    botPool = new BotPool();
  });

  afterEach(() => {
    // No module cache cleanup needed — Bun handles import caching correctly
  });

  it('should have correct bot count', () => {
    expect(botPool.size).toBe(3);
  });

  it('should have correct effective concurrency', () => {
    // 3 bots * 1 concurrency per bot
    expect(botPool.getEffectiveConcurrency()).toBe(3);
  });

  it('should forward files through the queue', async () => {
    const result = await botPool.forwardToStorage(Buffer.from('test data'), 'test.txt', 'document');
    expect(result.telegramFileId).toBeDefined();
    expect(result.storageMessageId).toBeGreaterThan(0);
  });

  it('should use per-bot queues with concurrency=1', () => {
    // Each bot gets its own PQueue instance with concurrency=1
    expect(queueInstances.length).toBe(3);
    for (const qi of queueInstances) {
      expect(qi.concurrency).toBe(1);
    }
  });
});
