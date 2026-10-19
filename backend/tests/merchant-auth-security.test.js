/**
 * Phase 8 - Merchant Authentication & Role-Based Authorization Tests
 *
 * Runs the real production middleware stack (createApp) over HTTP against the real database:
 *  - login (credentials, throttling, disabled accounts, no account enumeration)
 *  - token validation (tampering, algorithm confusion, expiry, wrong audience, revoked identities)
 *  - every previously-open endpoint now requires authentication
 *  - role-based access (viewer < reviewer < admin; platform_admin only for DLQ ops)
 *  - fail-closed behaviour, CORS allow-list, production-safe error output
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { createApp, buildCorsOptions } from '../app.js';
import { config } from '../services/config/index.js';
import { AuthService } from '../services/auth/auth.service.js';
import { MerchantAuthService, AuthError } from '../services/auth/merchant-auth.service.js';
import { hashPassword, verifyPassword } from '../services/auth/password.js';
import { errorHandler } from '../api/middleware/error.middleware.js';
import { db, closeDatabasePool } from '../db/index.js';
import { setUserStatus, setUserRole, setMerchantStatus } from '../db/queries/merchants.queries.js';
import { redis, clearRateLimit, disconnectRedis } from '../redis/redis.client.js';
import { checkKafkaHealth, disconnectKafka } from '../kafka/kafka.client.js';
import { createTestMerchant, createTestUser, bearer, TEST_PASSWORD } from './helpers/auth-fixtures.js';

const uniq = () => crypto.randomBytes(4).toString('hex');

describe('Phase 8 - Merchant Authentication & Authorization', () => {
  let server;
  let http;
  let merchant;
  let admin;
  let reviewer;
  let viewer;
  let platformAdmin;
  let kafkaUp = false;
  let savedIpLimit;

  before(async () => {
    const app = createApp();
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    http = axios.create({
      baseURL: `http://localhost:${server.address().port}`,
      validateStatus: () => true,
    });

    merchant = await createTestMerchant('Auth Co');
    admin = await createTestUser({ merchantId: merchant.id, role: 'admin' });
    reviewer = await createTestUser({ merchantId: merchant.id, role: 'reviewer' });
    viewer = await createTestUser({ merchantId: merchant.id, role: 'viewer' });
    platformAdmin = await createTestUser({ merchantId: merchant.id, role: 'platform_admin' });

    // Many logins from one test IP: keep the per-IP limiter out of the way (it has its own test below)
    savedIpLimit = config.loginRateLimit.maxAttemptsPerIp;
    config.loginRateLimit.maxAttemptsPerIp = 100000;

    try {
      kafkaUp = (await checkKafkaHealth()).status === 'healthy';
    } catch {
      kafkaUp = false;
    }
  });

  after(async () => {
    config.loginRateLimit.maxAttemptsPerIp = savedIpLimit;
    mock.restoreAll();
    // This suite makes many logins from one address: don't leave throttle counters behind for the next run
    const leftover = await redis.keys('login:*').catch(() => []);
    if (leftover.length) await redis.del(...leftover).catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectKafka().catch(() => {});
    await disconnectRedis();
    await closeDatabasePool();
  });

  // ---------------------------------------------------------------------------
  describe('A. Password hashing', () => {
    it('hashes with a per-password salt and verifies in constant time', async () => {
      const h1 = await hashPassword('a-long-enough-passphrase');
      const h2 = await hashPassword('a-long-enough-passphrase');
      assert.notStrictEqual(h1, h2, 'same password must hash differently (random salt)');
      assert.ok(h1.startsWith('scrypt$'));
      assert.strictEqual(await verifyPassword('a-long-enough-passphrase', h1), true);
      assert.strictEqual(await verifyPassword('a-long-enough-passphrasX', h1), false);
    });

    it('rejects short passwords and malformed hashes without throwing', async () => {
      await assert.rejects(() => hashPassword('short'), /at least/);
      assert.strictEqual(await verifyPassword('whatever-password', 'not-a-hash'), false);
      assert.strictEqual(await verifyPassword('whatever-password', 'scrypt$x$y$z$a$b'), false);
      assert.strictEqual(await verifyPassword('', 'scrypt$1$1$1$a$b'), false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('B. Login', () => {
    it('1. valid credentials return a token and public user profile (no secrets)', async () => {
      const res = await http.post('/api/auth/login', { email: viewer.email, password: TEST_PASSWORD });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(typeof res.data.token, 'string');
      assert.strictEqual(res.data.user.email, viewer.email);
      assert.strictEqual(res.data.user.role, 'viewer');
      assert.strictEqual(res.data.user.merchant.id, merchant.id);
      assert.match(res.headers['cache-control'], /no-store/);
      const serialized = JSON.stringify(res.data);
      assert.ok(!serialized.includes('passwordHash') && !serialized.includes('scrypt$'), 'hash must never be returned');
      assert.ok(!serialized.includes(merchant.webhookSecret), 'webhook secret must never be returned');
    });

    it('2. email matching is case-insensitive', async () => {
      const res = await http.post('/api/auth/login', { email: viewer.email.toUpperCase(), password: TEST_PASSWORD });
      assert.strictEqual(res.status, 200);
    });

    it('3. wrong password and unknown email are indistinguishable (no account enumeration)', async () => {
      const wrongPw = await http.post('/api/auth/login', { email: viewer.email, password: 'definitely-wrong-password' });
      const unknown = await http.post('/api/auth/login', { email: `nobody.${uniq()}@test.example`, password: 'definitely-wrong-password' });
      assert.strictEqual(wrongPw.status, 401);
      assert.strictEqual(unknown.status, 401);
      assert.strictEqual(wrongPw.data.code, 'INVALID_CREDENTIALS');
      assert.deepStrictEqual(unknown.data, wrongPw.data);
      assert.strictEqual(wrongPw.data.token, undefined);
    });

    it('4. malformed input is rejected with 400 before any credential check', async () => {
      const bad = [
        {},
        { email: viewer.email },
        { password: TEST_PASSWORD },
        { email: { $ne: null }, password: { $ne: null } },
        { email: 'not-an-email', password: TEST_PASSWORD },
        { email: viewer.email, password: 'x'.repeat(5000) },
        { email: `${'a'.repeat(300)}@test.example`, password: TEST_PASSWORD },
      ];
      for (const body of bad) {
        const res = await http.post('/api/auth/login', body);
        assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 60)}`);
        assert.strictEqual(res.data.code, 'INVALID_INPUT');
      }
    });

    it('5. repeated failures lock the account out (even for the correct password), then reset on success path', async () => {
      const target = await createTestUser({ merchantId: merchant.id, role: 'viewer' });
      const max = config.loginRateLimit.maxFailuresPerEmail;
      for (let i = 0; i < max; i++) {
        const res = await http.post('/api/auth/login', { email: target.email, password: `wrong-password-${i}-xxxx` });
        assert.strictEqual(res.status, 401);
      }
      const locked = await http.post('/api/auth/login', { email: target.email, password: TEST_PASSWORD });
      assert.strictEqual(locked.status, 429);
      assert.strictEqual(locked.data.code, 'TOO_MANY_ATTEMPTS');
      assert.ok(locked.headers['retry-after']);
      assert.strictEqual(locked.data.token, undefined);

      // cleanup so reruns start clean
      const key = `login:fail:${crypto.createHash('sha256').update(target.email).digest('hex')}`;
      await clearRateLimit(key);
      const ok = await http.post('/api/auth/login', { email: target.email, password: TEST_PASSWORD });
      assert.strictEqual(ok.status, 200);
    });

    it('6. per-IP attempt limiting throttles a single client', async () => {
      const ip = `test-ip-${uniq()}`;
      const original = config.loginRateLimit.maxAttemptsPerIp;
      config.loginRateLimit.maxAttemptsPerIp = 3;
      try {
        let last;
        for (let i = 0; i < 4; i++) {
          last = await MerchantAuthService.login({ email: viewer.email, password: TEST_PASSWORD, ip }).catch((e) => e);
        }
        assert.ok(last instanceof AuthError);
        assert.strictEqual(last.statusCode, 429);
      } finally {
        config.loginRateLimit.maxAttemptsPerIp = original;
        await clearRateLimit(`login:ip:${ip}`);
      }
    });

    it('7. disabled users and suspended merchants cannot sign in (after proving the password)', async () => {
      const disabled = await createTestUser({ merchantId: merchant.id, role: 'viewer', status: 'disabled' });
      const res = await http.post('/api/auth/login', { email: disabled.email, password: TEST_PASSWORD });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.data.code, 'ACCOUNT_DISABLED');
      assert.strictEqual(res.data.token, undefined);

      const suspendedMerchant = await createTestMerchant('Suspended Co');
      const su = await createTestUser({ merchantId: suspendedMerchant.id, role: 'admin' });
      await setMerchantStatus(suspendedMerchant.id, 'suspended');
      const res2 = await http.post('/api/auth/login', { email: su.email, password: TEST_PASSWORD });
      assert.strictEqual(res2.status, 403);
      assert.strictEqual(res2.data.token, undefined);
    });

    it('8. /api/auth/me returns the principal for a valid token and 401 otherwise', async () => {
      const ok = await http.get('/api/auth/me', { headers: bearer(reviewer.token) });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.data.user.role, 'reviewer');
      assert.strictEqual(ok.data.user.merchant.id, merchant.id);
      assert.strictEqual((await http.get('/api/auth/me')).status, 401);
    });
  });

  // ---------------------------------------------------------------------------
  describe('C. Token validation', () => {
    const claims = () => ({ sub: viewer.user.id, mid: merchant.id, role: 'viewer' });
    const sign = (payload, secret = config.jwtSecret, opts = {}) =>
      jwt.sign(payload, secret, { algorithm: 'HS256', issuer: config.jwtIssuer, audience: config.jwtAudience, expiresIn: '1h', ...opts });
    const probe = (token) => http.get('/api/auth/me', { headers: token ? bearer(token) : {} });

    it('accepts a correctly signed token', async () => {
      assert.strictEqual((await probe(sign(claims()))).status, 200);
    });

    it('rejects tampered, foreign, expired and mis-scoped tokens', async () => {
      const valid = sign(claims());
      const [h, p, s] = valid.split('.');
      const forgedPayload = Buffer.from(JSON.stringify({ ...claims(), role: 'admin', mid: 'someone-else' })).toString('base64url');

      const rejected = {
        'garbage': 'not.a.jwt',
        'signature stripped': `${h}.${p}.`,
        'payload swapped, original signature': `${h}.${forgedPayload}.${s}`,
        'wrong signing secret': sign(claims(), 'some-other-secret-entirely-different'),
        'alg=none': `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`,
        'expired': sign(claims(), config.jwtSecret, { expiresIn: '-10s' }),
        'wrong audience': sign(claims(), config.jwtSecret, { audience: 'another-service' }),
        'wrong issuer': sign(claims(), config.jwtSecret, { issuer: 'someone-else' }),
        'missing mid claim': sign({ sub: viewer.user.id }),
        'missing sub claim': sign({ mid: merchant.id }),
        'recovery-link token': jwt.sign({ transactionId: 't1', nonce: 'n' }, config.recoveryLinkSecret, { expiresIn: '1h' }),
        'unknown user id': sign({ sub: crypto.randomUUID(), mid: merchant.id, role: 'admin' }),
        'user belongs to a different merchant than the token claims': sign({ sub: viewer.user.id, mid: 'merchant_default', role: 'viewer' }),
      };
      for (const [name, token] of Object.entries(rejected)) {
        const res = await probe(token);
        assert.strictEqual(res.status, 401, `token case "${name}" must be rejected, got ${res.status}`);
      }
      assert.strictEqual((await http.get('/api/auth/me', { headers: { Authorization: 'Basic abc' } })).status, 401);
      assert.strictEqual((await http.get('/api/auth/me', { headers: { Authorization: 'Bearer' } })).status, 401);
    });

    it('role in the token is not trusted: the database role wins', async () => {
      const lying = sign({ sub: viewer.user.id, mid: merchant.id, role: 'admin' });
      const res = await http.post('/api/simulate/purchase', {}, { headers: bearer(lying) });
      assert.strictEqual(res.status, 403, 'a viewer must not gain admin rights by claiming it in the token');
    });

    it('revocation is immediate: disabling a user or suspending a merchant invalidates live tokens', async () => {
      const m = await createTestMerchant('Revocation Co');
      const u = await createTestUser({ merchantId: m.id, role: 'admin' });
      assert.strictEqual((await probe(u.token)).status, 200);

      await setUserStatus(u.user.id, 'disabled');
      assert.strictEqual((await probe(u.token)).status, 401);
      await setUserStatus(u.user.id, 'active');
      assert.strictEqual((await probe(u.token)).status, 200);

      await setMerchantStatus(m.id, 'suspended');
      assert.strictEqual((await probe(u.token)).status, 401);
    });

    it('fails closed (503, not access) when the identity lookup errors', async () => {
      const original = db.select;
      mock.method(db, 'select', () => { throw new Error('simulated database outage'); });
      try {
        const res = await probe(admin.token);
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.data.code, 'AUTH_UNAVAILABLE');
      } finally {
        mock.restoreAll();
        assert.strictEqual(db.select, original);
      }
    });

    it('the old unauthenticated token-minting endpoint no longer exists', async () => {
      for (const headers of [{}, bearer(admin.token)]) {
        const res = await http.post('/api/admin/recovery-cases/auth/token', { merchantId: 'x', role: 'admin' }, { headers });
        assert.ok([401, 404].includes(res.status), `got ${res.status}`);
        assert.strictEqual(res.data.token, undefined);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('D. Every previously-open endpoint now requires authentication', () => {
    const routes = [
      ['get', '/api/decisions'],
      ['get', '/api/decisions?pending=true'],
      ['get', '/api/decisions/activity'],
      ['get', '/api/decisions/some-id'],
      ['post', '/api/decisions/some-id/review'],
      ['get', '/api/transactions'],
      ['get', '/api/transactions/some-id'],
      ['post', '/api/simulate/purchase'],
      ['post', '/api/simulate/batch'],
      ['get', '/api/admin/recovery-cases/activity'],
      ['get', '/api/admin/recovery-cases/some-id/review'],
      ['get', '/api/admin/recovery-cases/some-id/explanation'],
      ['post', '/api/admin/recovery-cases/some-id/approve'],
      ['post', '/api/admin/recovery-cases/some-id/modify'],
      ['post', '/api/admin/recovery-cases/some-id/reject'],
      ['post', '/api/admin/recovery-cases/ask'],
      ['post', '/api/admin/ask'],
      ['get', '/api/admin/events/dlq/some-id'],
      ['post', '/api/admin/events/some-id/replay'],
    ];

    for (const [method, path] of routes) {
      it(`401 without a token: ${method.toUpperCase()} ${path}`, async () => {
        const res = await http.request({ method, url: path, data: method === 'post' ? {} : undefined });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.data.success, false);
      });
    }

    it('public-by-design endpoints stay reachable: health probes and signed customer recovery links', async () => {
      assert.strictEqual((await http.get('/health/live')).status, 200);
      const badLink = await http.get('/api/recover/not-a-real-token');
      assert.strictEqual(badLink.status, 401, 'invalid recovery token is rejected, not an auth-wall bypass');
    });
  });

  // ---------------------------------------------------------------------------
  describe('E. Role-based authorization', () => {
    it('viewer: read access only', async () => {
      for (const path of ['/api/decisions', '/api/decisions/activity', '/api/transactions', '/api/admin/recovery-cases/activity']) {
        const res = await http.get(path, { headers: bearer(viewer.token) });
        assert.strictEqual(res.status, 200, `viewer should read ${path}`);
      }
      const ask = await http.post('/api/admin/recovery-cases/ask', { question: 'How much revenue was recovered?' }, { headers: bearer(viewer.token) });
      assert.strictEqual(ask.status, 200);

      const denied = [
        ['post', '/api/decisions/x/review', {}],
        ['post', '/api/admin/recovery-cases/x/approve', {}],
        ['post', '/api/admin/recovery-cases/x/modify', {}],
        ['post', '/api/admin/recovery-cases/x/reject', {}],
        ['post', '/api/simulate/purchase', {}],
        ['post', '/api/simulate/batch', {}],
        ['get', '/api/admin/events/dlq/x'],
        ['post', '/api/admin/events/x/replay', {}],
      ];
      for (const [method, path, data] of denied) {
        const res = await http.request({ method, url: path, data, headers: bearer(viewer.token) });
        assert.strictEqual(res.status, 403, `viewer must be forbidden: ${method} ${path}`);
        assert.strictEqual(res.data.code, 'FORBIDDEN');
      }
    });

    it('reviewer: can act on cases (reaches the handler), but cannot simulate or touch DLQ', async () => {
      for (const path of ['/api/admin/recovery-cases/nope/approve', '/api/admin/recovery-cases/nope/reject', '/api/admin/recovery-cases/nope/modify']) {
        const res = await http.post(path, {}, { headers: bearer(reviewer.token) });
        assert.strictEqual(res.status, 404, `reviewer should pass authz and get not-found for ${path}`);
      }
      const legacy = await http.post('/api/decisions/nope/review', { reviewAction: 'approve' }, { headers: bearer(reviewer.token) });
      assert.strictEqual(legacy.status, 404);

      assert.strictEqual((await http.post('/api/simulate/purchase', {}, { headers: bearer(reviewer.token) })).status, 403);
      assert.strictEqual((await http.get('/api/admin/events/dlq/x', { headers: bearer(reviewer.token) })).status, 403);
    });

    it('admin: can simulate for its own merchant; still cannot use platform DLQ endpoints', async () => {
      const res = await http.post('/api/simulate/purchase', { customerEmail: `sim.${uniq()}@test.example`, amount: 1500 }, { headers: bearer(admin.token) });
      if (kafkaUp) {
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.data.transaction.merchantId, merchant.id, 'simulated data is owned by the caller\'s merchant');
      } else {
        assert.ok(![401, 403].includes(res.status), 'authorization must pass even if the broker is down');
      }
      assert.strictEqual((await http.get('/api/admin/events/dlq/x', { headers: bearer(admin.token) })).status, 403);
    });

    it('platform_admin: can use DLQ endpoints but has no implicit access to merchant data routes', async () => {
      const dlq = await http.get('/api/admin/events/dlq/does-not-exist', { headers: bearer(platformAdmin.token) });
      assert.strictEqual(dlq.status, 404, 'authorized, event simply not found');
      assert.strictEqual((await http.get('/api/decisions', { headers: bearer(platformAdmin.token) })).status, 403);
      assert.strictEqual((await http.get('/api/transactions', { headers: bearer(platformAdmin.token) })).status, 403);
      assert.strictEqual((await http.post('/api/simulate/batch', {}, { headers: bearer(platformAdmin.token) })).status, 403);
    });

    it('role changes take effect without re-login (admin demoted to viewer loses write access)', async () => {
      const m = await createTestMerchant('Demotion Co');
      const u = await createTestUser({ merchantId: m.id, role: 'admin' });
      assert.notStrictEqual((await http.post('/api/simulate/purchase', {}, { headers: bearer(u.token) })).status, 403);

      await setUserRole(u.user.id, 'viewer');
      assert.strictEqual((await http.post('/api/simulate/purchase', {}, { headers: bearer(u.token) })).status, 403);
    });

    it('simulation is switched off in production unless explicitly enabled', async () => {
      const prevNode = process.env.NODE_ENV;
      const prevFlag = process.env.ENABLE_SIMULATION;
      try {
        process.env.ENABLE_SIMULATION = 'false';
        const off = await http.post('/api/simulate/purchase', {}, { headers: bearer(admin.token) });
        assert.strictEqual(off.status, 404);

        delete process.env.ENABLE_SIMULATION;
        process.env.NODE_ENV = 'production';
        const prodDefault = await http.post('/api/simulate/batch', {}, { headers: bearer(admin.token) });
        assert.strictEqual(prodDefault.status, 404);
      } finally {
        process.env.NODE_ENV = prevNode;
        if (prevFlag === undefined) delete process.env.ENABLE_SIMULATION; else process.env.ENABLE_SIMULATION = prevFlag;
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('F. Request hardening', () => {
    it('limit query parameter is sanitised (garbage, negative and oversized values do not break or over-fetch)', async () => {
      for (const limit of ['abc', '-5', '0', '99999999', '1e9', '']) {
        const res = await http.get(`/api/decisions?limit=${limit}`, { headers: bearer(viewer.token) });
        assert.strictEqual(res.status, 200, `limit=${limit}`);
        assert.ok(res.data.count <= 200);
      }
    });

    it('CORS only allows the configured browser origins', async () => {
      const allowedOrigin = config.corsOrigins[0];
      const ok = await http.get('/health/live', { headers: { Origin: allowedOrigin } });
      assert.strictEqual(ok.headers['access-control-allow-origin'], allowedOrigin);

      const evil = await http.get('/health/live', { headers: { Origin: 'https://evil.example' } });
      assert.strictEqual(evil.headers['access-control-allow-origin'], undefined);

      const noOrigin = await http.get('/health/live');
      assert.strictEqual(noOrigin.status, 200);
      assert.strictEqual(noOrigin.headers['x-powered-by'], undefined);

      let allowedStar;
      buildCorsOptions(['https://app.example']).origin('https://app.example', (_e, v) => { allowedStar = v; });
      assert.strictEqual(allowedStar, true);
    });

    it('server errors do not leak internal details in production', () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        let body;
        let status;
        const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
        errorHandler(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), {}, res, () => {});
        assert.strictEqual(status, 500);
        assert.strictEqual(body.error.message, 'Internal Server Error');
        assert.ok(!JSON.stringify(body).includes('hunter2'));
        assert.strictEqual(body.error.stack, undefined);

        errorHandler(Object.assign(new Error('Bad input'), { status: 400 }), {}, res, () => {});
        assert.strictEqual(body.error.message, 'Bad input', 'client errors keep their message');
      } finally {
        process.env.NODE_ENV = prev;
      }
    });

    it('public health endpoints expose status only (no brokers, topics or raw error text)', async () => {
      for (const path of ['/health/kafka', '/health']) {
        const res = await http.get(path);
        const body = JSON.stringify(res.data);
        for (const leak of ['brokers', 'topics', 'clusterId', 'controller', 'error']) {
          assert.ok(!body.includes(`"${leak}"`), `${path} must not expose "${leak}"`);
        }
      }
    });

    it('oversized request bodies are rejected', async () => {
      const res = await http.post('/api/auth/login', { email: viewer.email, password: 'x'.repeat(300000) });
      assert.strictEqual(res.status, 413);
    });
  });

  it('AuthService issues tokens that carry identity only (no secrets) and expire', () => {
    const token = AuthService.issueMerchantToken({ userId: 'u1', merchantId: 'm1', role: 'admin' });
    const decoded = jwt.decode(token);
    assert.strictEqual(decoded.sub, 'u1');
    assert.strictEqual(decoded.mid, 'm1');
    assert.ok(decoded.exp > decoded.iat);
    assert.strictEqual(decoded.iss, config.jwtIssuer);
    assert.strictEqual(decoded.aud, config.jwtAudience);
    assert.throws(() => AuthService.issueMerchantToken({ userId: 'u1' }), /required/);
  });
});
