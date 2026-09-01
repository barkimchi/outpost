import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { getDoc, listDocs } from '../content/index.js';
import { scenarioRegistry } from '../scenarios/index.js';

/**
 * Docs tab endpoints (docs/SPEC.md section 10): `GET /_trainer/api/docs`,
 * `GET /_trainer/api/docs/:id`, backed by `content/index.ts`'s registry. Mirrors
 * `app.test.ts`'s own ephemeral-port boot pattern (never a fixed literal port, `127.0.0.1`
 * explicitly per docs/SPEC.md section 2a).
 */

async function listen() {
  const webDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-docs-test-'));
  const app = createApp({ webDistDir, production: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('content/index.ts: listDocs returns the registered docs, github and google-oauth among them', () => {
  const ids = listDocs().map((d) => d.id);
  assert.ok(ids.includes('github'));
  assert.ok(ids.includes('google-oauth'));
  assert.ok(ids.includes('variables'));
  assert.ok(ids.includes('auth-methods'));
  // Task 8: the implementation track is meant to be solvable from these three alone, so
  // each one is a real, proven-present consumer of a registry entry, not just a file that
  // happens to sit in content/docs/.
  assert.ok(ids.includes('glean'));
  assert.ok(ids.includes('slack'));
  assert.ok(ids.includes('scripting'));
});

test('content/index.ts: getDoc reads real, non-stub markdown for every registered id', () => {
  for (const summary of listDocs()) {
    const doc = getDoc(summary.id);
    assert.ok(doc, `expected a doc for id ${summary.id}`);
    assert.equal(doc?.id, summary.id);
    assert.equal(doc?.title, summary.title);
    // A guard against a lorem-ipsum placeholder ever landing here quietly: real reference
    // content for a whole platform's auth model and endpoint list runs well past 200 chars.
    assert.ok((doc?.md.length ?? 0) > 200, `${summary.id} doc should have real content, not a stub`);
  }
});

test('every scenario\'s docsRef resolves to a real registered doc id, and every registered doc is referenced by at least one scenario (Task 8 fix round, finding 5)', () => {
  const registeredIds = new Set(listDocs().map((d) => d.id));
  const referencedIds = new Set<string>();
  for (const def of scenarioRegistry) {
    for (const docId of def.docsRef) {
      assert.ok(
        registeredIds.has(docId),
        `${def.id}'s docsRef references "${docId}", which content/index.ts does not register`,
      );
      referencedIds.add(docId);
    }
  }
  // The other direction: content/index.ts claims every registered doc exists to be
  // solvable from (this task's own header comment); a doc with zero consumers is exactly
  // the authored-but-unread pattern hard constraint 7b exists to catch. Would fail if
  // t5-slack.ts's t5-hmac-signature ever dropped 'scripting' from its docsRef again,
  // since nothing else references it.
  for (const id of registeredIds) {
    assert.ok(referencedIds.has(id), `doc "${id}" is registered but no scenario's docsRef references it`);
  }
});

test('content/index.ts: getDoc returns null for an id nothing registers', () => {
  assert.equal(getDoc('does-not-exist'), null);
});

test('GET /_trainer/api/docs lists exactly the same ids as the registry', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/docs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string; title: string; platform: string }>;
    assert.deepEqual(
      body.map((d) => d.id).sort(),
      listDocs()
        .map((d) => d.id)
        .sort(),
    );
  } finally {
    server.close();
  }
});

test('GET /_trainer/api/docs/:id returns the markdown body for a real id, 404 for a bogus one', async () => {
  const { server, port } = await listen();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/_trainer/api/docs/github`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { id: string; title: string; md: string };
    assert.equal(body.id, 'github');
    assert.match(body.md, /GitHub REST API/);

    const missing = await fetch(`http://127.0.0.1:${port}/_trainer/api/docs/nope`);
    assert.equal(missing.status, 404);
    const missingBody = (await missing.json()) as { error: string };
    assert.equal(missingBody.error, 'Not Found');
  } finally {
    server.close();
  }
});
