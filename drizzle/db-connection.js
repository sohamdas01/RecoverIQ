import fs from 'node:fs';

export const DEFAULT_DATABASE_URL = 'postgresql://recoveriq_user:recoveriq_password@localhost:5433/recoveriq_db';

// libpq/pg URL parameters that would override (or conflict with) the explicit SSL object below.
const SSL_URL_PARAMS = new Set(['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'sslcrl', 'uselibpqcompat']);

/**
 * Removes SSL-related query parameters from a connection string. node-postgres lets values parsed
 * from the URL win over the `ssl` option, so an explicit SSL object only takes effect once they are gone.
 */
export function stripSslParams(connectionString) {
  const queryStart = connectionString.indexOf('?');
  if (queryStart === -1) return connectionString;

  const base = connectionString.slice(0, queryStart);
  const kept = new URLSearchParams(connectionString.slice(queryStart + 1));
  for (const key of [...kept.keys()]) {
    if (SSL_URL_PARAMS.has(key.toLowerCase())) kept.delete(key);
  }
  const query = kept.toString();
  return query ? `${base}?${query}` : base;
}

function readCaCertificate(caPath) {
  let pem;
  try {
    pem = fs.readFileSync(caPath, 'utf8');
  } catch (err) {
    throw new Error(`DATABASE_SSL_CA_PATH is set but the CA bundle cannot be read (${caPath}): ${err.message}`);
  }
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`DATABASE_SSL_CA_PATH does not point to a PEM certificate bundle (${caPath})`);
  }
  return pem;
}

/**
 * Builds the node-postgres connection settings.
 *
 * Without DATABASE_SSL_CA_PATH the URL is used unchanged (local Docker Postgres, CI).
 * With it (AWS RDS: point it at https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) the
 * server certificate is always verified against that CA bundle. Verification is never disabled, and a
 * missing or invalid bundle is a startup error rather than a silent downgrade.
 *
 * @param {Object} [env=process.env]
 * @returns {{ connectionString: string, ssl: { ca: string, rejectUnauthorized: true } | undefined }}
 */
export function buildPgConnection(env = process.env) {
  const connectionString = env.DATABASE_URL || DEFAULT_DATABASE_URL;
  const caPath = (env.DATABASE_SSL_CA_PATH || '').trim();
  if (!caPath) return { connectionString, ssl: undefined };

  return {
    connectionString: stripSslParams(connectionString),
    ssl: { ca: readCaCertificate(caPath), rejectUnauthorized: true },
  };
}

/**
 * drizzle-kit credentials. drizzle-kit cannot take an SSL object together with a `url`, so when a CA
 * bundle is configured the URL is split into host/port/user/password/database.
 *
 * @param {Object} [env=process.env]
 */
export function buildDrizzleKitCredentials(env = process.env) {
  const { connectionString, ssl } = buildPgConnection(env);
  if (!ssl) return { url: connectionString };

  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    ssl,
  };
}
