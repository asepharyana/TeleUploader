import logger from '../logger/index';

/** Configuration options for retry behaviour. */
interface RetryOptions {
  /** Maximum number of retry attempts (default: 3). */
  maxRetries?: number;
  /** Delay before the first retry in milliseconds (default: 100). */
  initialDelayMs?: number;
  /** Maximum delay between retries in milliseconds (default: 5000). */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2). */
  backoffMultiplier?: number;
  /**
   * Predicate that determines whether a given error should trigger a retry.
   * When omitted, transient network / timeout errors are retried.
   */
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  shouldRetry: (error: unknown) => {
    const errorStr = error instanceof Error ? error.message : String(error);
    // Retry on transient errors
    return (
      errorStr.includes('ECONNREFUSED') ||
      errorStr.includes('ETIMEDOUT') ||
      errorStr.includes('ENOTFOUND') ||
      errorStr.includes('429') ||
      errorStr.includes('timeout')
    );
  },
};

/**
 * Executes an async function with exponential backoff retry logic.
 *
 * The function is retried up to `maxRetries` times. Between attempts the
 * delay grows by `backoffMultiplier` (capped at `maxDelayMs`). Only errors
 * for which `shouldRetry` returns `true` trigger a retry; all others are
 * thrown immediately. When all retries are exhausted the last error is
 * thrown.
 *
 * @param fn - The async function to execute.
 * @param options - Optional retry configuration overrides.
 * @returns The resolved value of `fn`.
 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;
  let delay = opts.initialDelayMs;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const errorStr = error instanceof Error ? error.message : String(error);

      if (attempt === opts.maxRetries || !opts.shouldRetry(error)) {
        logger.error('Retry exhausted', {
          attempt,
          maxRetries: opts.maxRetries,
          error: errorStr,
        });
        throw error;
      }

      logger.warn('Retrying after error', {
        attempt,
        delay,
        error: errorStr,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw lastError;
};

/**
 * Wraps an async function with a configurable timeout.
 *
 * If `fn` does not settle within `timeoutMs` milliseconds the returned
 * promise rejects with a timeout error. The underlying `fn` continues
 * executing but its result is ignored.
 *
 * @param fn - The async function to execute.
 * @param timeoutMs - Timeout in milliseconds (default: 30000).
 * @returns The resolved value of `fn`.
 */
export const withTimeout = async <T>(
  fn: () => Promise<T>,
  timeoutMs: number = 30000,
): Promise<T> => {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
};

/**
 * Executes a primary async function and falls back to a secondary function
 * if the primary throws.
 *
 * The fallback function is called only when the primary rejects. If the
 * fallback also throws the error propagates to the caller.
 *
 * @param primary - The primary async function to attempt first.
 * @param fallback - The fallback async function invoked on failure.
 * @returns The resolved value of `primary` or, on failure, of `fallback`.
 */
export const withFallback = async <T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> => {
  try {
    return await primary();
  } catch (error: unknown) {
    logger.warn('Primary operation failed, using fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback();
  }
};
