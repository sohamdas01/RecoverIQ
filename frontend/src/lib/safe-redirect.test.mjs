import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNextPath } from './safe-redirect.js';

test('keeps ordinary same-origin paths (including query strings)', () => {
  assert.equal(safeNextPath('/dashboard'), '/dashboard');
  assert.equal(safeNextPath('/dashboard/cases/abc-123'), '/dashboard/cases/abc-123');
  assert.equal(safeNextPath('/dashboard/cases?status=pending'), '/dashboard/cases?status=pending');
});

test('rejects anything that could leave the site (open-redirect attempts)', () => {
  const attacks = [
    'https://evil.example',
    'http://evil.example/dashboard',
    '//evil.example',
    '//evil.example/dashboard',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'dashboard',
    '',
    ' /dashboard',
    '/dash\nboard',
    '/dash\u0000board',
    '/dash\u007fboard',
  ];
  for (const attack of attacks) {
    assert.equal(safeNextPath(attack), '/dashboard', `must reject: ${JSON.stringify(attack)}`);
  }
});

test('rejects non-string input and honours a custom fallback', () => {
  assert.equal(safeNextPath(null), '/dashboard');
  assert.equal(safeNextPath(undefined), '/dashboard');
  assert.equal(safeNextPath(['/dashboard']), '/dashboard');
  assert.equal(safeNextPath({ toString: () => '/x' }), '/dashboard');
  assert.equal(safeNextPath('https://evil.example', '/home'), '/home');
});
