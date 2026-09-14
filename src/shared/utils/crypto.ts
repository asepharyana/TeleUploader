import { timingSafeEqual } from 'node:crypto';

/**
 * Compares two strings using a timing-safe algorithm to prevent
 * timing side-channel attacks.
 *
 * Single canonical implementation — replaces the three copies that
 * previously lived in `interfaces/http/middleware/auth.ts`,
 * `application/use-cases/authenticate.ts`, and `interfaces/s3/auth.ts`.
 *
 * @param left - First string to compare.
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
