import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';

/**
 * Task 0 scaffold tests. Boots createApp() on an ephemeral port (never 4700, so this
 * never collides with a running dev server or with anything else already on the
 * machine) and exercises it with real HTTP requests.
 *
 * webDistDir is always an isolated temp directory created per test, never the repo's
 * real web/dist. That keeps these tests deterministic whether or not `npm run build`
 * has run before `npm test`.
 */

async function listen(webDistDir?: string) {
  const app = createApp({ webDistDir });
  const server = app.listen(0);
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
      // No routers exist yet in Task 0, so these must fall through to the JSON 404,
      // never to the SPA's index.html, even though index.html exists in this test.
      assert.equal(res.status, 404, `${prefix} should not be swallowed by the SPA fallback`);
      const contentType = res.headers.get('content-type') ?? '';
      assert.ok(contentType.includes('application/json'), `${prefix} should return JSON, not HTML`);
    }
  } finally {
    server.close();
  }
});
