import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createGleanRouter } from './router.js';
import { activeWorld, resetState } from '../world.js';
import { buildTestRunContext } from '../../testSupport/runContext.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/glean', createGleanRouter());
  return app;
}

async function listen() {
  // 127.0.0.1, not a bare listen(0): see docs/SPEC.md section 2a.
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('search with the client token succeeds and returns matching results', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: ctx.glean.docs[0]?.title, pageSize: 10 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: unknown[] };
    assert.ok(body.results.length >= 1);
  } finally {
    server.close();
  }
});

test('search with the indexing token (the wrong kind of token) returns 401, not the client token error', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'anything', pageSize: 10 }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'authentication_required');
    // Task-7 brief: "nothing about the error says wrong kind of token". Confirm the
    // failure text never names either token type explicitly.
    const raw = JSON.stringify(body).toLowerCase();
    assert.ok(!raw.includes('indexing'), 'the 401 body must not name which kind of token was expected');
    assert.ok(!raw.includes('client api'), 'the 401 body must not name which kind of token was expected');
  } finally {
    server.close();
  }
});

test('search with no token, or a token that was never issued, also 401s', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const noAuth = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x', pageSize: 10 }),
    });
    assert.equal(noAuth.status, 401);

    const bogus = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer this-token-was-never-issued', 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x', pageSize: 10 }),
    });
    assert.equal(bogus.status, 401);
  } finally {
    server.close();
  }
});

test('search missing "query" returns 400 invalid_request; missing "pageSize" also 400s', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const missingQuery = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pageSize: 10 }),
    });
    assert.equal(missingQuery.status, 400);
    const bodyA = (await missingQuery.json()) as { code: string };
    assert.equal(bodyA.code, 'invalid_request');

    const missingPageSize = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'onboarding' }),
    });
    assert.equal(missingPageSize.status, 400);
  } finally {
    server.close();
  }
});

test('chat with the client token succeeds; chat with the indexing token 401s the same way search does', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ author: 'USER', fragments: [{ text: 'hi' }] }] }),
    });
    assert.equal(ok.status, 200);

    const denied = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ author: 'USER', fragments: [{ text: 'hi' }] }] }),
    });
    assert.equal(denied.status, 401);
  } finally {
    server.close();
  }
});

test('indexdocument with the indexing token stores the document; the client token is rejected the same way in reverse', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const wrongToken = await fetch(`http://127.0.0.1:${port}/glean/api/index/v1/indexdocument`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ document: { id: 'doc-x', datasource: ctx.glean.datasource, title: 'X' } }),
    });
    assert.equal(wrongToken.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/glean/api/index/v1/indexdocument`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ document: { id: 'doc-x', datasource: ctx.glean.datasource, title: 'X' } }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {});
    assert.ok(activeWorld().glean.indexedDocs['doc-x'], 'the document must actually land in World.glean.indexedDocs');

    const missingFields = await fetch(`http://127.0.0.1:${port}/glean/api/index/v1/indexdocument`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ document: { title: 'no id or datasource' } }),
    });
    assert.equal(missingFields.status, 400);
  } finally {
    server.close();
  }
});

test('indexdocuments (bulk) stores every document; getdocumentstatus reports INDEXED after, NOT_FOUND before', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const before = await fetch(
      `http://127.0.0.1:${port}/glean/api/index/v1/getdocumentstatus?id=doc-bulk-1&datasource=${ctx.glean.datasource}`,
      { headers: { authorization: `Bearer ${ctx.glean.indexingToken}` } },
    );
    assert.equal(before.status, 200);
    const beforeBody = (await before.json()) as { status: string; title?: string; indexedAt?: number };
    assert.equal(beforeBody.status, 'NOT_FOUND');

    const bulk = await fetch(`http://127.0.0.1:${port}/glean/api/index/v1/indexdocuments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        documents: [
          { id: 'doc-bulk-1', datasource: ctx.glean.datasource, title: 'A' },
          { id: 'doc-bulk-2', datasource: ctx.glean.datasource, title: 'B' },
        ],
      }),
    });
    assert.equal(bulk.status, 200);

    const after = await fetch(
      `http://127.0.0.1:${port}/glean/api/index/v1/getdocumentstatus?id=doc-bulk-1&datasource=${ctx.glean.datasource}`,
      { headers: { authorization: `Bearer ${ctx.glean.indexingToken}` } },
    );
    const afterBody = (await after.json()) as { status: string; title?: string; indexedAt?: number };
    assert.equal(afterBody.status, 'INDEXED');
    // Fix round (task-7 review, finding 2, constraint 7b): title/indexedAt used to be
    // write-only on World.glean.indexedDocs (populated at indexing time, read by nothing).
    // Now genuinely reachable over HTTP: this is their real, live consumer.
    assert.equal(afterBody.title, 'A', 'title must be echoed back from the indexed record');
    assert.ok(typeof afterBody.indexedAt === 'number' && afterBody.indexedAt > 0, 'indexedAt must be a real timestamp');

    assert.equal(beforeBody.title, undefined, 'NOT_FOUND must never carry a title');
    assert.equal(beforeBody.indexedAt, undefined, 'NOT_FOUND must never carry an indexedAt');

    assert.ok(activeWorld().glean.indexedDocs['doc-bulk-2']);
  } finally {
    server.close();
  }
});

