import { config } from '../../env';

/**
 * Extracts the client IP address from a Request object.
 *
 * When the server is behind a trusted proxy (config.trustProxy is true), this
 * function respects the X-Forwarded-For and X-Real-IP headers. Otherwise it
 * always returns 127.0.0.1.
 *
 * @param req - The incoming HTTP request.
 * @returns The client IP address as a string.
 */
export const extractClientIp = (req: Request): string => {
  if (!config.trustProxy) return '127.0.0.1';

  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const firstIp = forwardedFor.split(',')[0]?.trim();
    if (firstIp) return firstIp;
  }

  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  return '127.0.0.1';
};
