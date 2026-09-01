import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  badCredentials,
  methodNotAllowedFixture,
  notFoundFixture,
  orgReposNotFound,
  rateLimitExceeded,
  resourceNotAccessible,
} from './fixtures.js';

// Locks each fixture to the byte-exact body given in docs/PLAN.md's Task 2 brief
// (docs/SPEC.md section 7: "the envelope and wording stay verbatim").

test('badCredentials is byte-exact', () => {
  assert.deepEqual(badCredentials(), {
    message: 'Bad credentials',
    documentation_url: 'https://docs.github.com/rest',
    status: '401',
  });
});

test('rateLimitExceeded interpolates only the user id', () => {
  assert.deepEqual(rateLimitExceeded(90001), {
    message: 'API rate limit exceeded for user ID 90001.',
    documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
    status: '403',
  });
});

test('resourceNotAccessible is byte-exact', () => {
  assert.deepEqual(resourceNotAccessible(), {
    message: 'Resource not accessible by personal access token',
    documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository',
    status: '403',
  });
});

test('notFoundFixture is byte-exact', () => {
  assert.deepEqual(notFoundFixture(), {
    message: 'Not Found',
    documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository',
    status: '404',
  });
});

test('orgReposNotFound is byte-exact and uses the list-organization-repositories anchor', () => {
  assert.deepEqual(orgReposNotFound(), {
    message: 'Not Found',
    documentation_url: 'https://docs.github.com/rest/repos/repos#list-organization-repositories',
    status: '404',
  });
});

test('methodNotAllowedFixture is byte-exact and has no status field', () => {
  const body = methodNotAllowedFixture();
  assert.deepEqual(body, {
    message: 'Method Not Allowed',
    documentation_url: 'https://docs.github.com/rest',
  });
  assert.equal(Object.keys(body).length, 2);
});
