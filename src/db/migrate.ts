import postgres from 'postgres';
import { config } from '../env';
import { getErrorMessage } from '../utils/file';
import logger from '../utils/logger';

/**
 * Run raw SQL migration from schema.sql.
 * Safe to call multiple times — all statements use IF NOT EXISTS.
 */
export const runMigration = async (): Promise<void> => {
  // In compiled dist: import.meta.dir = .../dist/
  // In source via bun --hot: import.meta.dir = .../src/db/
  const dir = import.meta.dir || '';
  const candidates = [
    dir + '/../../schema.sql', // from dist/
    dir + '/../schema.sql', // from src/ (bun --hot src/index.ts)
    dir + '/../schema.sql', // from src/db/ (bun --hot src/db/migrate.ts)
    dir + '/schema.sql', // from src/ (bun run db:migrate)
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
    logger.error('Migration failed: schema.sql not found (tried ' + candidates.join(', ') + ')');
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

// When run directly: `bun src/db/migrate.ts` or `bun dist/migrate.js`
if (import.meta.path === Bun.main) {
  await runMigration();
}
