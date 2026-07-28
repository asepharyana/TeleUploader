import { sql } from 'drizzle-orm';
import { db } from '../../../infrastructure/persistence/drizzle/index';
import { getErrorMessage } from '../../../shared/utils/file';
import logger from '../../../shared/logger/index';

/**
 * Handles the health-check endpoint.
 *
 * Verifies database connectivity by executing a simple `SELECT 1` query.
 * Returns a 200 response with `{ status: 'ok' }` when the database is
 * reachable, or a 500 response with the error details when it is not.
 *
 * @param _req - The incoming HTTP request (unused).
 * @returns A JSON response indicating the database health status.
 */
export const handleHealth = async (_req: Request): Promise<Response> => {
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json({ status: 'ok' }, { status: 200 });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    logger.error('Health check failed', { error: message });
    return Response.json({ status: 'error', error: message }, { status: 500 });
  }
};