// --- Product-coherence fix round: index a document, then find it via search. This is the
// core loop the real Glean product sells (docs/SPEC.md section 12's impl-glean rep), and
// used to be impossible: search and indexing read two entirely separate World registries.

test('the seeded corpus is searchable before anything is ever indexed', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const seededTitle = ctx.glean.docs[0]?.title;
  if (!seededTitle) throw new Error('sanity: fixture must have at least one seeded doc');
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: seededTitle, pageSize: 10 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: Array<{ title: string }> };
    assert.ok(body.results.some((r) => r.title === seededTitle));
  } finally {
    server.close();
  }
});

test('a document indexed with an indexing token is found by search with a client token: the core product loop', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    // A search for this exact phrase must return NOTHING before indexing: proves the
    // subsequent hit is really caused by indexing, not a coincidental seeded match.
    const before = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'zzyzx quarterly compliance memo', pageSize: 10 }),
    });
    const beforeBody = (await before.json()) as { results: unknown[] };
    assert.equal(beforeBody.results.length, 0, 'sanity: this phrase must not match any seeded doc');

    const indexRes = await fetch(`http://127.0.0.1:${port}/glean/api/index/v1/indexdocument`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        document: {
          id: 'freshly-indexed-1',
          datasource: ctx.glean.datasource,
          title: 'Zzyzx Quarterly Compliance Memo',
          body: { textContent: 'This memo covers the zzyzx quarterly compliance checklist for the finance team.' },
        },
      }),
    });
    assert.equal(indexRes.status, 200);

    const after = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'zzyzx quarterly compliance memo', pageSize: 10 }),
    });
    assert.equal(after.status, 200);
    const afterBody = (await after.json()) as { results: Array<{ title: string; document: { id: string; datasource: string } }> };
    const hit = afterBody.results.find((r) => r.document.id === 'freshly-indexed-1');
    assert.ok(hit, 'the freshly-indexed document must come back from search');
    assert.equal(hit?.title, 'Zzyzx Quarterly Compliance Memo');
    assert.equal(hit?.document.datasource, ctx.glean.datasource);

    // A title-only match (no body text overlap) must also work, and matching is
    // case-insensitive.
    const titleOnly = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'ZZYZX QUARTERLY', pageSize: 10 }),
    });
    const titleOnlyBody = (await titleOnly.json()) as { results: Array<{ document: { id: string } }> };
    assert.ok(titleOnlyBody.results.some((r) => r.document.id === 'freshly-indexed-1'));
  } finally {
    server.close();
  }
});

test('getdocumentstatus never disagrees with search: a seeded doc reports INDEXED (no fabricated indexedAt); a freshly-indexed one matches both', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const seededDoc = ctx.glean.docs[0];
  if (!seededDoc) throw new Error('sanity: fixture must have at least one seeded doc');
  const { server, port } = await listen();
  try {
    // The seeded doc was never "indexed" this run, but search can already find it, so
    // getdocumentstatus must say so too, not NOT_FOUND.
    const seededStatus = await fetch(
      `http://127.0.0.1:${port}/glean/api/index/v1/getdocumentstatus?id=${seededDoc.id}&datasource=${ctx.glean.datasource}`,
      { headers: { authorization: `Bearer ${ctx.glean.indexingToken}` } },
    );
    const seededBody = (await seededStatus.json()) as { status: string; title?: string; indexedAt?: number };
    assert.equal(seededBody.status, 'INDEXED', 'a seeded (pre-existing) doc must report INDEXED, matching what search can already find');
    assert.equal(seededBody.title, seededDoc.title);
    assert.equal(seededBody.indexedAt, undefined, 'a seeded doc was never actually indexed this run: no fabricated timestamp');

    // Index a NEW document, then confirm both endpoints agree it exists.
    await fetch(`http://127.0.0.1:${port}/glean/api/index/v1/indexdocument`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ document: { id: 'consistency-check-1', datasource: ctx.glean.datasource, title: 'Consistency Check' } }),
    });

    const searchRes = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.glean.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Consistency Check', pageSize: 10 }),
    });
    const searchBody = (await searchRes.json()) as { results: Array<{ document: { id: string } }> };
    const foundBySearch = searchBody.results.some((r) => r.document.id === 'consistency-check-1');

    const statusRes = await fetch(
      `http://127.0.0.1:${port}/glean/api/index/v1/getdocumentstatus?id=consistency-check-1&datasource=${ctx.glean.datasource}`,
      { headers: { authorization: `Bearer ${ctx.glean.indexingToken}` } },
    );
    const statusBody = (await statusRes.json()) as { status: string; indexedAt?: number };

    assert.equal(foundBySearch, true, 'sanity: search must actually find the freshly-indexed doc');
    assert.equal(statusBody.status, 'INDEXED');
    assert.ok(typeof statusBody.indexedAt === 'number', 'a genuinely-indexed doc must carry a real indexedAt');
  } finally {
    server.close();
  }
});
