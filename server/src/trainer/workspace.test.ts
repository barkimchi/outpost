import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { DATA_DIR } from '../config.js';
import type { Workspace } from '@gym/shared';
import { defaultWorkspace } from '@gym/shared';

/**
 * `GET`/`PUT /_trainer/api/workspace` (docs/SPEC.md section 4/10/13), backed by `router.ts`'s
 * `workspaceStore` (a `JsonStore<Workspace>` over `data/workspace.json`). Mirrors
 * `app.test.ts`'s own ephemeral-port boot pattern.
 *
 * `workspaceStore` is a module-level singleton (same convention `engine/persist.ts`'s own
 * `progressStore` uses), so it is shared across every `createApp()` call within this test
 * process, not reset between tests. Every test here is written as a self-contained PUT then
 * GET round trip that asserts on the exact value it just wrote, rather than assuming a
 * pristine default, so test order and any other test file that might one day also touch
 * this endpoint cannot make these flaky.
 */

async function listen() {
  const webDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-workspace-test-'));
  const app = createApp({ webDistDir, production: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('PUT then GET /_trainer/api/workspace round-trips the full workspace', async () => {
  const { server, port } = await listen();
  try {
    const ws: Workspace = defaultWorkspace();
    ws.notes = 'round trip notes';
    ws.collections = [{ id: 'c1', name: 'GitHub', items: [] }];
    ws.environments = [
      { id: 'e1', name: 'Local', variables: [{ id: 'v1', key: 'baseUrl', value: 'http://127.0.0.1:4600/github', enabled: true }] },
    ];
    ws.activeEnvironmentId = 'e1';
    ws.draft.url = '{{baseUrl}}/user';

    const putRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/workspace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ws),
    });
    assert.equal(putRes.status, 200);
    assert.deepEqual(await putRes.json(), { ok: true });

    const getRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/workspace`);
    assert.equal(getRes.status, 200);
    const body = (await getRes.json()) as Workspace;
    assert.equal(body.notes, 'round trip notes');
    assert.deepEqual(body.collections, ws.collections);
    assert.deepEqual(body.environments, ws.environments);
    assert.equal(body.activeEnvironmentId, 'e1');
    assert.equal(body.draft.url, '{{baseUrl}}/user');
  } finally {
    server.close();
  }
});

test('PUT /_trainer/api/workspace actually reaches disk at data/workspace.json (this task\'s "restart the server" verify step)', async () => {
  // `workspaceStore` is a module-level singleton (see this file's header comment), so a
  // second `createApp()` in the same test process would just read the same in-memory
  // object back, proving nothing about the disk write. This test instead reads the real
  // file `router.ts`'s `JsonStore` writes to, independent of that singleton, which is what
  // actually surviving a real process restart depends on. The write is debounced
  // (docs/SPEC.md section 3: 250ms), so this waits past that window before reading.
  const { server, port } = await listen();
  try {
    const ws: Workspace = defaultWorkspace();
    ws.notes = 'survives a restart';
    const putRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/workspace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ws),
    });
    assert.equal(putRes.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 400));

    const onDisk = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'workspace.json'), 'utf8')) as Workspace;
    assert.equal(onDisk.notes, 'survives a restart');
  } finally {
    server.close();
  }
});

test('PUT /_trainer/api/workspace rejects an obviously malformed payload with 400, not a crash', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/workspace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonsense: true }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'Bad Request');
  } finally {
    server.close();
  }
});

/**
 * Fix round (coordinator review, finding 2): `Object.assign(current, incoming)` is a
 * merge, not a replace: a key `incoming` omits survives from whatever `current` had.
 * Every real client sends every key every time, which is exactly why this only surfaced
 * from a deliberately partial payload, not from using the app. This test writes a real,
 * non-default `activeEnvironmentId`, then PUTs a payload that passes structural
 * validation but omits that key entirely, and asserts it does NOT survive.
 */
test('PUT /_trainer/api/workspace fully replaces: a key omitted from the payload does not survive from a previous PUT', async () => {
  const { server, port } = await listen();
  try {
    const first: Workspace = defaultWorkspace();
    first.activeEnvironmentId = 'e1';
    first.environments = [{ id: 'e1', name: 'Local', variables: [] }];
    const firstPut = await fetch(`http://127.0.0.1:${port}/_trainer/api/workspace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(first),
    });
    assert.equal(firstPut.status, 200);

    // Structurally valid (satisfies isValidWorkspacePayload) but deliberately omits
    // activeEnvironmentId, simulating a partial/buggy client rather than the real one.
    const partial = {
      version: 1,
      collections: [],
      environments: [],
      notes: 'replaced, not merged',
      draft: defaultWorkspace().draft,
      ui: defaultWorkspace().ui,
    };
    const secondPut = await fetch(`http://127.0.0.1:${port}/_trainer/api/workspace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(partial),
    });
    assert.equal(secondPut.status, 200);

    const getRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/workspace`);
    const body = (await getRes.json()) as Record<string, unknown>;
    // A merge would have left activeEnvironmentId: 'e1' behind; a real replace does not.
    assert.equal(body.activeEnvironmentId, undefined);
    assert.equal(body.notes, 'replaced, not merged');
  } finally {
    server.close();
  }
});

/**
 * Fix round (coordinator review, finding 3): `version` used to be accepted unchecked, so
 * `PUT` with `version: 99` was stored and echoed back as 99. This server has only ever
 * understood version 1; anything else is rejected outright, and rejection must not touch
 * whatever was already stored.
 */
test('PUT /_trainer/api/workspace rejects an unsupported version with 400 and leaves the stored workspace untouched', async () => {
  const { server, port } = await listen();
  try {
    const good: Workspace = defaultWorkspace();
    good.notes = 'before the bad version attempt';
    const goodPut = await fetch(`http://127.0.0.1:${port}/_trainer/api/workspace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(good),
    });
    assert.equal(goodPut.status, 200);

    const bad: Record<string, unknown> = { ...defaultWorkspace(), version: 99 };
    const badPut = await fetch(`http://127.0.0.1:${port}/_trainer/api/workspace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bad),
    });
    assert.equal(badPut.status, 400);
    const badBody = (await badPut.json()) as { error: string };
    assert.equal(badBody.error, 'Bad Request');

    const getRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/workspace`);
    const stored = (await getRes.json()) as Workspace;
    assert.equal(stored.notes, 'before the bad version attempt');
  } finally {
    server.close();
  }
});
