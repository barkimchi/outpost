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
    assert.equal(((await before.json()) as { status: string }).status, 'NOT_FOUND');

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
    assert.equal(((await after.json()) as { status: string }).status, 'INDEXED');
    assert.ok(activeWorld().glean.indexedDocs['doc-bulk-2']);
  } finally {
    server.close();
  }
});
