import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, type CreateAppOptions } from './app.js';
import { bus } from './bus.js';
import type { RequestEvent } from '@gym/shared';

/**
 * App-level scaffold tests. Boots createApp() on an OS-assigned ephemeral port (never a
 * fixed literal, so this never collides with a running dev server, this machine's
 * permanently reserved ports (docs/SPEC.md section 2), or anything else already
 * listening) and exercises it with real HTTP requests.
 *
 * webDistDir is always an isolated temp directory created per test, never the repo's
 * real web/dist. That keeps these tests deterministic whether or not `npm run build`
 * has run before `npm test`.
 *
 * `production` defaults to true here: these tests are about the static/SPA-fallback
 * behavior spec section 6 step 6 scopes to "prod only", so they opt in explicitly rather
 * than depending on ambient NODE_ENV (which `npm test` does not set).
 */

async function listen(webDistDir?: string, options: Omit<CreateAppOptions, 'webDistDir'> = {}) {
  const app = createApp({ webDistDir, production: true, ...options });
  // 127.0.0.1, not a bare listen(0): a bare listen(0) binds the IPv6 wildcard `::`
  // dual-stack, and macOS's ephemeral-port allocator does not treat an existing IPv4
  // wildcard listener as a conflict, so it can hand out a port another process (Spotify,
  // Tailscale, a concurrently running test file) already serves on IPv4. fetch() dials
  // IPv4, so the request would silently land on that foreign process instead of this
  // server (docs/SPEC.md section 2a).
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

async function emptyTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pg-app-test-'));
}

test('GET /_trainer/api/health returns ok, version, and port', async () => {
  const webDistDir = await emptyTempDir();
  const { server, port } = await listen(webDistDir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; version: string; port: number };
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.port, 'number');
  } finally {
    server.close();
  }
});

test('GET /nope returns 404 JSON when no build exists', async () => {
  const webDistDir = await emptyTempDir();
  const { server, port } = await listen(webDistDir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'Not Found');
  } finally {
    server.close();
  }
});

test('SPA fallback serves index.html for an unknown non-platform route once a build exists', async () => {
  const webDistDir = await emptyTempDir();
  await fs.writeFile(path.join(webDistDir, 'index.html'), '<!doctype html><title>gym</title>');
  const { server, port } = await listen(webDistDir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/some/client-side/route`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<title>gym<\/title>/);
  } finally {
    server.close();
  }
});

test('platform prefixes are never swallowed by the SPA fallback, even once a build exists', async () => {
  const webDistDir = await emptyTempDir();
  await fs.writeFile(path.join(webDistDir, 'index.html'), '<!doctype html><title>gym</title>');
  const { server, port } = await listen(webDistDir);
  try {
    for (const prefix of ['/github', '/google', '/glean', '/slack', '/_trainer']) {
      const res = await fetch(`http://127.0.0.1:${port}${prefix}/anything`);
      // No routers exist yet for the platform prefixes (Task 2), so these must fall
      // through to the JSON 404, never to the SPA's index.html, even though index.html
      // exists in this test.
      assert.equal(res.status, 404, `${prefix} should not be swallowed by the SPA fallback`);
      const contentType = res.headers.get('content-type') ?? '';
      assert.ok(contentType.includes('application/json'), `${prefix} should return JSON, not HTML`);
    }
  } finally {
    server.close();
  }
});

test('platform prefixes are guarded case-insensitively', async () => {
  const webDistDir = await emptyTempDir();
  await fs.writeFile(path.join(webDistDir, 'index.html'), '<!doctype html><title>gym</title>');
  const { server, port } = await listen(webDistDir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/GitHub/user`);
    // Task 2 mounted a real /github router. Express's default mount-path matching is
    // case-insensitive, so /GitHub/user resolves to that router's own GET /user handler
    // and correctly 401s for a request with no Authorization header, rather than the
    // generic 404 this test checked back when no router existed for the prefix yet. The
    // assertion that actually matters is unchanged: this must never be the SPA shell.
    assert.equal(res.status, 401);
    const contentType = res.headers.get('content-type') ?? '';
    assert.ok(contentType.includes('application/json'), '/GitHub/user should return JSON, not the SPA shell');
    const text = await res.text();
    assert.doesNotMatch(text, /<title>gym<\/title>/, '/GitHub/user must never be swallowed by the SPA shell');
  } finally {
    server.close();
  }
});

test('outside production, the static/SPA fallback is not mounted at all', async () => {
  const webDistDir = await emptyTempDir();
  await fs.writeFile(path.join(webDistDir, 'index.html'), '<!doctype html><title>gym</title>');
  const { server, port } = await listen(webDistDir, { production: false });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/some/client-side/route`);
    // Regression check for the Task 0 review finding: under `tsx` in development, this
    // used to return a stale 200 index.html instead of a 404, which made every
    // not-yet-built route look like it worked.
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'Not Found');
  } finally {
    server.close();
  }
});

test('a learner\'s malformed JSON body, sent to a real platform path through the real app wiring, still gets a correct 400 AND emits exactly one RequestEvent', async () => {
  // A learner's malformed body always lands on a platform path (either sent straight to
  // /github/... by real Postman/curl, or forwarded there as the proxy's inner request).
  // That is the traffic hard constraint 9 protects: a correct 400 must never mean total
  // engine silence. POST /github/user/repos is a real platform endpoint that reads a JSON
  // body, so this is representative of the actual learner-facing failure, not a synthetic
  // stand-in.
  const webDistDir = await emptyTempDir();
  const { server, port } = await listen(webDistDir);
  try {
    const seen: RequestEvent[] = [];
    const onRequest = (ev: RequestEvent): void => {
      seen.push(ev);
    };
    bus.on('request', onRequest);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/github/user/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not valid json',
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, 'Bad Request');

      // Give the bus a moment; the event is emitted synchronously inside the error
      // handler, but this keeps the assertion robust either way.
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(
        seen.length,
        1,
        'rawBody mounts above requestLog, so a malformed body on a real platform path used to reach the ' +
          'error handler with total engine silence (hard constraint 9)',
      );
      assert.equal(seen[0]?.status, 400);
      assert.equal(seen[0]?.path, '/github/user/repos');
      assert.equal(seen[0]?.pathLower, '/github/user/repos');
      assert.equal(seen[0]?.method, 'POST');
    } finally {
      bus.off('request', onRequest);
    }
  } finally {
    server.close();
  }
});

test('a malformed /_trainer/api/proxy envelope (our own UI\'s bug, not a learner action) still gets a correct 400 to the caller but emits ZERO RequestEvents', async () => {
  // A malformed /_trainer/api/proxy envelope is trainer control-plane chatter, not
  // evidence of a learner's attempt: the realistic malformed-body lesson is solved by
  // sending invalid JSON as the platform request's body (the test above), which the proxy
  // forwards as a fresh, separately-logged inbound request to the platform path. A bad
  // envelope straight to /_trainer/api/proxy itself must stay silent, same as the rest of
  // /_trainer.
  const webDistDir = await emptyTempDir();
  const { server, port } = await listen(webDistDir);
  try {
    const seen: RequestEvent[] = [];
    const onRequest = (ev: RequestEvent): void => {
      seen.push(ev);
    };
    bus.on('request', onRequest);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/proxy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not valid json',
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, 'Bad Request');

      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(
        seen.length,
        0,
        'a malformed /_trainer/api/proxy envelope is our own UI\'s bug, not a learner action; it must stay ' +
          'silent even though the caller still gets a correct 400',
      );
    } finally {
      bus.off('request', onRequest);
    }
  } finally {
    server.close();
  }
});
