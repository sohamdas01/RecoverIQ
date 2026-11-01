import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';
import { buildDrizzleKitCredentials } from './db-connection.js';
dotenv.config();

export default defineConfig({
  schema: './drizzle/schema.js',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: buildDrizzleKitCredentials(),
  verbose: true,
  strict: true,
});
