import type { AuthSession } from '../../../application/dto/auth';
import {
  createLoginUseCase,
  createLogoutUseCase,
  createMeUseCase,
} from '../../../application/use-cases/authenticate';
import { config } from '../../../env';
import { LoginBodySchema } from '../../../shared/validation/schemas';
import {
  clearSessionCookie,
  createSessionCookie,
  getAuthSession,
  isAuthEnabled,
} from '../middleware/auth';

/**
 * Helper that builds a JSON Response with optional extra headers.
 *
 * @param data - The JSON-serialisable body.
 * @param status - HTTP status code (default 200).
 * @param headers - Optional extra response headers.
 * @returns A JSON Response.
 */
const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(data, { status, headers });

/**
 * Returns a standard 404 Not Found JSON response.
 *
 * Used to hide auth endpoints when auth is disabled.
 *
 * @returns A 404 JSON response.
 */
const notFound = (): Response => json({ error: 'Not found' }, 404);

/**
 * Parses the login request body, extracting the `token` field.
 *
 * Validated through {@link LoginBodySchema} (the canonical boundary schema
 * for `POST /api/v1/auth/login`).
 *
 * @param req - The incoming HTTP request with a JSON body.
 * @returns The login token payload, or `null` when the body is invalid.
 */
const readLoginBody = async (req: Request): Promise<{ token: string } | null> => {
  try {
    const parsed = LoginBodySchema.safeParse(await req.json());
    if (!parsed.success) return null;
    return { token: parsed.data.token };
  } catch {
    return null;
  }
};

/**
 * Handles the login endpoint.
 *
 * Reads the admin API token from the request body, validates it via the
 * login use case, and sets a session cookie on success.
 *
 * When auth is disabled the endpoint returns 404.
 *
 * @param req - The incoming HTTP request.
 * @returns A JSON response with login status and a Set-Cookie header.
 */
export const handleLogin = async (req: Request): Promise<Response> => {
  if (!isAuthEnabled()) return notFound();

  const body = await readLoginBody(req);
  if (!body) return json({ error: 'Token is required' }, 400);

  try {
    const loginUseCase = createLoginUseCase({
      config: {
        adminApiToken: config.adminApiToken,
        sessionCookieName: config.sessionCookieName,
        sessionMaxAgeMs: config.sessionMaxAgeMs,
      },
    });

    const result = await loginUseCase({ token: body.token });

    return json({ username: result.username }, 200, {
      'set-cookie': createSessionCookie('admin'),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid token';
    if (message === 'Invalid token') {
      return json({ error: 'Invalid token' }, 401);
    }
    return json({ error: message }, 500);
  }
};

/**
 * Handles the logout endpoint.
 *
 * Clears the session cookie and returns a success response.
 *
 * @returns A JSON response with a cleared Set-Cookie header.
 */
export const handleLogout = async (): Promise<Response> => {
  const logoutUseCase = createLogoutUseCase();
  await logoutUseCase();

  return json({ success: true }, 200, {
    'set-cookie': clearSessionCookie(),
  });
};

/**
 * Handles the current-user (me) endpoint.
 *
 * Extracts the authentication session from the request (cookie or bearer
 * token) and returns the user info via the me use case.
 *
 * When auth is disabled the endpoint returns 404.
 *
 * @param req - The incoming HTTP request.
 * @returns A JSON response with user info, or 401 when unauthenticated.
 */
export const handleMe = async (req: Request): Promise<Response> => {
  if (!isAuthEnabled()) return notFound();

  // getAuthSession already checks the bearer token (cookie first, then
  // Authorization header) — no second check needed here.
  const session: AuthSession | null = getAuthSession(req);
  if (!session) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const meUseCase = createMeUseCase({
    config: {
      adminApiToken: config.adminApiToken,
      sessionCookieName: config.sessionCookieName,
      sessionMaxAgeMs: config.sessionMaxAgeMs,
    },
  });

  const result = await meUseCase(session);

  if (!result) {
    return json({ error: 'Unauthorized' }, 401);
  }

  return json({
    username: result.username,
    expiresAt: result.expiresAt,
  });
};
