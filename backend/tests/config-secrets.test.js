import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { config, validateProductionConfig, isSimulationEnabled, INSECURE_DEFAULT_SECRETS } from '../services/config/index.js';

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
        FRONTEND_URL: 'https://app.recoveriq.example',
      };

      const result = validateProductionConfig(prodEnvValid);
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    const strongProdEnv = () => ({
      NODE_ENV: 'production',
      JWT_SECRET: 'k8F9w2N#zL5v$P1qR7tY3mC0xJ6uE4bA',
      RECOVERY_LINK_SECRET: 'v2N#zL5v$P1qR7tY3mC0xJ6uE4bAk8F9',
      DATABASE_URL: 'postgresql://prod_user:StrongProdPassword2026!@prod-db.internal:5432/recoveriq_prod',
      ML_INTERNAL_TOKEN: 'sec_ml_prod_8f3a9b1c7d2e4f5a6b0c',
      GENAI_INTERNAL_TOKEN: 'sec_genai_prod_1e2d3c4b5a6f7e8d',
      FRONTEND_URL: 'https://app.recoveriq.example',
    });

    test('2.5 Production mode rejects a JWT secret shorter than 32 characters', () => {
      const env = { ...strongProdEnv(), JWT_SECRET: 'short-but-unique-secret' };
      assert.throws(
        () => validateProductionConfig(env),
        (err) => err.validationErrors.some((e) => e.includes('JWT_SECRET') && e.includes('too short'))
      );
    });

    test('2.6 Production mode requires an explicit browser origin and rejects wildcard CORS', () => {
      const missing = strongProdEnv();
      delete missing.FRONTEND_URL;
      assert.throws(
        () => validateProductionConfig(missing),
        (err) => err.validationErrors.some((e) => e.includes('CORS_ORIGINS'))
      );

      assert.throws(
        () => validateProductionConfig({ ...strongProdEnv(), CORS_ORIGINS: '*' }),
        (err) => err.validationErrors.some((e) => e.includes("must not contain '*'"))
      );
    });

    test('2.7 Simulation is on by default in development and off by default in production', () => {
      assert.strictEqual(isSimulationEnabled({ NODE_ENV: 'development' }), true);
      assert.strictEqual(isSimulationEnabled({ NODE_ENV: 'production' }), false);
      assert.strictEqual(isSimulationEnabled({ NODE_ENV: 'production', ENABLE_SIMULATION: 'true' }), true);
      assert.strictEqual(isSimulationEnabled({ NODE_ENV: 'development', ENABLE_SIMULATION: 'false' }), false);
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

    // Real .env files are gitignored: they exist on a developer machine but never in a clean checkout (CI).
    // The checks that need them are skipped only when NONE exist; with any real .env present they run in full.
    const hasLocalEnvFiles = envPaths.some(({ path: p }) => fs.existsSync(p));
    const noLocalEnv = !hasLocalEnvFiles && 'no real .env files (gitignored) in this checkout; template checks 3.4-3.6 cover it';

    test('3.1 All 5 .env files exist in the repository', { skip: noLocalEnv }, () => {
      for (const { name, path: filePath } of envPaths) {
        assert.ok(fs.existsSync(filePath), `${name} must exist at ${filePath}`);
      }
    });

    test('3.2 .env files have content configured', { skip: noLocalEnv }, () => {
      for (const { name, path: filePath } of envPaths) {
        const content = fs.readFileSync(filePath, 'utf-8');
        assert.ok(content.length > 0, `${name} must not be empty`);
      }
    });

    test('3.3 Frontend .env contains only frontend-relevant public variables', { skip: noLocalEnv }, () => {
      const frontendEnvPath = path.join(rootDir, 'frontend/.env');
      const content = fs.readFileSync(frontendEnvPath, 'utf-8');
      assert.ok(content.includes('NEXT_PUBLIC_BACKEND_URL'), 'Frontend env must include NEXT_PUBLIC_BACKEND_URL');
      assert.ok(!content.includes('JWT_SECRET'), 'Frontend env must NOT expose backend JWT_SECRET');
      assert.ok(!content.includes('DATABASE_URL'), 'Frontend env must NOT expose DATABASE_URL');
    });

    // ---- Checks that run everywhere (clean checkouts included): templates and committed-secret hygiene ----
    const templatePaths = [
      { name: 'Root', path: path.join(rootDir, '.env.example') },
      { name: 'Backend', path: path.join(rootDir, 'backend/.env.example') },
      { name: 'Frontend', path: path.join(rootDir, 'frontend/.env.example') },
      { name: 'GenAI Service', path: path.join(rootDir, 'genai-service/.env.example') },
    ];

    const parseEnv = (content) => content
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => ({ key, value: value.trim() }));

    test('3.4 .env.example templates exist, are populated, and the frontend one exposes only public variables', () => {
      for (const { name, path: filePath } of templatePaths) {
        assert.ok(fs.existsSync(filePath), `${name} .env.example must exist at ${filePath}`);
        assert.ok(fs.readFileSync(filePath, 'utf-8').trim().length > 0, `${name} .env.example must not be empty`);
      }
      const frontend = parseEnv(fs.readFileSync(path.join(rootDir, 'frontend/.env.example'), 'utf-8'));
      assert.ok(frontend.some(({ key }) => key === 'NEXT_PUBLIC_BACKEND_URL'), 'Frontend template must define NEXT_PUBLIC_BACKEND_URL');
      assert.ok(frontend.every(({ key }) => key.startsWith('NEXT_PUBLIC_')), 'Frontend template must contain only NEXT_PUBLIC_* variables');
    });

    test('3.5 templates contain placeholders only: every secret-like value is a "your_..." placeholder', () => {
      const secretLike = /(SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|KEY_ID)/;
      for (const { name, path: filePath } of templatePaths) {
        for (const { key, value } of parseEnv(fs.readFileSync(filePath, 'utf-8'))) {
          if (!secretLike.test(key) || value === '') continue;
          assert.ok(
            value.toLowerCase().includes('your_'),
            `${name} .env.example: ${key} must be a placeholder containing "your_" (a real secret must never be committed)`
          );
        }
      }
    });

    // High-confidence credential shapes only, so ordinary test fixtures do not trip it
    const SECRET_SHAPES = [
      { label: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
      { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
      { label: 'OpenAI-style API key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
      { label: 'Razorpay live key', re: /\brzp_live_[A-Za-z0-9]{14,}\b/ },
      { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
    ];

    test('3.6 no real env files or key material are tracked by git, and no credential shapes appear in tracked text files', (t) => {
      let tracked;
      try {
        tracked = execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
          .split('\n')
          .filter(Boolean);
      } catch {
        return t.skip('not a git checkout (git unavailable): tracked-file scan skipped');
      }

      const realEnv = tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example'));
      assert.deepStrictEqual(realEnv, [], `real env files must not be committed: ${realEnv.join(', ')}`);

      const keyFiles = tracked.filter((f) => /\.(pem|key|p12|pfx)$/i.test(f));
      assert.deepStrictEqual(keyFiles, [], `key/certificate files must not be committed: ${keyFiles.join(', ')}`);

      const textExt = /\.(js|mjs|cjs|ts|tsx|jsx|json|py|md|yml|yaml|sql|txt|example|toml|cfg|ini|html|css)$/i;
      const hits = [];
      for (const file of tracked.filter((f) => textExt.test(f) && !f.endsWith('package-lock.json'))) {
        const full = path.join(rootDir, file);
        if (!fs.existsSync(full) || fs.statSync(full).size > 2 * 1024 * 1024) continue;
        const content = fs.readFileSync(full, 'utf-8');
        for (const { label, re } of SECRET_SHAPES) {
          if (re.test(content)) hits.push(`${file}: ${label}`);
        }
      }
      assert.deepStrictEqual(hits, [], `possible committed credentials:\n${hits.join('\n')}`);
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
