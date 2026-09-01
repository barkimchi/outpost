import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { ScenarioDef, TrainerEvent } from '@gym/shared';
import { bus } from '../bus.js';
import { rawBodyMiddlewares } from '../middleware/rawBody.js';
import { requestLog } from '../middleware/requestLog.js';
import { createGoogleRouter } from '../platforms/google/router.js';
import { createGleanRouter } from '../platforms/glean/router.js';
import { trainerCallbackRedirectUri } from '../platforms/google/oauth.js';
import { scenarioRegistry } from './index.js';
import { t6Scenarios, CONNECTION_HEALTH_DOC_ID } from './t6-capstone.js';
import { Engine } from '../engine/engine.js';
import { createProgressStore } from '../engine/persist.js';
import { matchesRequest } from '../engine/match.js';
import { buildTestRunContext } from '../testSupport/runContext.js';

/**
 * Capstone scenario tests (docs/SPEC.md section 12, scenario 16), covering the fix-round
 * redesign (t6-capstone.ts's own header comment: a real before/after over the SAME action,
 * not a credential dead on arrival). Same two-kind structure every prior scenario test file
 * uses: distribution (hard constraint 7a) and a full live-HTTP solve, extended here with
 * dedicated regressions for the two things the fix round review specifically found:
 *
 * 1. Finding 1 (CRITICAL): a completely made-up refresh_token must NOT false-pass step 4's
 *    diagnosis just because it also 400s invalid_grant.
 * 2. Finding 4: the break must be genuinely OBSERVABLE (a refresh that works, then an
 *    identical one that does not) and the finale must return a real, checkable body.
 */

function freshEngine(registry: ScenarioDef[] = scenarioRegistry): Engine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-t6-test-'));
  return new Engine(registry, createProgressStore(path.join(dir, 'progress.json')));
}

function buildRealPipelineApp() {
  const app = express();
  app.use(...rawBodyMiddlewares);
  app.use(requestLog);
  app.use('/google', createGoogleRouter());
  app.use('/glean', createGleanRouter());
  return app;
}

