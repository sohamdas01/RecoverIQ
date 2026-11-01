import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as dotenv from 'dotenv';
import * as schema from '../../drizzle/schema.js';
import { buildPgConnection } from '../../drizzle/db-connection.js';

dotenv.config();

const { Pool } = pg;

const { connectionString, ssl } = buildPgConnection();

export const pool = new Pool({
  connectionString,
  ssl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool, { schema });

export async function closeDatabasePool() {
  try {
    await pool.end();
  } catch (_) {}
}

export { schema };
