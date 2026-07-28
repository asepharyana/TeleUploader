/**
 * Input for the login endpoint.
 * The caller provides the admin API token to obtain a session cookie.
 */
export interface LoginInput {
  /** Admin API token for authentication */
  token: string;
}

/**
 * Active authentication session information.
 */
export interface AuthSession {
  /** Authenticated username (currently always "admin") */
  username: string;
  /** Session expiry timestamp; null for bearer-token sessions */
  expiresAt: Date | null;
  /** Authentication method used */
  method: 'cookie' | 'bearer';
}

/**
 * Response payload for a successful login.
 */
export interface LoginResponse {
  /** Authenticated username */
  username: string;
}

/**
 * Response payload for logout.
 */
export interface LogoutResponse {
  /** Whether the logout succeeded */
  success: boolean;
}

/**
 * Response payload for the current-user (/me) endpoint.
 */
export interface UserInfoResponse {
  /** Authenticated username */
  username: string;
  /** ISO-8601 session expiry timestamp; null when using bearer token */
  expiresAt: string | null;
}
