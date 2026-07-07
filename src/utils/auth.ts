import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../env';

const ADMIN_USERNAME = 'admin';
const SIGNATURE_SEPARATOR = '.';

type Handler = (req: Request) => Response | Promise<Response>;

export interface AuthSession {
  username: string;
  expiresAt: Date | null;
  method: 'cookie' | 'bearer';
}

interface CookieOptions {
  secret?: string;
  cookieName?: string;
  maxAgeMs?: number;
}

interface SessionPayload {
  u: string;
  e: number;
}

const getSecret = (secret?: string): string => secret ?? config.adminApiToken;
const getCookieName = (cookieName?: string): string => cookieName ?? config.sessionCookieName;
const getMaxAgeMs = (maxAgeMs?: number): number => maxAgeMs ?? config.sessionMaxAgeMs;

const encodePayload = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

const decodePayload = (value: string): string | null => {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
};

export const isAuthEnabled = (secret = config.adminApiToken): boolean => secret.length > 0;

export const timingSafeCompare = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};

export const signCookiePayload = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export const verifyCookieSignature = (cookieValue: string, secret: string): string | null => {
  const separatorIndex = cookieValue.lastIndexOf(SIGNATURE_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === cookieValue.length - 1) {
    return null;
  }

  const payload = cookieValue.slice(0, separatorIndex);
  const signature = cookieValue.slice(separatorIndex + 1);
  const expectedSignature = signCookiePayload(payload, secret);

  if (!timingSafeCompare(signature, expectedSignature)) {
    return null;
  }

  return payload;
};

const cookieAttributes = (maxAgeSeconds: number): string =>
  [`Max-Age=${maxAgeSeconds}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure'].join('; ');

export const createSessionCookie = (
  username = ADMIN_USERNAME,
  options: CookieOptions = {},
): string => {
  const secret = getSecret(options.secret);
  const cookieName = getCookieName(options.cookieName);
  const maxAgeMs = getMaxAgeMs(options.maxAgeMs);
  const expiresAt = Date.now() + maxAgeMs;
  const payload = encodePayload(
    JSON.stringify({ u: username, e: expiresAt } satisfies SessionPayload),
  );
  const signature = signCookiePayload(payload, secret);
  const maxAgeSeconds = Math.max(1, Math.floor(maxAgeMs / 1000));

  return `${cookieName}=${payload}${SIGNATURE_SEPARATOR}${signature}; ${cookieAttributes(maxAgeSeconds)}`;
};

export const clearSessionCookie = (cookieName = config.sessionCookieName): string =>
  `${cookieName}=; ${cookieAttributes(0)}`;

const findCookieValue = (cookieHeader: string | null, cookieName: string): string | null => {
  if (!cookieHeader) return null;

  for (const rawCookie of cookieHeader.split(';')) {
    const cookie = rawCookie.trim();
    const equalsIndex = cookie.indexOf('=');
    if (equalsIndex <= 0) continue;

    const name = cookie.slice(0, equalsIndex);
    if (name === cookieName) {
      return cookie.slice(equalsIndex + 1);
    }
  }

  return null;
};

export const parseSessionFromCookie = (
  cookieHeader: string | null,
  options: Pick<CookieOptions, 'secret' | 'cookieName'> = {},
): AuthSession | null => {
  const secret = getSecret(options.secret);
  const cookieName = getCookieName(options.cookieName);
  if (!isAuthEnabled(secret)) return null;

  const cookieValue = findCookieValue(cookieHeader, cookieName);
  if (!cookieValue) return null;

  const encodedPayload = verifyCookieSignature(cookieValue, secret);
  if (!encodedPayload) return null;

  const rawPayload = decodePayload(encodedPayload);
  if (!rawPayload) return null;

  try {
    const payload = JSON.parse(rawPayload) as Partial<SessionPayload>;
    if (payload.u !== ADMIN_USERNAME || typeof payload.e !== 'number') return null;
    if (!Number.isFinite(payload.e) || payload.e <= Date.now()) return null;

    return {
      username: payload.u,
      expiresAt: new Date(payload.e),
      method: 'cookie',
    };
  } catch {
    return null;
  }
};

export const checkBearerToken = (
  authorizationHeader: string | null,
  secret = config.adminApiToken,
): boolean => {
  if (!isAuthEnabled(secret) || !authorizationHeader) return false;

  const [scheme, ...rest] = authorizationHeader.split(' ');
  if (scheme !== 'Bearer' || rest.length === 0) return false;

  const token = rest.join(' ').trim();
  return token.length > 0 && timingSafeCompare(token, secret);
};

export const getAuthSession = (
  req: Request,
  options: Pick<CookieOptions, 'secret' | 'cookieName'> = {},
): AuthSession | null => {
  const secret = getSecret(options.secret);
  if (!isAuthEnabled(secret)) {
    return {
      username: ADMIN_USERNAME,
      expiresAt: null,
      method: 'bearer',
    };
  }

  const cookieSession = parseSessionFromCookie(req.headers.get('cookie'), options);
  if (cookieSession) return cookieSession;

  if (checkBearerToken(req.headers.get('authorization'), secret)) {
    return {
      username: ADMIN_USERNAME,
      expiresAt: null,
      method: 'bearer',
    };
  }

  return null;
};

export const unauthorizedResponse = (): Response =>
  Response.json({ error: 'Unauthorized' }, { status: 401 });

export const requireAuth = (
  handler: Handler,
  options: Pick<CookieOptions, 'secret' | 'cookieName'> = {},
): ((req: Request) => Promise<Response>) => {
  return async (req: Request): Promise<Response> => {
    const secret = getSecret(options.secret);
    if (!isAuthEnabled(secret)) {
      return handler(req);
    }

    const session = getAuthSession(req, options);
    if (!session) {
      return unauthorizedResponse();
    }

    return handler(req);
  };
};
