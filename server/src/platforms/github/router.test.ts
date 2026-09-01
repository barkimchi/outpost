import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createGithubRouter } from './router.js';
import { activeWorld, resetState } from '../world.js';
import { buildTestRunContext } from '../../testSupport/runContext.js';

function buildApp() {
  const app = express();
  app.use('/github', createGithubRouter());
  return app;
}

async function listen() {
  const server = buildApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('a bad token returns 401 Bad credentials, byte-exact', async () => {
  resetState(buildTestRunContext());
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user`, {
      headers: { authorization: 'Bearer this-token-was-never-issued' },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, {
      message: 'Bad credentials',
      documentation_url: 'https://docs.github.com/rest',
      status: '401',
    });
  } finally {
    server.close();
  }
});

test('accepts Authorization: token X', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { login: string };
    assert.equal(body.login, ctx.user.login);
  } finally {
    server.close();
  }
});

test('accepts Authorization: Bearer X', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user`, {
      headers: { authorization: `Bearer ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('a revoked PAT (valid: false in the World) still 401s', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user`, {
      headers: { authorization: `token ${ctx.github.revokedPat}` },
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('wrong method on a GET-only path returns 405 with an Allow header', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user`, {
      method: 'POST',
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
    const body = await res.json();
    assert.deepEqual(body, {
      message: 'Method Not Allowed',
      documentation_url: 'https://docs.github.com/rest',
    });
  } finally {
    server.close();
  }
});

test('GET /user/repos paginates with per_page and page, and sets a Link header', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user/repos?per_page=2&page=2`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ name: string }>;
    // 4 repos in the fixture, per_page=2: page 2 is repos[2] and repos[3].
    assert.equal(body.length, 2);
    assert.equal(body[0]?.name, ctx.github.repos[2]?.name);
    assert.equal(body[1]?.name, ctx.github.repos[3]?.name);
    const link = res.headers.get('link') ?? '';
    assert.match(link, /rel="prev"/);
    assert.match(link, /rel="first"/);
    assert.doesNotMatch(link, /rel="next"/, 'page 2 of 2 has no next page');
  } finally {
    server.close();
  }
});

test('GET /user/repos defaults per_page to 30', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user/repos`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown[];
    assert.equal(body.length, ctx.github.repos.length);
    assert.equal(res.headers.get('link'), null, 'a single page must not carry a Link header');
  } finally {
    server.close();
  }
});

test('GET /rate_limit reports the token record and does not itself consume budget', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res1 = await fetch(`http://127.0.0.1:${port}/github/rate_limit`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    const body1 = (await res1.json()) as { resources: { core: { remaining: number } } };
    const res2 = await fetch(`http://127.0.0.1:${port}/github/rate_limit`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    const body2 = (await res2.json()) as { resources: { core: { remaining: number } } };
    assert.equal(body1.resources.core.remaining, ctx.github.rateLimit);
    assert.equal(body2.resources.core.remaining, ctx.github.rateLimit);
  } finally {
    server.close();
  }
});

test('a private repo returns 404, not 403, to a token lacking the repo scope', async () => {
  const ctx = buildTestRunContext({
    github: {
      ...buildTestRunContext().github,
      scopes: ['read:org'], // deliberately missing "repo"
    },
  });
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/repos/${ctx.github.org}/${ctx.github.privateRepo}`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 404, 'GitHub privacy behavior: a private repo the token cannot see 404s, never 403s');
    const body = await res.json();
    assert.deepEqual(body, {
      message: 'Not Found',
      documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository',
      status: '404',
    });
  } finally {
    server.close();
  }
});

test('a public repo is visible even without the repo scope', async () => {
  const ctx = buildTestRunContext({
    github: { ...buildTestRunContext().github, scopes: ['read:org'] },
  });
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const publicRepo = ctx.github.repos.find((r) => !r.private);
    assert.ok(publicRepo, 'test fixture must include at least one public repo');
    const res = await fetch(`http://127.0.0.1:${port}/github/repos/${ctx.github.org}/${publicRepo.name}`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('a nonexistent repo returns the same 404 as a private one', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/repos/${ctx.github.org}/this-repo-was-never-created`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('missing read:org scope returns 403 with accurate X-OAuth-Scopes and X-Accepted-OAuth-Scopes', async () => {
  const ctx = buildTestRunContext({
    github: { ...buildTestRunContext().github, scopes: ['repo'] }, // deliberately missing read:org
  });
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/orgs/${ctx.github.org}/repos`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.deepEqual(body, {
      message: 'Resource not accessible by personal access token',
      documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository',
      status: '403',
    });
    assert.equal(res.headers.get('x-oauth-scopes'), 'repo');
    assert.equal(res.headers.get('x-accepted-oauth-scopes'), 'read:org');
  } finally {
    server.close();
  }
});

test('GET /orgs/:org/repos succeeds once read:org is granted', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/orgs/${ctx.github.org}/repos`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('rate limit exhausted returns 403 with x-ratelimit-remaining: 0 and a real reset epoch', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const record = activeWorld().github.tokens[ctx.github.validPat];
  assert.ok(record);
  record.rateLimit.remaining = 0;
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user`, {
      headers: { authorization: `token ${ctx.github.validPat}` },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('x-ratelimit-remaining'), '0');
    const resetHeader = Number(res.headers.get('x-ratelimit-reset'));
    assert.ok(Number.isFinite(resetHeader) && resetHeader > Math.floor(Date.now() / 1000) - 60);
    const body = await res.json();
    assert.deepEqual(body, {
      message: `API rate limit exceeded for user ID ${ctx.user.id}.`,
      documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
      status: '403',
    });
  } finally {
    server.close();
  }
});

test('the second PAT has its own rate-limit budget, independent of the first', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const record = activeWorld().github.tokens[ctx.github.validPat];
  assert.ok(record);
  record.rateLimit.remaining = 0;
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user`, {
      headers: { authorization: `token ${ctx.github.secondPat}` },
    });
    assert.equal(res.status, 200, 'the second PAT must still work once the first is exhausted');
  } finally {
    server.close();
  }
});

test('activating the same scenario twice yields a valid PAT that changes, and the old one stops working', async () => {
  const run1 = buildTestRunContext();
  resetState(run1);
  const { server: server1, port: port1 } = await listen();
  try {
    const res1 = await fetch(`http://127.0.0.1:${port1}/github/user`, {
      headers: { authorization: `token ${run1.github.validPat}` },
    });
    assert.equal(res1.status, 200);
  } finally {
    server1.close();
  }

  const run2 = buildTestRunContext({
    github: { ...run1.github, validPat: `ghp_${'9'.repeat(36)}` },
  });
  resetState(run2);
  const { server: server2, port: port2 } = await listen();
  try {
    const res2 = await fetch(`http://127.0.0.1:${port2}/github/user`, {
      headers: { authorization: `token ${run1.github.validPat}` },
    });
    assert.equal(res2.status, 401, "run 1's valid PAT must not solve run 2");
  } finally {
    server2.close();
  }
});
