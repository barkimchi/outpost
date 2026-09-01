import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegex, matchesRequest, toMatchable, type MatchableRequest } from './match.js';
import type { RequestEvent } from '@gym/shared';

function req(overrides: Partial<MatchableRequest> = {}): MatchableRequest {
  return {
    method: 'GET',
    pathLower: '/github/user',
    query: {},
    headerNames: [],
    ...overrides,
  };
}

test('matches on method and pathPattern', () => {
  assert.equal(matchesRequest({ method: 'GET', pathPattern: '^/github/user$' }, req()), true);
  assert.equal(matchesRequest({ method: 'POST', pathPattern: '^/github/user$' }, req()), false);
});

test('method as an array matches any listed method', () => {
  const matcher = { method: ['GET', 'POST'], pathPattern: '^/github/user$' };
  assert.equal(matchesRequest(matcher, req({ method: 'GET' })), true);
  assert.equal(matchesRequest(matcher, req({ method: 'POST' })), true);
  assert.equal(matchesRequest(matcher, req({ method: 'DELETE' })), false);
});

test('method matching is case-insensitive', () => {
  assert.equal(matchesRequest({ method: 'get', pathPattern: '^/github/user$' }, req({ method: 'GET' })), true);
});

test('no method on the matcher means any method matches', () => {
  assert.equal(matchesRequest({ pathPattern: '^/github/user$' }, req({ method: 'DELETE' })), true);
});

test('pathPattern is anchored: a prefix or suffix match is not enough', () => {
  const matcher = { pathPattern: '^/github/user$' };
  assert.equal(matchesRequest(matcher, req({ pathLower: '/github/user' })), true);
  assert.equal(matchesRequest(matcher, req({ pathLower: '/github/user/repos' })), false);
  assert.equal(matchesRequest(matcher, req({ pathLower: '/api/github/user' })), false);
});

test('pathPattern matches against pathLower, never a differently-cased path', () => {
  const matcher = { pathPattern: '^/github/user$' };
  // pathLower is always already-lowercased by requestLog before it ever reaches here; a
  // matcher written in lowercase must not accidentally match an uppercase pathLower.
  assert.equal(matchesRequest(matcher, req({ pathLower: '/GitHub/user' })), false);
});

test('queryIncludes requires an exact value match on every listed key', () => {
  const matcher = { pathPattern: '^/github/user/repos$', queryIncludes: { per_page: '2', page: '2' } };
  assert.equal(matchesRequest(matcher, req({ pathLower: '/github/user/repos', query: { per_page: '2', page: '2' } })), true);
  assert.equal(matchesRequest(matcher, req({ pathLower: '/github/user/repos', query: { per_page: '2', page: '1' } })), false);
  assert.equal(matchesRequest(matcher, req({ pathLower: '/github/user/repos', query: {} })), false);
});

test('reqHeaderPresent requires every listed header name to be present, case-insensitively', () => {
  const matcher = { pathPattern: '^/slack/webhook/events$', reqHeaderPresent: ['X-Slack-Signature'] };
  assert.equal(
    matchesRequest(matcher, req({ pathLower: '/slack/webhook/events', headerNames: ['x-slack-signature'] })),
    true,
  );
  assert.equal(matchesRequest(matcher, req({ pathLower: '/slack/webhook/events', headerNames: [] })), false);
});

test('toMatchable derives headerNames as lowercase from a RequestEvent', () => {
  const ev = {
    method: 'GET',
    pathLower: '/github/user',
    query: {},
    reqHeaders: { Authorization: 'token x', 'X-Custom': '1' },
  } as unknown as RequestEvent;
  const m = toMatchable(ev);
  assert.deepEqual(m.headerNames.sort(), ['authorization', 'x-custom']);
});

test('escapeRegex neutralizes regex metacharacters', () => {
  const pattern = new RegExp(`^${escapeRegex('a.b+c(d)')}$`);
  assert.equal(pattern.test('a.b+c(d)'), true);
  assert.equal(pattern.test('aXbYcYd'), false);
});
