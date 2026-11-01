import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPgConnection, buildDrizzleKitCredentials, stripSslParams } from '../../drizzle/db-connection.js';

const FAKE_PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';

describe('Database TLS configuration (AWS RDS)', () => {
  let tmpDir;
  let caPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recoveriq-db-ssl-'));
    caPath = path.join(tmpDir, 'bundle.pem');
    fs.writeFileSync(caPath, FAKE_PEM);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('without a CA path the URL is used unchanged and no SSL object is set', () => {
    const url = 'postgresql://u:p@localhost:5433/db';
    assert.deepEqual(buildPgConnection({ DATABASE_URL: url }), { connectionString: url, ssl: undefined });
  });

  test('with a CA path the pool gets a verifying SSL object holding the bundle', () => {
    const { ssl } = buildPgConnection({
      DATABASE_URL: 'postgresql://u:p@db.example.rds.amazonaws.com:5432/app',
      DATABASE_SSL_CA_PATH: caPath,
    });
    assert.deepEqual(ssl, { ca: FAKE_PEM, rejectUnauthorized: true });
  });

  test('sslmode / sslrootcert are removed from the URL so they cannot override the SSL object', () => {
    const { connectionString } = buildPgConnection({
      DATABASE_URL: 'postgresql://u:p@db:5432/app?sslmode=require&application_name=recoveriq&sslrootcert=/x.pem',
      DATABASE_SSL_CA_PATH: caPath,
    });
    assert.equal(connectionString, 'postgresql://u:p@db:5432/app?application_name=recoveriq');
    assert.equal(stripSslParams('postgresql://u:p@db:5432/app?sslmode=require'), 'postgresql://u:p@db:5432/app');
  });

  test('certificate verification is never disabled, even if the URL asks for it', () => {
    const { ssl } = buildPgConnection({
      DATABASE_URL: 'postgresql://u:p@db:5432/app?sslmode=no-verify',
      DATABASE_SSL_CA_PATH: caPath,
    });
    assert.equal(ssl.rejectUnauthorized, true);
  });

  test('an unreadable or non-PEM CA bundle is a startup error, not a silent downgrade', () => {
    assert.throws(
      () => buildPgConnection({ DATABASE_URL: 'postgresql://u:p@db/app', DATABASE_SSL_CA_PATH: path.join(tmpDir, 'missing.pem') }),
      /cannot be read/
    );
    const notPem = path.join(tmpDir, 'not-a-cert.txt');
    fs.writeFileSync(notPem, 'hello');
    assert.throws(
      () => buildPgConnection({ DATABASE_URL: 'postgresql://u:p@db/app', DATABASE_SSL_CA_PATH: notPem }),
      /PEM certificate bundle/
    );
  });

  test('drizzle-kit credentials keep the plain url without a CA path', () => {
    assert.deepEqual(buildDrizzleKitCredentials({ DATABASE_URL: 'postgresql://u:p@db:5432/app' }), {
      url: 'postgresql://u:p@db:5432/app',
    });
  });

  test('drizzle-kit credentials carry the same verifying SSL object and decode the URL parts', () => {
    const creds = buildDrizzleKitCredentials({
      DATABASE_URL: 'postgresql://admin:p%40ss%2Fw%3Ard@db.example.rds.amazonaws.com/app?sslmode=require',
      DATABASE_SSL_CA_PATH: caPath,
    });
    assert.deepEqual(creds, {
      host: 'db.example.rds.amazonaws.com',
      port: 5432,
      user: 'admin',
      password: 'p@ss/w:rd',
      database: 'app',
      ssl: { ca: FAKE_PEM, rejectUnauthorized: true },
    });
  });
});
