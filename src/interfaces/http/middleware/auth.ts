import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../../env';

const ADMIN_USERNAME = 'admin';
const SIGNATURE_SEPARATOR = '.';

/** A request handler function that returns a Response. */
type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Represents an authenticated user session after successful
 * authentication via cookie or bearer token.
 */
export interface AuthSession {
  /** The authenticated username (always "admin" in this implementation). */
  username: string;
  /**
   * Expiration date of the session, or `null` for bearer-token
   * sessions which do not expire at the session level.
   */
  expiresAt: Date | null;
  /** The authentication method used to establish this session. */
  method: 'cookie' | 'bearer';
}

/** Options for configuring cookie-based session behaviour. */
interface CookieOptions {
  /** HMAC signing secret (defaults to {@link config.adminApiToken}). */
  secret?: string;
  /** Name of the session cookie (defaults to {@link config.sessionCookieName}). */
  cookieName?: string;
  /** Session lifetime in milliseconds (defaults to {@link config.sessionMaxAgeMs}). */
  maxAgeMs?: number;
}

/** Shape of the serialised cookie payload. */
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

/**
 * Checks whether authentication is enabled.
 *
 * Authentication is considered enabled when the admin API token is
 * non-empty.
 *
 * @param secret - Secret to check (defaults to `config.adminApiToken`).
 * @returns `true` when auth is enabled, `false` otherwise.
 */
export const isAuthEnabled = (secret = config.adminApiToken): boolean => secret.length > 0;

/**
 * Compares two strings using a timing-safe algorithm to prevent
 * timing side-channel attacks.
 *
 * @param left  - First string to compare.
 * @param right - Second string to compare.
 * @returns `true` when the strings are equal, `false` otherwise.
 */
export const timingSafeCompare = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};

/**
 * Signs an arbitrary payload string with HMAC-SHA256 using the given
 * secret, producing a base64url-encoded signature.
 *
 * @param payload - The value to sign.
 * @param secret  - HMAC signing key.
 * @returns The base64url-encoded signature.
 */
export const signCookiePayload = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/**
 * Verifies the HMAC signature on a cookie value and returns the
 * original signed payload.
 *
 * The cookie value is expected to be in the format
 * `<payload>.<signature>`.  Returns `null` when the format is
 * invalid or the signature does not match.
 *
 * @param cookieValue - The full cookie value including signature.
 * @param secret      - HMAC signing key.
 * @returns The unsigned payload string, or `null` on failure.
 */
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

/**
 * Builds the `Set-Cookie` attribute string for a given max-age in
 * seconds.  The cookie is HttpOnly, SameSite=Lax, Secure, and
 * scoped to the root path.
 *
 * @param maxAgeSeconds - Max-Age in seconds.
 * @returns The cookie attribute string (excluding name=value).
 */
const cookieAttributes = (maxAgeSeconds: number): string =>
  [`Max-Age=${maxAgeSeconds}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure'].join('; ');

/**
 * Creates a signed session cookie string suitable for use as a
 * `Set-Cookie` header value.
 *
 * The cookie embeds a base64url-encoded JSON payload containing the
 * username and expiration timestamp, signed with HMAC-SHA256.
 *
 * @param username - Session username (default `"admin"`).
 * @param options  - Optional cookie settings.
 * @returns A fully-formed `Set-Cookie` header value.
 */
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

/**
 * Creates a `Set-Cookie` header value that immediately expires the
 * session cookie, effectively logging the user out.
 *
 * @param cookieName - Name of the cookie to clear (defaults to
 *                     `config.sessionCookieName`).
 * @returns A `Set-Cookie` header value with Max-Age=0.
 */
export const clearSessionCookie = (cookieName = config.sessionCookieName): string =>
  `${cookieName}=; ${cookieAttributes(0)}`;

/**
 * Finds the value of a named cookie from a raw `Cookie` header
 * string.
 *
 * @param cookieHeader - The raw `Cookie` header value, or `null`.
 * @param cookieName   - Name of the cookie to look for.
 * @returns The cookie value, or `null` if not found.
 */
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

/**
 * Parses an {@link AuthSession} from a signed session cookie.
 *
 * The function verifies the HMAC signature, decodes the payload,
 * and validates the expiration timestamp.  Returns `null` when the
 * cookie is missing, malformed, expired, or the signature is
 * invalid.  Also returns `null` when auth is disabled (empty
 * admin API token).
 *
 * @param cookieHeader - The `Cookie` header value, or `null`.
 * @param options      - Optional overrides for secret / cookie name.
 * @returns The parsed session, or `null`.
 */
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

/**
 * Validates a `Bearer` token from the `Authorization` header using
 * timing-safe comparison.
 *
 * @param authorizationHeader - The raw `Authorization` header, or `null`.
 * @param secret              - Expected bearer token (defaults to
 *                              `config.adminApiToken`).
 * @returns `true` when the token is valid, `false` otherwise.
 */
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

/**
 * Extracts the authenticated session from a request.
 *
 * Tries cookie-based authentication first, then falls back to a
 * Bearer token in the `Authorization` header.  When auth is
 * disabled (empty API token) the function returns a synthetic
 * session with method `"bearer"` and no expiry, effectively
 * granting access to all requests.
 *
 * @param req     - The incoming HTTP request.
 * @param options - Optional overrides for secret / cookie name.
 * @returns The authenticated session, or `null` when unauthenticated.
 */
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

/**
 * Creates a 401 Unauthorized JSON response with a standard error
 * body.
 *
 * @returns A `Response` with status 401 and JSON body
 *          `{ error: "Unauthorized" }`.
 */
export const unauthorizedResponse = (): Response =>
  Response.json({ error: 'Unauthorized' }, { status: 401 });

/**
 * Middleware that wraps a request handler with authentication.
 *
 * When auth is enabled the wrapper checks for a valid session
 * (cookie or Bearer token) before delegating to the handler.
 * Unauthenticated requests receive a 401 response.  When auth is
 * disabled the handler is always invoked.
 *
 * @param handler - The request handler to protect.
 * @param options - Optional overrides for secret / cookie name.
 * @returns A wrapped handler that performs the auth check.
 */
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
