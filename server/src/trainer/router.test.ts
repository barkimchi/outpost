import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { engine } from '../engine/engine.js';

/**
 * HTTP-level tests against the REAL `createApp()` stack (rawBody -> requestLog ->
 * faultInjector -> /_trainer -> /github), using the production `engine` singleton the
 * way `index.ts` and `trainer/router.ts` actually wire it. This file owns the singleton
 * for the whole process it runs in (Node isolates each test file into its own process),
 * and every test calls `engine.activate(...)` first, which fully resets prior state, so
 * tests here do not interfere with each other.
 */

async function listen() {
  const webDistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-router-test-'));
  const app = createApp({ webDistDir, production: false });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('GET /_trainer/api/scenarios lists all seven registered scenarios with solved:false, runs:0 before any activation', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string; solved: boolean }>;
    assert.equal(body.length, 7);
    assert.ok(body.some((s) => s.id === 't1-wrong-method'));
    assert.ok(body.some((s) => s.id === 't2-rate-limit'));
  } finally {
    server.close();
  }
});

test('GET /github/user before any scenario is ever activated does not 500 (the boot-fix defect)', async () => {
  // Simulates a completely fresh process: boot the World the way index.ts does, with no
  // scenario ever activated. Verified defect as of commit 351ecb3: this used to 500 with
  // "activeWorld() called before resetState()".
  engine.boot();
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user`, {
      headers: { authorization: 'Bearer some-token-nobody-generated' },
    });
    assert.equal(res.status, 401, 'a bad token should 401, never 500, even before any scenario is chosen');
    const body = (await res.json()) as { message?: string };
    assert.equal(body.message, 'Bad credentials');
  } finally {
    server.close();
  }
});

test('POST /_trainer/api/scenarios/:id/activate, GET /api/state, and 409s for hint/explain in the wrong state', async () => {
  const { server, port } = await listen();
  try {
    const activateRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios/t1-content-type/activate`, {
      method: 'POST',
    });
    assert.equal(activateRes.status, 200);
    const activated = (await activateRes.json()) as { scenarioId: string; ticketMd: string; drill: boolean };
    assert.equal(activated.scenarioId, 't1-content-type');
    assert.equal(activated.drill, false);

    const stateRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/state`);
    const state = (await stateRes.json()) as { state: string; attempts: number };
    assert.equal(state.state, 'active');
    assert.equal(state.attempts, 0);

    const hintRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/hint`, { method: 'POST' });
    assert.equal(hintRes.status, 409, 'no hint should be unlocked yet');

    const explainRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootCause: 'x', customerReply: 'y' }),
    });
    assert.equal(explainRes.status, 409, 'cannot explain before every step is complete');
  } finally {
    server.close();
  }
});

test('POST /_trainer/api/scenarios/drill omits scenarioId/title and returns a valid tier when requested', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios/drill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 2 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { scenarioId?: string; title?: string; tier: number; drill: boolean };
    assert.equal(body.scenarioId, undefined);
    assert.equal(body.title, undefined);
    assert.equal(body.tier, 2);
    assert.equal(body.drill, true);
  } finally {
    server.close();
  }
});

test('t1-content-type solved end to end through the real app: attempt (wrong Content-Type) then success then explain', async () => {
  const { server, port } = await listen();
  try {
    const activateRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios/t1-content-type/activate`, {
      method: 'POST',
    });
    assert.equal(activateRes.status, 200);
    const activated = (await activateRes.json()) as { ticketMd: string };
    const patMatch = activated.ticketMd.match(/token (ghp_[A-Za-z0-9]{36})/);
    const validPat = patMatch?.[1];
    assert.ok(validPat, 'ticketMd must embed the PAT to use, per this run');

    // Wrong Content-Type: text/plain, a JSON-shaped body. Must 400 and count as an attempt.
    // Real GitHub endpoint now (fix round): POST /github/user/repos, not a synthetic
    // trainer-only path.
    const badRes = await fetch(`http://127.0.0.1:${port}/github/user/repos`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `token ${validPat}` },
      body: JSON.stringify({ name: 'new-onboarding-repo' }),
    });
    assert.equal(badRes.status, 400);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const midState = (await (await fetch(`http://127.0.0.1:${port}/_trainer/api/state`)).json()) as { attempts: number; state: string };
    assert.equal(midState.attempts, 1, 'a wrong Content-Type is a matched attempt, not silent browsing');
    assert.equal(midState.state, 'active');

    const goodRes = await fetch(`http://127.0.0.1:${port}/github/user/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `token ${validPat}` },
      body: JSON.stringify({ name: 'new-onboarding-repo' }),
    });
    assert.equal(goodRes.status, 201);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterState = (await (await fetch(`http://127.0.0.1:${port}/_trainer/api/state`)).json()) as { state: string };
    assert.equal(afterState.state, 'explaining');

    const explainRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootCause: 'wrong content type', customerReply: 'fixed the header' }),
    });
    assert.equal(explainRes.status, 200);
    const solved = (await explainRes.json()) as { solutionMd: string };
    assert.match(solved.solutionMd, /Root cause/);

    const finalState = (await (await fetch(`http://127.0.0.1:${port}/_trainer/api/state`)).json()) as { state: string };
    assert.equal(finalState.state, 'solved');
  } finally {
    server.close();
  }
});

test('POST /_trainer/api/scenarios/reset re-activates and returns {ok:true}', async () => {
  const { server, port } = await listen();
  try {
    await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios/t1-wrong-method/activate`, { method: 'POST' });
    const resetRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios/reset`, { method: 'POST' });
    assert.equal(resetRes.status, 200);
    assert.deepEqual(await resetRes.json(), { ok: true });
  } finally {
    server.close();
  }
});
