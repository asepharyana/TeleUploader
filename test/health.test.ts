import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock database layer
const mockExecute = mock(() => Promise.resolve());

mock.module('../src/infrastructure/persistence/drizzle/index', () => ({
  db: {
    execute: mockExecute,
  },
}));

describe('Health Route Handler', () => {
  let handleHealth: typeof import('../src/interfaces/http/controllers/health-controller').handleHealth;

  beforeEach(async () => {
    mockExecute.mockClear();
    const healthRoute = await import('../src/interfaces/http/controllers/health-controller');
    handleHealth = healthRoute.handleHealth;
  });

  it('should return status 200 and ok when DB is healthy', async () => {
    const req = new Request('http://localhost:3000/health');
    const res = await handleHealth(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
    expect(mockExecute).toHaveBeenCalled();
  });

  it('should return status 500 and error details when DB health check fails', async () => {
    mockExecute.mockImplementationOnce(() => Promise.reject(new Error('DB Connection Failed')));
    const req = new Request('http://localhost:3000/health');
    const res = await handleHealth(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error).toBe('DB Connection Failed');
  });
});
