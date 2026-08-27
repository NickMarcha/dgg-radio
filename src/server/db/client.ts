import { drizzle } from 'drizzle-orm/node-postgres';
import { getEnv } from '../env';
import * as schema from './schema';

export type Database = ReturnType<typeof createDatabase>;

function createDatabase() {
  return drizzle({
    connection: getEnv().DATABASE_URL,
    schema,
  });
}

let database: Database | undefined;

export function getDatabase(): Database {
  database ??= createDatabase();
  return database;
}
