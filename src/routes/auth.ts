import { config } from '../env';
import {
  checkBearerToken,
  clearSessionCookie,
  createSessionCookie,
  getAuthSession,
  isAuthEnabled,
  timingSafeCompare,
} from '../utils/auth';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(data, { status, headers });

const notFound = (): Response => json({ error: 'Not found' }, 404);

const readLoginBody = async (req: Request): Promise<{ token: string } | null> => {
  try {
    const body = (await req.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0) return null;
    return { token: body.token };
  } catch {
    return null;
  }
};

export const handleLogin = async (req: Request): Promise<Response> => {
  if (!isAuthEnabled()) return notFound();

  const body = await readLoginBody(req);
  if (!body) return json({ error: 'Token is required' }, 400);

  if (!timingSafeCompare(body.token, config.adminApiToken)) {
    return json({ error: 'Invalid token' }, 401);
  }

  return json({ username: 'admin' }, 200, {
    'set-cookie': createSessionCookie('admin'),
  });
};

export const handleLogout = async (): Promise<Response> =>
  json({ success: true }, 200, {
    'set-cookie': clearSessionCookie(),
  });

export const handleMe = async (req: Request): Promise<Response> => {
  if (!isAuthEnabled()) return notFound();

  const session = getAuthSession(req);
  if (!session && !checkBearerToken(req.headers.get('authorization'))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const activeSession = session ?? {
    username: 'admin',
    expiresAt: null,
    method: 'bearer' as const,
  };

  return json({
    username: activeSession.username,
    expiresAt: activeSession.expiresAt?.toISOString() ?? null,
  });
};
