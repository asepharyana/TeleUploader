import { describe, expect, it } from 'bun:test';

const defaultEnv = (key: string, value: string) => {
  process.env[key] ||= value;
};
const setEnv = (key: string, value: string) => {
  process.env[key] = value;
};

defaultEnv('BOT_TOKENS', '123456:ABC-DEF');
defaultEnv('STORAGE_CHANNEL_ID', '-1001234567890');
defaultEnv('BASE_URL', 'https://example.com');
defaultEnv('DATABASE_URL', 'postgresql://asephs:***@100.121.180.82:6432/test');
defaultEnv('PORT', '4000');
defaultEnv('NODE_ENV', 'test');
setEnv('ADMIN_API_TOKEN', 'route-secret-token');
setEnv('SESSION_COOKIE_NAME', 'route_session');
setEnv('SESSION_COOKIE_MAX_AGE_SECONDS', '3600');

const { routes } = await import('../src/interfaces/http/routes/index');
const { handleWebApiV1 } = await import('../src/interfaces/http/controllers/web-api-controller');

describe('public read-only API routing', () => {
  it('serves GET /api/v1/* without auth (read endpoints are public)', () => {
    // The GET handler must be the raw web API handler — NOT requireAuth-wrapped.
    expect(routes['/api/v1/*'].GET).toBe(handleWebApiV1);
  });

  it('protects write endpoints with auth (POST/DELETE/PUT)', () => {
    // requireAuth wraps the handler into a new function, so these must NOT be
    // the raw handler — they are auth-guarded.
    expect(routes['/api/v1/*'].POST).not.toBe(handleWebApiV1);
    expect(routes['/api/v1/*'].DELETE).not.toBe(handleWebApiV1);
    expect(routes['/api/v1/*'].PUT).not.toBe(handleWebApiV1);
  });

  it('keeps the auth/me endpoint accessible (frontend uses it to detect admin state)', () => {
    expect(routes['/api/v1/auth/me']).toBeDefined();
    expect(typeof routes['/api/v1/auth/me'].GET).toBe('function');
  });
});
