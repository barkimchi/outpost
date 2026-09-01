import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';

async function listen() {
  // OS-assigned ephemeral port (0), never a fixed literal: this project's tests never
  // bind a real port number, to avoid colliding with a running dev server, this
  // machine's permanently reserved ports (docs/SPEC.md section 2), or anything else
  // already listening. Bound to 127.0.0.1 explicitly, not a bare listen(0): see
  // docs/SPEC.md section 2a (the IPv6-wildcard/IPv4-fetch mismatch).
  const app = createApp({ production: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('proxy rejects a non-localhost target with 400', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/proxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: 'https://api.github.com/user', headers: {} }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'Bad Request');
  } finally {
    server.close();
  }
});

test('proxy rejects a target on a different port than this server is actually listening on', async () => {
  const { server, port } = await listen();
  try {
    const otherPort = port === 65000 ? 65001 : 65000;
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/proxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: `http://127.0.0.1:${otherPort}/whatever`, headers: {} }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('proxy rejects a target on the right port but a non-allowlisted hostname', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/proxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: `http://example.com:${port}/whatever`, headers: {} }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('proxy allows a genuine request to this server itself and returns it verbatim', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/proxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        url: `http://127.0.0.1:${port}/_trainer/api/health`,
        headers: {},
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: number; body: string; timeMs: number; sizeBytes: number };
    assert.equal(body.status, 200);
    const inner = JSON.parse(body.body) as { ok: boolean };
    assert.equal(inner.ok, true);
    assert.equal(typeof body.timeMs, 'number');
    assert.equal(typeof body.sizeBytes, 'number');
  } finally {
    server.close();
  }
});
