import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssertion, evaluateAssertions, resolveJsonPath } from './assert.js';
import type { RequestEvent } from '@gym/shared';

function ev(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    id: 'ev-1',
    ts: 0,
    method: 'GET',
    path: '/github/user',
    pathLower: '/github/user',
    query: {},
    platform: 'github',
    reqHeaders: {},
    reqBody: null,
    reqBodyTruncated: false,
    status: 200,
    resHeaders: {},
    resBody: null,
    resBodyTruncated: false,
    durationMs: 1,
    source: 'external',
    ...overrides,
  };
}

test('resolveJsonPath: dotted and bracket paths, and empty string means root', () => {
  const root = { a: { b: [{ c: 'x' }, { c: 'y' }] } };
  assert.deepEqual(resolveJsonPath(root, ''), { found: true, value: root });
  assert.deepEqual(resolveJsonPath(root, 'a.b[1].c'), { found: true, value: 'y' });
  assert.deepEqual(resolveJsonPath(root, 'a.missing'), { found: false, value: undefined });
  assert.deepEqual(resolveJsonPath(root, 'a.b[9].c'), { found: false, value: undefined });
});

test('status assertion pass and a human reason on failure', () => {
  assert.deepEqual(evaluateAssertion({ kind: 'status', equals: 200 }, ev({ status: 200 })), { pass: true });
  const fail = evaluateAssertion({ kind: 'status', equals: 200 }, ev({ status: 401 }));
  assert.equal(fail.pass, false);
  assert.match(fail.reason ?? '', /expected status 200, got 401/);
});

test('statusIn assertion', () => {
  assert.equal(evaluateAssertion({ kind: 'statusIn', oneOf: [200, 201] }, ev({ status: 201 })).pass, true);
  assert.equal(evaluateAssertion({ kind: 'statusIn', oneOf: [200, 201] }, ev({ status: 404 })).pass, false);
});

test('jsonPath equals, matches, and exists variants', () => {
  const withBody = ev({ resBody: JSON.stringify({ login: 'jdoe', repos: [] }) });
  assert.equal(evaluateAssertion({ kind: 'jsonPath', path: 'login', equals: 'jdoe' }, withBody).pass, true);
  const bad = evaluateAssertion({ kind: 'jsonPath', path: 'login', equals: 'other' }, withBody);
  assert.equal(bad.pass, false);
  assert.match(bad.reason ?? '', /expected 'login' to equal "other", got "jdoe"/);

  assert.equal(evaluateAssertion({ kind: 'jsonPath', path: 'login', matches: '^j' }, withBody).pass, true);
  assert.equal(evaluateAssertion({ kind: 'jsonPath', path: 'login', exists: true }, withBody).pass, true);
  assert.equal(evaluateAssertion({ kind: 'jsonPath', path: 'missing', exists: false }, withBody).pass, true);

  const notJson = ev({ resBody: 'not json' });
  assert.equal(evaluateAssertion({ kind: 'jsonPath', path: 'login', exists: true }, notJson).pass, false);
});

test('jsonArrayLength: min, max, equals, and root array via empty path', () => {
  const arr3 = ev({ resBody: JSON.stringify([1, 2, 3]) });
  assert.equal(evaluateAssertion({ kind: 'jsonArrayLength', path: '', equals: 3 }, arr3).pass, true);
  assert.equal(evaluateAssertion({ kind: 'jsonArrayLength', path: '', min: 1 }, arr3).pass, true);
  assert.equal(evaluateAssertion({ kind: 'jsonArrayLength', path: '', max: 2 }, arr3).pass, false);

  const notArray = ev({ resBody: JSON.stringify({ x: 1 }) });
  const result = evaluateAssertion({ kind: 'jsonArrayLength', path: '', min: 1 }, notArray);
  assert.equal(result.pass, false);
  assert.match(result.reason ?? '', /expected an array/);
});

test('headerEquals and headerMatches are case-insensitive on header name', () => {
  const withHeader = ev({ resHeaders: { 'X-RateLimit-Remaining': '0' } });
  assert.equal(evaluateAssertion({ kind: 'headerEquals', name: 'x-ratelimit-remaining', equals: '0' }, withHeader).pass, true);
  assert.equal(evaluateAssertion({ kind: 'headerMatches', name: 'x-ratelimit-remaining', matches: '^0$' }, withHeader).pass, true);
  const missing = evaluateAssertion({ kind: 'headerEquals', name: 'x-nope', equals: '1' }, withHeader);
  assert.match(missing.reason ?? '', /\(missing\)/);
});

test('bodyMatches and reqHeaderMatches', () => {
  assert.equal(evaluateAssertion({ kind: 'bodyMatches', matches: 'inventory-api' }, ev({ resBody: 'x inventory-api y' })).pass, true);
  assert.equal(
    evaluateAssertion({ kind: 'reqHeaderMatches', name: 'authorization', matches: '^token ' }, ev({ reqHeaders: { authorization: 'token abc' } })).pass,
    true,
  );
});

test('reqJsonPath reads the request body', () => {
  const withReqBody = ev({ reqBody: JSON.stringify({ rootCause: 'x' }) });
  assert.equal(evaluateAssertion({ kind: 'reqJsonPath', path: 'rootCause', equals: 'x' }, withReqBody).pass, true);
});

test('custom assertion: unknown id fails with a clear reason, known id delegates', () => {
  const unknown = evaluateAssertion({ kind: 'custom', id: 'nope' }, ev(), {});
  assert.equal(unknown.pass, false);
  assert.match(unknown.reason ?? '', /unknown custom assertion id/);

  const known = evaluateAssertion({ kind: 'custom', id: 'always-pass' }, ev(), {
    'always-pass': () => ({ pass: true }),
  });
  assert.equal(known.pass, true);
});

test('evaluateAssertions stops at and reports the FIRST failing assertion', () => {
  const result = evaluateAssertions(
    [
      { kind: 'status', equals: 200 },
      { kind: 'jsonPath', path: 'login', equals: 'never-checked-because-status-failed-first' },
    ],
    ev({ status: 401, resBody: JSON.stringify({ login: 'jdoe' }) }),
  );
  assert.equal(result.pass, false);
  assert.match(result.reason ?? '', /expected status 200, got 401/);
});

test('evaluateAssertions passes only when every assertion passes', () => {
  const result = evaluateAssertions(
    [
      { kind: 'status', equals: 200 },
      { kind: 'jsonPath', path: 'login', equals: 'jdoe' },
    ],
    ev({ status: 200, resBody: JSON.stringify({ login: 'jdoe' }) }),
  );
  assert.deepEqual(result, { pass: true });
});
