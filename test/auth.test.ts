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
defaultEnv('DATABASE_URL', 'postgresql://asephs:***@100.121.180.82:6432/test');
defaultEnv('PORT', '4000');
defaultEnv('NODE_ENV', 'test');
setEnv('ADMIN_API_TOKEN', 'route-secret-token');
setEnv('SESSION_COOKIE_NAME', 'route_session');
setEnv('SESSION_COOKIE_MAX_AGE_SECONDS', '3600');

const auth = await import('../src/interfaces/http/middleware/auth');

describe('auth utilities', () => {
  const secret = 'admin-secret-token';
  const cookieName = 'test_session';

  it('signs and verifies a cookie payload', () => {
    const payload = Buffer.from(JSON.stringify({ u: 'admin', e: Date.now() + 60_000 })).toString(
      'base64url',
    );
    const signature = auth.signCookiePayload(payload, secret);

    expect(auth.verifyCookieSignature(`${payload}.${signature}`, secret)).toBe(payload);
  });

  it('rejects tampered cookie signatures', () => {
    const payload = Buffer.from(JSON.stringify({ u: 'admin', e: Date.now() + 60_000 })).toString(
      'base64url',
    );
    const signature = auth.signCookiePayload(payload, secret);

    expect(auth.verifyCookieSignature(`${payload}x.${signature}`, secret)).toBeNull();
  });

  it('rejects malformed cookie values', () => {
    expect(auth.verifyCookieSignature('', secret)).toBeNull();
    expect(auth.verifyCookieSignature('payload-only', secret)).toBeNull();
    expect(auth.verifyCookieSignature('.signature', secret)).toBeNull();
    expect(auth.verifyCookieSignature('payload.', secret)).toBeNull();
  });

  it('creates a secure HttpOnly session cookie', () => {
    const cookie = auth.createSessionCookie('admin', {
      secret,
      cookieName,
      maxAgeMs: 60_000,
    });

    expect(cookie).toStartWith(`${cookieName}=`);
    expect(cookie).toContain('Max-Age=60');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('clears a session cookie', () => {
    const cookie = auth.clearSessionCookie(cookieName);

    expect(cookie).toStartWith(`${cookieName}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
  });

  it('parses a valid signed session cookie', () => {
    const setCookie = auth.createSessionCookie('admin', {
      secret,
      cookieName,
      maxAgeMs: 60_000,
    });
    const cookieHeader = setCookie.split(';')[0];

    const session = auth.parseSessionFromCookie(cookieHeader, { secret, cookieName });

    expect(session?.username).toBe('admin');
    expect(session?.method).toBe('cookie');
    expect(session?.expiresAt).toBeInstanceOf(Date);
  });

  it('rejects an expired session cookie', () => {
    const expiredPayload = Buffer.from(
      JSON.stringify({ u: 'admin', e: Date.now() - 1_000 }),
    ).toString('base64url');
    const signature = auth.signCookiePayload(expiredPayload, secret);

    const session = auth.parseSessionFromCookie(`${cookieName}=${expiredPayload}.${signature}`, {
      secret,
      cookieName,
    });

    expect(session).toBeNull();
  });

  it('rejects cookies with the wrong name or secret', () => {
    const setCookie = auth.createSessionCookie('admin', {
      secret,
      cookieName,
      maxAgeMs: 60_000,
    });
    const cookieHeader = setCookie.split(';')[0];

    expect(auth.parseSessionFromCookie(cookieHeader, { secret, cookieName: 'other' })).toBeNull();
    expect(auth.parseSessionFromCookie(cookieHeader, { secret: 'wrong', cookieName })).toBeNull();
  });

  it('validates bearer tokens', () => {
    expect(auth.checkBearerToken(`Bearer ${secret}`, secret)).toBe(true);
    expect(auth.checkBearerToken('Bearer wrong', secret)).toBe(false);
    expect(auth.checkBearerToken(secret, secret)).toBe(false);
    expect(auth.checkBearerToken(null, secret)).toBe(false);
  });

  it('uses cookie and bearer auth for request sessions', () => {
    const setCookie = auth.createSessionCookie('admin', {
      secret,
      cookieName,
      maxAgeMs: 60_000,
    });
    const cookieRequest = new Request('http://localhost/api', {
      headers: { cookie: setCookie.split(';')[0] },
    });
    const bearerRequest = new Request('http://localhost/api', {
      headers: { authorization: `Bearer ${secret}` },
    });

    expect(auth.getAuthSession(cookieRequest, { secret, cookieName })?.method).toBe('cookie');
    expect(auth.getAuthSession(bearerRequest, { secret, cookieName })?.method).toBe('bearer');
  });

  it('allows protected handlers when auth is disabled', async () => {
    let calls = 0;
    const handler = (_req: Request) => {
      calls++;
      return Response.json({ ok: true });
    };
    const protectedHandler = auth.requireAuth(handler, { secret: '', cookieName });

    const res = await protectedHandler(new Request('http://localhost/api'));

    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('rejects protected handlers without a valid session', async () => {
    let calls = 0;
    const handler = (_req: Request) => {
      calls++;
      return Response.json({ ok: true });
    };
    const protectedHandler = auth.requireAuth(handler, { secret, cookieName });

    const res = await protectedHandler(new Request('http://localhost/api'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(calls).toBe(0);
  });

  it('passes protected handlers with a bearer token', async () => {
    let calls = 0;
    const handler = (_req: Request) => {
      calls++;
      return Response.json({ ok: true });
    };
    const protectedHandler = auth.requireAuth(handler, { secret, cookieName });

    const res = await protectedHandler(
      new Request('http://localhost/api', { headers: { authorization: `Bearer ${secret}` } }),
    );

    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});
