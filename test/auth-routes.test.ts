import { describe, expect, it } from 'bun:test';

const defaultEnv = (key: string, value: string) => {
  process.env[key] ||= value;
};
const setEnv = (key: string, value: string) => {
  process.env[key] = value;
};

defaultEnv('BOT_TOKEN', '123456:ABC-DEF');
defaultEnv('STORAGE_CHANNEL_ID', '-1001234567890');
defaultEnv('BASE_URL', 'https://example.com');
defaultEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
defaultEnv('PORT', '3000');
defaultEnv('NODE_ENV', 'test');
setEnv('ADMIN_API_TOKEN', 'route-secret-token');
setEnv('SESSION_COOKIE_NAME', 'route_session');
setEnv('SESSION_COOKIE_MAX_AGE_SECONDS', '3600');

const { createSessionCookie } = await import('../src/utils/auth');
const { handleLogin, handleLogout, handleMe } = await import(
  '../src/interfaces/http/controllers/auth-controller'
);

const jsonBody = async <T>(res: Response): Promise<T> => (await res.json()) as T;

describe('auth routes', () => {
  it('logs in with the configured token and sets a session cookie', async () => {
    const res = await handleLogin(
      new Request('http://localhost/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'route-secret-token' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await jsonBody<{ username: string }>(res)).toEqual({ username: 'admin' });
    expect(res.headers.get('set-cookie')).toContain('route_session=');
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('rejects a wrong login token', async () => {
    const res = await handleLogin(
      new Request('http://localhost/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'wrong' }),
      }),
    );

    expect(res.status).toBe(401);
    expect(await jsonBody<{ error: string }>(res)).toEqual({ error: 'Invalid token' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects missing or invalid login body', async () => {
    const res = await handleLogin(
      new Request('http://localhost/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(400);
    expect(await jsonBody<{ error: string }>(res)).toEqual({ error: 'Token is required' });
  });

  it('returns the current user from a valid session cookie', async () => {
    const setCookie = createSessionCookie('admin');
    const cookieHeader = setCookie.split(';')[0];

    const res = await handleMe(
      new Request('http://localhost/api/v1/auth/me', {
        headers: { cookie: cookieHeader },
      }),
    );

    const body = await jsonBody<{ username: string; expiresAt: string | null }>(res);
    expect(res.status).toBe(200);
    expect(body.username).toBe('admin');
    if (typeof body.expiresAt !== 'string') throw new Error('Expected expiresAt string');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns the current user from a bearer token', async () => {
    const res = await handleMe(
      new Request('http://localhost/api/v1/auth/me', {
        headers: { authorization: 'Bearer route-secret-token' },
      }),
    );

    expect(res.status).toBe(200);
    expect(await jsonBody<{ username: string; expiresAt: null }>(res)).toEqual({
      username: 'admin',
      expiresAt: null,
    });
  });

  it('rejects missing and tampered sessions', async () => {
    const missing = await handleMe(new Request('http://localhost/api/v1/auth/me'));
    expect(missing.status).toBe(401);

    const validCookie = createSessionCookie('admin').split(';')[0];
    const tamperedCookie = `${validCookie}x`;
    const tampered = await handleMe(
      new Request('http://localhost/api/v1/auth/me', {
        headers: { cookie: tamperedCookie },
      }),
    );

    expect(tampered.status).toBe(401);
  });

  it('clears the session on logout', async () => {
    const res = await handleLogout();

    expect(res.status).toBe(200);
    expect(await jsonBody<{ success: boolean }>(res)).toEqual({ success: true });
    expect(res.headers.get('set-cookie')).toContain('route_session=;');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
