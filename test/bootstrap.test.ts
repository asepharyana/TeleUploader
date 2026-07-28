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

type RouteHandler = (req: Request) => Response | Promise<Response>;

const mockStartBot = mock(() =>
  Promise.resolve({
    stop: mock(),
  }),
);
const mockHandleUpload = mock((_req: Request) => Promise.resolve(Response.json({ ok: true })));
const mockRequireAuth = mock(
  (_handler: RouteHandler): RouteHandler =>
    async () =>
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
);

mock.module('../src/interfaces/bot/handler', () => ({
  startBot: mockStartBot,
}));

mock.module('../src/routes/upload', () => ({
  handleUpload: mockHandleUpload,
}));

mock.module('../src/utils/auth', () => ({
  requireAuth: mockRequireAuth,
}));

mock.module('../src/routes/files', () => ({
  handleFileRedirect: mock(),
  handleFileInfo: mock(),
}));

mock.module('../src/routes/health', () => ({
  handleHealth: mock(),
}));

mock.module('../src/routes/auth', () => ({
  handleLogin: mock(),
  handleLogout: mock(),
  handleMe: mock(),
}));

mock.module('../src/utils/rateLimit', () => ({
  cleanupRateLimitCache: mock(),
  clearRateLimitCache: mock(),
  checkRateLimit: mock(() => true),
  getRateLimitStats: mock(() => ({})),
  withRateLimit: <T extends Request>(
    handler: (req: T) => Promise<Response>,
  ): ((req: T) => Promise<Response>) => handler,
}));

describe('Bootstrap Server', () => {
  beforeEach(() => {
    mockServe.mockClear();
    mockStartBot.mockClear();
    mockHandleUpload.mockClear();
    mockRequireAuth.mockClear();
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
    expect(serveCallArgs.routes).toHaveProperty('/api/v1/auth/login');
    expect(serveCallArgs.routes).toHaveProperty('/api/v1/auth/logout');
    expect(serveCallArgs.routes).toHaveProperty('/api/v1/auth/me');
    expect(serveCallArgs.routes).toHaveProperty('/api/v1/*');

    const uploadRoute = serveCallArgs.routes?.['/api/upload'] as { POST: RouteHandler };
    const res = await uploadRoute.POST(
      new Request('http://localhost/api/upload', { method: 'POST' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockHandleUpload).toHaveBeenCalledTimes(1);

    const webApiRoute = serveCallArgs.routes?.['/api/v1/*'] as { GET: RouteHandler };
    const protectedRes = await webApiRoute.GET(new Request('http://localhost/api/v1/files'));

    expect(protectedRes.status).toBe(401);
    expect(await protectedRes.json()).toEqual({ error: 'Unauthorized' });
  });
});
