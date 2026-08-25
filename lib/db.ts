import { env } from 'cloudflare:workers';
import { schemaStatements, seedStatements } from '@/db/schema';

let schemaPromise: Promise<void> | null = null;

export function getDb(): D1Database {
  const database = (env as unknown as { DB?: D1Database }).DB;
  if (!database) throw new Error('D1 binding DB 尚未設定。');
  return database;
}

export async function ensureDatabase(): Promise<D1Database> {
  const database = getDb();
  schemaPromise ??= initialize(database).catch((error) => {
    schemaPromise = null;
    throw error;
  });
  await schemaPromise;
  return database;
}

async function initialize(database: D1Database): Promise<void> {
  await database.batch(schemaStatements.map((sql) => database.prepare(sql)));
  await database.batch(seedStatements.map((sql) => database.prepare(sql)));
  await database.prepare('PRAGMA optimize').run();
}