async function listen(app: express.Express) {
  // 127.0.0.1, not a bare listen(0): see docs/SPEC.md section 2a.
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

function extractLabeled(ticketMd: string, label: string): string {
  const re = new RegExp(`${label}: \`([^\`]+)\``);
  const match = ticketMd.match(re);
  if (!match?.[1]) throw new Error(`could not find "${label}: \`...\`" in ticket:\n${ticketMd}`);
  return match[1];
}

function collectTrainerEvents(): { events: TrainerEvent[]; stop: () => void } {
  const events: TrainerEvent[] = [];
  const onTrainerEvent = (ev: TrainerEvent): void => {
    events.push(ev);
  };
  bus.on('trainer-event', onTrainerEvent);
  return { events, stop: () => bus.off('trainer-event', onTrainerEvent) };
}

async function approveConsent(
  port: number,
  opts: { redirectUri: string; scope: string; clientId: string; approve?: '1' | '0' },
): Promise<Response> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.scope,
    approve: opts.approve ?? '1',
  });
  return fetch(`http://127.0.0.1:${port}/google/o/oauth2/v2/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
}

function extractCode(location: string): string {
  const url = new URL(location);
  const code = url.searchParams.get('code');
  if (!code) throw new Error(`no code in Location header: ${location}`);
  return code;
}

async function exchangeAuthCode(
  port: number,
  opts: { code: string; redirectUri: string; clientId: string; clientSecret: string },
): Promise<{ status: number; accessToken?: string; refreshToken?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const res = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const parsed = (await res.json()) as { access_token?: string; refresh_token?: string };
  return { status: res.status, accessToken: parsed.access_token, refreshToken: parsed.refresh_token };
}

async function freshConsentAndExchange(
  port: number,
  opts: { clientId: string; clientSecret: string; redirectUri: string; scope: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const approve = await approveConsent(port, { redirectUri: opts.redirectUri, scope: opts.scope, clientId: opts.clientId });
  assert.equal(approve.status, 302);
  const code = extractCode(approve.headers.get('location') ?? '');
  const result = await exchangeAuthCode(port, { code, redirectUri: opts.redirectUri, clientId: opts.clientId, clientSecret: opts.clientSecret });
  assert.equal(result.status, 200, 'expected a successful code exchange');
  if (!result.accessToken || !result.refreshToken) throw new Error('exchange did not return both tokens');
  return { accessToken: result.accessToken, refreshToken: result.refreshToken };
}

async function attemptRefresh(
  port: number,
  opts: { refreshToken: string; clientId: string; clientSecret: string },
): Promise<{ status: number; body: { error?: string; access_token?: string } }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const res = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return { status: res.status, body: (await res.json()) as { error?: string; access_token?: string } };
}

const REDIRECT_URI = trainerCallbackRedirectUri();

// --- Distribution test (hard constraint 7a) ------------------------------------------------

const DISTRIBUTION_TEST_RUNS = 14;

test('t6-capstone: across 14 activations, seed/company/credentials/document text all differ; no multi-candidate shape to memorize a position from', () => {
  const engine = freshEngine();
  try {
    const seeds = new Set<string>();
    const tickets = new Set<string>();
    const clientIds = new Set<string>();
    const indexingTokens = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t6-capstone');
      seeds.add(activated.seed);
      tickets.add(activated.ticketMd);
      clientIds.add(extractLabeled(activated.ticketMd, 'Client ID'));
      indexingTokens.add(extractLabeled(activated.ticketMd, 'Glean indexing token'));
    }
    assert.equal(seeds.size, DISTRIBUTION_TEST_RUNS, 'every activation must mint a distinct seed');
    assert.equal(tickets.size, DISTRIBUTION_TEST_RUNS, 'every activation must produce distinct ticket text');
    assert.equal(clientIds.size, DISTRIBUTION_TEST_RUNS, 'every activation must mint a distinct Google client id');
    assert.equal(indexingTokens.size, DISTRIBUTION_TEST_RUNS, 'every activation must mint a distinct Glean indexing token');
  } finally {
    engine.dispose();
  }
});

// --- Full live-HTTP solve, all 6 steps, plus the fix-round regressions ---------------------

test('t6-capstone solved end to end: consent, userinfo, a refresh that WORKS, the identical refresh that then FAILS, re-auth, a real Glean status finale', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t6-capstone');
    const clientId = extractLabeled(activated.ticketMd, 'Client ID');
    const clientSecret = extractLabeled(activated.ticketMd, 'Client secret');
    const indexingToken = extractLabeled(activated.ticketMd, 'Glean indexing token');
    const datasource = extractLabeled(activated.ticketMd, 'Datasource');
    const docId = extractLabeled(activated.ticketMd, 'Document to index');

    // --- Step 1: live consent + exchange -------------------------------------------------
    const { accessToken: access1, refreshToken: refresh1 } = await freshConsentAndExchange(port, {
      clientId,
      clientSecret,
      redirectUri: REDIRECT_URI,
      scope: 'openid email profile',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));

    // --- Step 2: userinfo ------------------------------------------------------------------
    const userinfoRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${access1}` },
    });
    assert.equal(userinfoRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-2'));

    // --- Step 3: the refresh genuinely WORKS (this is the "before" half of the turn) ------
    const firstRefresh = await attemptRefresh(port, { refreshToken: refresh1, clientId, clientSecret });
    assert.equal(firstRefresh.status, 200, 'the first refresh must be a real, visible success');
    assert.ok(firstRefresh.body.access_token, 'a working refresh must actually mint a new access token');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-3'), 'step 3 must be graded as a real success, not skipped');

    // --- Fix-round finding 1 regression (CRITICAL): a made-up refresh_token must NOT
    // false-pass step 4. Proven live before the fix: this exact request completed step 4
    // with ZERO recorded attempts. -----------------------------------------------------
    const garbage = await attemptRefresh(port, { refreshToken: '1//totally-made-up', clientId, clientSecret });
    assert.equal(garbage.status, 400, 'sanity: a never-issued token is also a real 400 invalid_grant');
    assert.equal(garbage.body.error, 'invalid_grant');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      engine.getState().currentStepIndex,
      3,
      'a made-up refresh_token must NOT diagnose step 4: it never proves the REAL token is dead (finding 1)',
    );
    const garbageAttempt = events.find(
      (e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> => e.type === 'scenario:attempt' && e.stepId === 'step-4',
    );
    assert.ok(garbageAttempt, 'the made-up-token attempt must be recorded as a real attempt, not silently accepted');
    assert.match(garbageAttempt?.reason ?? '', /never actually issued/, 'the reason must explain the token was never issued this run');

    // --- Step 4, the real diagnosis: the IDENTICAL refresh request, now dead -------------
    const secondRefresh = await attemptRefresh(port, { refreshToken: refresh1, clientId, clientSecret });
    assert.equal(secondRefresh.status, 400, 'the SAME refresh_token that just worked in step 3 must now be dead');
    assert.equal(secondRefresh.body.error, 'invalid_grant');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-4'));

    // --- Step 5: fresh consent + exchange, genuinely working this time -------------------
    const { refreshToken: refresh2 } = await freshConsentAndExchange(port, {
      clientId,
      clientSecret,
      redirectUri: REDIRECT_URI,
      scope: 'openid email profile',
    });
    assert.notEqual(refresh2, refresh1, 'sanity: the re-auth must mint a genuinely new refresh token');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-5'));

    // Proof the fix is real: refresh2 must actually work, and must NOT die on a second use
    // (the delayed-revoke fault only fires once, tied to step 3's own completion).
    const proofRefresh1 = await attemptRefresh(port, { refreshToken: refresh2, clientId, clientSecret });
    assert.equal(proofRefresh1.status, 200, 'the fresh refresh token from step 5 must genuinely work');
    const proofRefresh2 = await attemptRefresh(port, { refreshToken: refresh2, clientId, clientSecret });
    assert.equal(proofRefresh2.status, 200, 'the fresh refresh token must keep working, not silently die on a second use too');

    // --- Step 6: index the document (ungraded prerequisite), then confirm status ---------
    const indexRes = await fetch(`http://127.0.0.1:${port}/glean/api/index/v1/indexdocument`, {
      method: 'POST',
      headers: { authorization: `Bearer ${indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ document: { id: docId, datasource, title: docId, body: 'connection health' } }),
    });
    assert.equal(indexRes.status, 200);

    const statusUrl = new URL(`http://127.0.0.1:${port}/glean/api/index/v1/getdocumentstatus`);
    statusUrl.searchParams.set('id', docId);
    statusUrl.searchParams.set('datasource', datasource);
    const statusRes = await fetch(statusUrl, { headers: { authorization: `Bearer ${indexingToken}` } });
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as { status: string; id: string };
    assert.equal(statusBody.status, 'INDEXED', 'the finale must return a real, checkable status, visible to a viewer');
    assert.equal(statusBody.id, docId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-6'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    const result = engine.explain(
      'The refresh token worked once, then was revoked immediately after.',
      'Reconnected with a brand new consent and confirmed the document is indexed.',
    );
    assert.ok(result.solutionMd.length > 0);
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

test("t6-capstone step 6's matcher is pinned to its own document id, not any getdocumentstatus query (finding 2's class of bug, checked here too)", () => {
  const def = t6Scenarios[0];
  if (!def) throw new Error('t6Scenarios is empty');
  const built = def.build(buildTestRunContext());
  const step6 = built.steps[5];
  if (!step6) throw new Error('expected 6 steps, step-6 at index 5');
  assert.equal(step6.id, 'step-6');

  // A seeded Glean doc id ('doc-1') genuinely reports INDEXED from the moment the run
  // starts (platforms/glean/router.ts's allSearchableDocs()), with nothing indexed. If
  // step 6 matched a query for it, the capstone's finale would be satisfiable with zero
  // real work, the exact class of bug fix-round finding 2 found in impl-glean.
  const seededDocQuery = {
    method: 'GET',
    pathLower: '/glean/api/index/v1/getdocumentstatus',
    query: { id: 'doc-1', datasource: 'anything' },
    headerNames: ['authorization'],
  };
  assert.equal(matchesRequest(step6.match, seededDocQuery), false, 'a seeded doc id must not match step 6 at all');

  const ownDocQuery = {
    method: 'GET',
    pathLower: '/glean/api/index/v1/getdocumentstatus',
    query: { id: CONNECTION_HEALTH_DOC_ID, datasource: 'some-datasource' },
    headerNames: ['authorization'],
  };
  assert.equal(matchesRequest(step6.match, ownDocQuery), true, "the scenario's own document id must match step 6");
});

test('t6-capstone re-activated a second time in a row: the delayed-revoke fault fires independently for each run\'s own refresh token', async () => {
  // Hard constraint 5: "a scenario that cannot be re-run twice in a row is a bug."
  const engine = freshEngine();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const run1 = engine.activate('t6-capstone');
    const run1ClientId = extractLabeled(run1.ticketMd, 'Client ID');
    const run1ClientSecret = extractLabeled(run1.ticketMd, 'Client secret');
    const { accessToken: run1Access, refreshToken: run1Refresh } = await freshConsentAndExchange(port, {
      clientId: run1ClientId,
      clientSecret: run1ClientSecret,
      redirectUri: REDIRECT_URI,
      scope: 'openid email profile',
    });
    // The revoke is tied to STEP 3's completion, which the engine only reaches once step 2
    // (userinfo) has been graded; skipping straight from exchange to a refresh attempt
    // leaves the engine parked on step 2, `clearFaults` never fires, and the refresh
    // token never actually gets revoked, a real bug this exact test caught once already.
    await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, { headers: { authorization: `Bearer ${run1Access}` } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run1First = await attemptRefresh(port, { refreshToken: run1Refresh, clientId: run1ClientId, clientSecret: run1ClientSecret });
    assert.equal(run1First.status, 200, 'run 1: the first refresh must work');
    // The revoke fires from clearFaults, driven by the SAME async bus event pipeline as
    // every other scenario:step transition in this project; a real gap between the
    // response landing and the engine having processed it, same as every other test file's
    // own 20ms wait after a graded request.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run1Second = await attemptRefresh(port, { refreshToken: run1Refresh, clientId: run1ClientId, clientSecret: run1ClientSecret });
    assert.equal(run1Second.status, 400, 'run 1: the second, identical refresh must now be dead');

    // Re-activate: fresh seed, fresh World, fresh fault.
    const run2 = engine.activate('t6-capstone');
    const run2ClientId = extractLabeled(run2.ticketMd, 'Client ID');
    const run2ClientSecret = extractLabeled(run2.ticketMd, 'Client secret');
    assert.notEqual(run2ClientId, run1ClientId, 'sanity: re-activation mints new credentials');
    const { accessToken: run2Access, refreshToken: run2Refresh } = await freshConsentAndExchange(port, {
      clientId: run2ClientId,
      clientSecret: run2ClientSecret,
      redirectUri: REDIRECT_URI,
      scope: 'openid email profile',
    });
    await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, { headers: { authorization: `Bearer ${run2Access}` } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run2First = await attemptRefresh(port, { refreshToken: run2Refresh, clientId: run2ClientId, clientSecret: run2ClientSecret });
    assert.equal(run2First.status, 200, 'run 2: its own, independently minted refresh token must ALSO work the first time');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run2Second = await attemptRefresh(port, { refreshToken: run2Refresh, clientId: run2ClientId, clientSecret: run2ClientSecret });
    assert.equal(run2Second.status, 400, 'run 2: and ALSO die on the second, identical attempt, independently of run 1');
  } finally {
    server.close();
    engine.dispose();
  }
});
