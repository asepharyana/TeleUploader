import { timingSafeEqual } from 'node:crypto';
import type {
  AuthSession,
  LoginInput,
  LoginResponse,
  LogoutResponse,
  UserInfoResponse,
} from '../dto/auth';

/** Subset of application configuration consumed by the authenticate use case. */
export interface AuthUseCaseConfig {
  /** Admin API token used to authenticate login requests. */
  adminApiToken: string;
  /** Name of the session cookie. */
  sessionCookieName: string;
  /** Session lifetime in milliseconds. */
  sessionMaxAgeMs: number;
}

/** Dependencies required by the authenticate use case factory. */
export interface AuthenticateUseCaseDeps {
  /** Application configuration subset. */
  config: AuthUseCaseConfig;
}

/**
 * Performs a constant-time string comparison to prevent timing attacks.
 *
 * @param left - The first string to compare.
 * @param right - The second string to compare.
 * @returns `true` if the strings are equal, `false` otherwise.
 */
const timingSafeCompare = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};

/**
 * Checks whether authentication is enabled based on the configured token.
 *
 * @param adminApiToken - The admin API token value.
 * @returns `true` if the token is non-empty (auth is enabled).
 */
const isAuthEnabled = (adminApiToken: string): boolean => adminApiToken.length > 0;

/**
 * Creates a factory function for the login use case.
 *
 * Validates the provided admin API token and returns session metadata on
 * success. The caller (controller/adapter) is responsible for translating
 * the result into an HTTP response (e.g. setting a session cookie).
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting login input and returning a login response.
 */
export function createLoginUseCase(deps: AuthenticateUseCaseDeps) {
  return async (input: LoginInput): Promise<LoginResponse> => {
    if (!isAuthEnabled(deps.config.adminApiToken)) {
      return { username: 'admin' };
    }

    if (!timingSafeCompare(input.token, deps.config.adminApiToken)) {
      throw new Error('Invalid token');
    }

    return { username: 'admin' };
  };
}

/**
 * Creates a factory function for the logout use case.
 *
 * Always succeeds — the caller is responsible for clearing the session cookie.
 *
 * @returns An async function returning a logout response.
 */
export function createLogoutUseCase() {
  return async (): Promise<LogoutResponse> => {
    return { success: true };
  };
}

/**
 * Creates a factory function for the current-user (me) use case.
 *
 * Accepts an already-parsed auth session (from cookie or bearer token) and
 * returns the user info response. The caller (controller/adapter) is
 * responsible for extracting the session from the raw HTTP request.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting an optional session and returning user info.
 */
export function createMeUseCase(deps: AuthenticateUseCaseDeps) {
  return async (session: AuthSession | null): Promise<UserInfoResponse | null> => {
    if (!isAuthEnabled(deps.config.adminApiToken)) {
      return null;
    }

    if (!session) {
      return null;
    }

    return {
      username: session.username,
      expiresAt: session.expiresAt?.toISOString() ?? null,
    };
  };
}
