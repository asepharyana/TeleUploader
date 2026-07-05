import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

type ServeOptions = {
  port?: number;
  routes?: Record<string, unknown>;
};

type MockServer = {
  port?: number;
  routes?: Record<string, unknown>;
  stop: ReturnType<typeof mock>;
};

const mockServe = mock((options: ServeOptions): MockServer => {
  return {
    port: options.port,
    routes: options.routes,
    stop: mock(),
  };
});

const originalServe = Bun.serve;
Bun.serve = mockServe as unknown as typeof Bun.serve;

const mockStartBot = mock(() =>
  Promise.resolve({
    stop: mock(),
  }),
);

mock.module('../src/bot', () => ({
  startBot: mockStartBot,
}));

mock.module('../src/routes/upload', () => ({
  handleUpload: mock(),
}));

mock.module('../src/routes/files', () => ({
  handleFileRedirect: mock(),
  handleFileInfo: mock(),
}));

mock.module('../src/routes/health', () => ({
  handleHealth: mock(),
}));

mock.module('../src/utils/rateLimit', () => ({
  cleanupRateLimitCache: mock(),
  withRateLimit: <T extends Request>(
    handler: (req: T) => Promise<Response>,
  ): ((req: T) => Promise<Response>) => handler,
}));

describe('Bootstrap Server', () => {
  beforeEach(() => {
    mockServe.mockClear();
    mockStartBot.mockClear();
  });

  afterAll(() => {
    Bun.serve = originalServe;
  });

  it('should bootstrap the application successfully', async () => {
    await import('../src/index');

    expect(mockServe).toHaveBeenCalled();
    expect(mockStartBot).toHaveBeenCalled();

    const serveCallArgs = mockServe.mock.calls[0][0];
    expect(serveCallArgs).toHaveProperty('port');
    expect(serveCallArgs).toHaveProperty('routes');
    expect(serveCallArgs.routes).toBeDefined();
    expect(serveCallArgs.routes).toHaveProperty('/api/upload');
    expect(serveCallArgs.routes).toHaveProperty('/f/:public_id');
    expect(serveCallArgs.routes).toHaveProperty('/file/:public_id/info');
    expect(serveCallArgs.routes).toHaveProperty('/health');
  });
});
