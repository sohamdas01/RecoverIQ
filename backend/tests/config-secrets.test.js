import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateProductionConfig, INSECURE_DEFAULT_SECRETS } from '../services/config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

describe('Phase 6 — Step 5: Configuration & Secrets Cleanup Test Suite', () => {

  describe('1. Configuration Variables & Structure', () => {
    test('1.1 All required configuration sections and fields are defined', () => {
      assert.ok(config.port, 'Port must be defined');
      assert.ok(config.env, 'Environment must be defined');
      assert.ok(config.databaseUrl, 'databaseUrl must be defined');
      assert.ok(config.redisUrl, 'redisUrl must be defined');
      assert.ok(config.genaiServiceUrl, 'genaiServiceUrl must be defined');
      assert.ok(config.mlServiceUrl, 'mlServiceUrl must be defined');
      assert.ok(config.frontendUrl, 'frontendUrl must be defined');
      assert.ok(config.jwtSecret, 'jwtSecret must be defined');
      assert.ok(config.recoveryLinkSecret, 'recoveryLinkSecret must be defined');
      assert.ok(config.internalServiceToken, 'internalServiceToken must be defined');
      assert.ok(config.mlInternalToken, 'mlInternalToken must be defined');
      assert.ok(config.genaiInternalToken, 'genaiInternalToken must be defined');
      assert.ok(config.guardrails, 'guardrails must be defined');
      assert.ok(config.kafka, 'kafka must be defined');
      assert.ok(config.retry, 'retry must be defined');
    });

    test('1.2 Insecure default secrets set is properly registered', () => {
      assert.ok(INSECURE_DEFAULT_SECRETS instanceof Set);
      assert.ok(INSECURE_DEFAULT_SECRETS.has('recoveriq-jwt-secret-key-default'));
      assert.ok(INSECURE_DEFAULT_SECRETS.has('recoveriq-internal-service-token-dev-secret'));
      assert.ok(INSECURE_DEFAULT_SECRETS.has('recoveriq-recovery-link-secret-default'));
    });
  });

  describe('2. Development vs Production Validation Behavior', () => {
    test('2.1 Development / Test mode succeeds with default safe fallback values', () => {
      const devEnv = { NODE_ENV: 'development' };
      const resDev = validateProductionConfig(devEnv);
      assert.strictEqual(resDev.isValid, true);
      assert.strictEqual(resDev.errors.length, 0);

      const testEnv = { NODE_ENV: 'test' };
      const resTest = validateProductionConfig(testEnv);
      assert.strictEqual(resTest.isValid, true);
      assert.strictEqual(resTest.errors.length, 0);
    });

    test('2.2 Production mode fails when mandatory secrets are missing', () => {
      const prodEnvEmpty = {
        NODE_ENV: 'production',
        JWT_SECRET: '',
        RECOVERY_LINK_SECRET: '',
        DATABASE_URL: '',
        ML_INTERNAL_TOKEN: '',
        GENAI_INTERNAL_TOKEN: '',
      };

      assert.throws(
        () => validateProductionConfig(prodEnvEmpty),
        (err) => {
          assert.ok(err.message.includes('Production startup failed'));
          assert.ok(err.validationErrors.length >= 4);
          return true;
        }
      );
    });

    test('2.3 Production mode fails when insecure default placeholders are supplied', () => {
      const prodEnvInsecure = {
        NODE_ENV: 'production',
        JWT_SECRET: 'recoveriq-jwt-secret-key-default',
        RECOVERY_LINK_SECRET: 'recoveriq-recovery-link-secret-default',
        DATABASE_URL: 'postgresql://prod_user:strong_pw@db.prod:5432/recoveriq',
        ML_INTERNAL_TOKEN: 'recoveriq-internal-service-token-dev-secret',
        GENAI_INTERNAL_TOKEN: 'recoveriq-internal-service-token-dev-secret',
      };

      assert.throws(
        () => validateProductionConfig(prodEnvInsecure),
        (err) => {
          assert.ok(err.message.includes('Insecure default secret detected'));
          assert.ok(err.validationErrors.some((e) => e.includes('JWT_SECRET')));
          assert.ok(err.validationErrors.some((e) => e.includes('ML_INTERNAL_TOKEN')));
          return true;
        }
      );
    });

    test('2.4 Production mode passes when explicit strong secrets are provided', () => {
      const prodEnvValid = {
        NODE_ENV: 'production',
        JWT_SECRET: 'k8F9w2N#zL5v$P1qR7tY3mC0xJ6uE4bA',
        RECOVERY_LINK_SECRET: 'v2N#zL5v$P1qR7tY3mC0xJ6uE4bAk8F9',
        DATABASE_URL: 'postgresql://prod_user:StrongProdPassword2026!@prod-db.internal:5432/recoveriq_prod',
        ML_INTERNAL_TOKEN: 'sec_ml_prod_8f3a9b1c7d2e4f5a6b0c',
        GENAI_INTERNAL_TOKEN: 'sec_genai_prod_1e2d3c4b5a6f7e8d',
      };

      const result = validateProductionConfig(prodEnvValid);
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.errors.length, 0);
    });
  });

  describe('3. .env Configuration Audit', () => {
    const envPaths = [
      { name: 'Root .env', path: path.join(rootDir, '.env') },
      { name: 'Backend .env', path: path.join(rootDir, 'backend/.env') },
      { name: 'Frontend .env', path: path.join(rootDir, 'frontend/.env') },
      { name: 'ML Service .env', path: path.join(rootDir, 'ml-service/.env') },
      { name: 'GenAI Service .env', path: path.join(rootDir, 'genai-service/.env') },
    ];

    test('3.1 All 5 .env files exist in the repository', () => {
      for (const { name, path: filePath } of envPaths) {
        assert.ok(fs.existsSync(filePath), `${name} must exist at ${filePath}`);
      }
    });

    test('3.2 .env files have content configured', () => {
      for (const { name, path: filePath } of envPaths) {
        const content = fs.readFileSync(filePath, 'utf-8');
        assert.ok(content.length > 0, `${name} must not be empty`);
      }
    });

    test('3.3 Frontend .env contains only frontend-relevant public variables', () => {
      const frontendEnvPath = path.join(rootDir, 'frontend/.env');
      const content = fs.readFileSync(frontendEnvPath, 'utf-8');
      assert.ok(content.includes('NEXT_PUBLIC_BACKEND_URL'), 'Frontend env must include NEXT_PUBLIC_BACKEND_URL');
      assert.ok(!content.includes('JWT_SECRET'), 'Frontend env must NOT expose backend JWT_SECRET');
      assert.ok(!content.includes('DATABASE_URL'), 'Frontend env must NOT expose DATABASE_URL');
    });
  });

  describe('4. Gitignore Policy & Secret Exclusion', () => {
    test('4.1 Root .gitignore properly configured', () => {
      const gitignorePath = path.join(rootDir, '.gitignore');
      assert.ok(fs.existsSync(gitignorePath));
      const content = fs.readFileSync(gitignorePath, 'utf-8');

      assert.ok(content.includes('.env'), '.gitignore must handle .env');
      assert.ok(content.includes('*.pem'), '.gitignore must exclude *.pem certificates');
      assert.ok(content.includes('*.key'), '.gitignore must exclude *.key files');
    });

    test('4.2 Frontend .gitignore exists and is valid', () => {
      const frontendGitignorePath = path.join(rootDir, 'frontend/.gitignore');
      assert.ok(fs.existsSync(frontendGitignorePath));
      const content = fs.readFileSync(frontendGitignorePath, 'utf-8');
      assert.ok(content.length > 0, 'Frontend .gitignore must not be empty');
    });
  });
});
