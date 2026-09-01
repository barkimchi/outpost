import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { engine } from '../engine/engine.js';
import { scenarioRegistry } from '../scenarios/index.js';

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
  // 127.0.0.1, not a bare listen(0): see docs/SPEC.md section 2a.
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('GET /_trainer/api/scenarios lists every registered scenario, with solved:false, runs:0, before any activation', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string; solved: boolean; runs: number }>;
    // Derived from the registry itself, not a hardcoded count: a magic number here has
    // already gone stale twice (Task 6 -> 11, Task 7 -> 15) and would go stale again the
    // moment a later task adds the capstone or the implementation track. The property
    // actually worth asserting is that this endpoint REFLECTS the registry, whatever size
    // it currently is.
    const bodyIds = body.map((s) => s.id);
    assert.equal(body.length, scenarioRegistry.length, 'the endpoint must list exactly as many scenarios as are registered');
    for (const def of scenarioRegistry) {
      assert.ok(bodyIds.includes(def.id), `${def.id} must be listed`);
    }
    for (const entry of body) {
      assert.equal(entry.solved, false, `${entry.id} must start unsolved`);
      assert.equal(entry.runs, 0, `${entry.id} must start with zero runs`);
    }
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

// --- DELETE /_trainer/api/progress (Task 8, confirm-style contract) -----------------------

async function solveT1ContentType(port: number): Promise<void> {
  const activateRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios/t1-content-type/activate`, { method: 'POST' });
  const activated = (await activateRes.json()) as { ticketMd: string };
  const patMatch = activated.ticketMd.match(/token (ghp_[A-Za-z0-9]{36})/);
  const validPat = patMatch?.[1];
  if (!validPat) throw new Error('ticketMd must embed the PAT to use');
  const goodRes = await fetch(`http://127.0.0.1:${port}/github/user/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `token ${validPat}` },
    body: JSON.stringify({ name: 'new-onboarding-repo' }),
  });
  if (goodRes.status !== 201) throw new Error(`expected 201, got ${goodRes.status}`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const explainRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/explain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rootCause: 'wrong content type', customerReply: 'fixed the header' }),
  });
  if (explainRes.status !== 200) throw new Error(`expected explain to succeed, got ${explainRes.status}`);
}

test('DELETE /_trainer/api/progress with no confirm token changes nothing (never deletes silently)', async () => {
  const { server, port } = await listen();
  try {
    await solveT1ContentType(port);
    const beforeRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios`);
    const before = (await beforeRes.json()) as Array<{ id: string; solved: boolean; runs: number }>;
    const beforeSolved = before.find((s) => s.id === 't1-content-type');
    assert.equal(beforeSolved?.solved, true, 'sanity: t1-content-type must actually be solved before this test');

    const noConfirm = await fetch(`http://127.0.0.1:${port}/_trainer/api/progress`, { method: 'DELETE' });
    assert.equal(noConfirm.status, 400, 'a DELETE with no confirm body must be rejected, not silently applied');

    const wrongConfirm = await fetch(`http://127.0.0.1:${port}/_trainer/api/progress`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(wrongConfirm.status, 400, 'a bare truthy confirm value must not satisfy the exact-phrase contract');

    const afterRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios`);
    const after = (await afterRes.json()) as Array<{ id: string; solved: boolean; runs: number }>;
    const afterSolved = after.find((s) => s.id === 't1-content-type');
    assert.equal(afterSolved?.solved, true, 'progress must be completely unchanged after a rejected DELETE');
  } finally {
    server.close();
  }
});

test('DELETE /_trainer/api/progress with the exact confirm phrase resets every scenario back to solved:false, runs:0', async () => {
  const { server, port } = await listen();
  try {
    await solveT1ContentType(port);
    const beforeRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios`);
    const before = (await beforeRes.json()) as Array<{ id: string; solved: boolean; runs: number }>;
    assert.ok(before.some((s) => s.solved || s.runs > 0), 'sanity: there must be real progress to reset');

    const resetRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/progress`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'RESET PROGRESS' }),
    });
    assert.equal(resetRes.status, 200);
    assert.deepEqual(await resetRes.json(), { ok: true });

    const afterRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios`);
    const after = (await afterRes.json()) as Array<{ id: string; solved: boolean; runs: number }>;
    assert.equal(after.length, before.length, 'the reset must not change which scenarios are registered');
    for (const entry of after) {
      assert.equal(entry.solved, false, `${entry.id} must be unsolved after a confirmed reset`);
      assert.equal(entry.runs, 0, `${entry.id} must show zero runs after a confirmed reset`);
    }
  } finally {
    server.close();
  }
});

test('a normal activate/solve run never triggers a progress reset on its own', async () => {
  // Reset is opt-in, explicit-confirm-only (see trainer/router.ts's header comment): this
  // asserts the OTHER direction of that contract, that ordinary use of the app (the exact
  // same flow every other test in this file already drives) leaves data/progress.json
  // growing, never wiped, since nothing in the normal activate/explain path ever calls the
  // DELETE route.
  const { server, port } = await listen();
  try {
    await solveT1ContentType(port);
    const afterRes = await fetch(`http://127.0.0.1:${port}/_trainer/api/scenarios`);
    const after = (await afterRes.json()) as Array<{ id: string; solved: boolean; runs: number }>;
    const solved = after.find((s) => s.id === 't1-content-type');
    assert.equal(solved?.solved, true, 'a normal solve must leave real progress behind, not be reset out from under itself');
    assert.ok((solved?.runs ?? 0) > 0);
  } finally {
    server.close();
  }
});
