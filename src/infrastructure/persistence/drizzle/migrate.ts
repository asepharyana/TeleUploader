import postgres from 'postgres';
import { config } from '../../../env';
import { getErrorMessage } from '../../../shared/utils/file';
import logger from '../../../shared/logger/index';

/**
 * Run raw SQL migration from schema.sql.
 * Safe to call multiple times — all statements use IF NOT EXISTS.
 * Searches multiple relative paths to support execution from compiled dist,
 * bun --hot, or direct script invocation.
 */
export const runMigration = async (): Promise<void> => {
  // In compiled dist: import.meta.dir = .../dist/infrastructure/persistence/drizzle/
  // In source via bun --hot: import.meta.dir = .../src/infrastructure/persistence/drizzle/
  const dir = import.meta.dir || '';
  const candidates = [
    `${dir}/../../../../schema.sql`, // from dist/
    `${dir}/../../../schema.sql`,    // from src/infrastructure/persistence/
    `${dir}/../../schema.sql`,       // from src/infrastructure/
    `${dir}/../schema.sql`,          // from src/infrastructure/persistence/drizzle/
    `${dir}/schema.sql`,             // from next to file (bun run directly)
  ];

  let schemaSql: string | null = null;
  for (const p of candidates) {
    const file = Bun.file(p);
    const exists = await file.exists();
    if (exists) {
      schemaSql = await file.text();
      break;
    }
  }

  if (!schemaSql) {
    logger.error(`Migration failed: schema.sql not found (tried ${candidates.join(', ')})`);
    process.exitCode = 1;
    return;
  }

  const sql = postgres(config.databaseUrl, { max: 1 });

  try {
    await sql.unsafe(schemaSql);
    logger.info('Database migration completed');
  } catch (error: unknown) {
    logger.error('Database migration failed', { error: getErrorMessage(error) });
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
};

// When run directly: `bun src/infrastructure/persistence/drizzle/migrate.ts`
if (import.meta.path === Bun.main) {
  await runMigration();
}
