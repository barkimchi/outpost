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
import { Engine } from '../engine/engine.js';
import { createProgressStore } from '../engine/persist.js';

/**
 * Capstone scenario tests (docs/SPEC.md section 12, scenario 16). Same two-kind structure
 * every prior scenario test file uses: distribution (hard constraint 7a) plus a full
 * live-HTTP solve, here extended with two regression tests specific to this scenario's
 * mid-flight revocation mechanism (see t6-capstone.ts's header comment):
 *
 * 1. The constraint-9 false-pass this scenario's step 3 guards against: resending step 1's
 *    already-used code must NOT be mistaken for a genuine refresh-grant diagnosis.
 * 2. `revert()` genuinely un-poisons the World, not just removes a fault id: step 4's
 *    brand new refresh token must actually work on a THIRD refresh attempt, proving the
 *    fix is real and not silently still broken.
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

function extractDocIds(ticketMd: string): string[] {
  const ids: string[] = [];
  const re = /^- `([^`]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ticketMd)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
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

test('t6-capstone: across 14 activations, seed/company/credentials/documents all differ; no multi-candidate shape to memorize a position from', () => {
  // No multi-candidate "pick the right one" shape exists in this scenario (see
  // t6-capstone.ts's header comment: every credential is handed over once, with nothing
  // else on file, and the fix at each step is procedural). This test therefore checks
  // hard constraint 6's per-run regeneration directly, the same as the established
  // precedent for t3-revoked-refresh/t3-token-expiry/t5-hmac-signature.
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

// --- Full live-HTTP solve, all 5 steps, plus the two mid-flight-revocation regressions -----

test('t6-capstone solved end to end: consent, userinfo, mid-flight revoke discovered, re-auth, Glean indexing', async () => {
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
    const docIds = extractDocIds(activated.ticketMd);
    assert.ok(docIds.length >= 1, 'the ticket must list at least one document to index');

    // --- Step 1: live consent + exchange -------------------------------------------------
    const { accessToken: access1, refreshToken: refresh1 } = await freshConsentAndExchange(port, {
      clientId,
      clientSecret,
      redirectUri: REDIRECT_URI,
      scope: 'openid email profile',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));

    // --- Step 2: userinfo, unaffected by the refresh trap ---------------------------------
    const userinfoRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${access1}` },
    });
    assert.equal(userinfoRes.status, 200, 'the access token must genuinely work, only the refresh token is poisoned');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-2'));

    // --- Step 3 wrong attempt (constraint 9 regression): resending the ALREADY-USED
    // authorization_code also 400s invalid_grant, but is NOT a refresh-grant diagnosis and
    // must not be mistaken for one. -------------------------------------------------------
    const staleResend = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'not-a-real-code-but-shape-does-not-matter-here',
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const staleRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: staleResend.toString(),
    });
    assert.equal(staleRes.status, 400, 'sanity: an invalid code is also a 400 invalid_grant');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      engine.getState().currentStepIndex,
      2,
      'a resent/invalid authorization_code attempt must NOT be mistaken for the refresh-grant diagnosis step 3 wants',
    );
    const staleAttempt = events.find(
      (e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> =>
        e.type === 'scenario:attempt' && e.stepId === 'step-3',
    );
    assert.ok(staleAttempt, 'the wrong-grant-type attempt must still be recorded, with a real reason');
    assert.match(staleAttempt?.reason ?? '', /grant_type/, 'the reason must explain it wanted a refresh_token grant, not just "failed"');

    // --- Step 3, the real diagnosis: the refresh token from step 1 is dead ---------------
    const diagnose = await attemptRefresh(port, { refreshToken: refresh1, clientId, clientSecret });
    assert.equal(diagnose.status, 400);
    assert.equal(diagnose.body.error, 'invalid_grant');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-3'));

    // --- Step 4: fresh consent + exchange, genuinely working this time -------------------
    const { accessToken: access2, refreshToken: refresh2 } = await freshConsentAndExchange(port, {
      clientId,
      clientSecret,
      redirectUri: REDIRECT_URI,
      scope: 'openid email profile',
    });
    assert.notEqual(refresh2, refresh1, 'sanity: the re-auth must mint a genuinely new refresh token');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-4'));

    // --- revert() regression: refresh2 must actually work, proving the trap was genuinely
    // removed and not just marked cleared. If revert() were a no-op, this refresh would
    // ALSO come back invalid_grant, and step 4's own "fix" would be silently still broken. --
    const proofRefresh = await attemptRefresh(port, { refreshToken: refresh2, clientId, clientSecret });
    assert.equal(proofRefresh.status, 200, 'the fresh refresh token from step 4 must genuinely work, not be silently poisoned too');
    assert.ok(proofRefresh.body.access_token, 'a working refresh must actually mint a new access token');
    void access2; // used only to document that access2 is the token step 4's exchange returned

    // --- Step 5: successful Glean indexing call -------------------------------------------
    const firstDocId = docIds[0];
    if (!firstDocId) throw new Error('no document id extracted from the ticket');
    const indexRes = await fetch(`http://127.0.0.1:${port}/glean/api/index/v1/indexdocuments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ documents: docIds.map((id) => ({ id, datasource, title: id })) }),
    });
    assert.equal(indexRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-5'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    const result = engine.explain(
      'The refresh token from the first exchange was revoked almost immediately.',
      'Reconnected with a brand new consent and finished indexing the docs.',
    );
    assert.ok(result.solutionMd.length > 0);
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

test('t6-capstone re-activated a second time in a row: a fresh trap poisons the SECOND run\'s own new refresh token independently', async () => {
  // Hard constraint 5: "a scenario that cannot be re-run twice in a row is a bug." This is
  // the trickiest part of this scenario's state to get right (see t6-capstone.ts's header
  // comment on the Proxy trap), so it gets its own dedicated re-activation test rather than
  // relying only on engine.test.ts's generic build-without-throwing smoke test.
  const engine = freshEngine();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const run1 = engine.activate('t6-capstone');
    const run1ClientId = extractLabeled(run1.ticketMd, 'Client ID');
    const run1ClientSecret = extractLabeled(run1.ticketMd, 'Client secret');
    const { refreshToken: run1Refresh } = await freshConsentAndExchange(port, {
      clientId: run1ClientId,
      clientSecret: run1ClientSecret,
      redirectUri: REDIRECT_URI,
      scope: 'openid email profile',
    });
    const run1Diagnose = await attemptRefresh(port, { refreshToken: run1Refresh, clientId: run1ClientId, clientSecret: run1ClientSecret });
    assert.equal(run1Diagnose.status, 400, 'run 1: the freshly minted refresh token must be poisoned');

    // Re-activate: fresh seed, fresh World, fresh trap.
    const run2 = engine.activate('t6-capstone');
    const run2ClientId = extractLabeled(run2.ticketMd, 'Client ID');
    const run2ClientSecret = extractLabeled(run2.ticketMd, 'Client secret');
    assert.notEqual(run2ClientId, run1ClientId, 'sanity: re-activation mints new credentials');
    const { refreshToken: run2Refresh } = await freshConsentAndExchange(port, {
      clientId: run2ClientId,
      clientSecret: run2ClientSecret,
      redirectUri: REDIRECT_URI,
      scope: 'openid email profile',
    });
    const run2Diagnose = await attemptRefresh(port, { refreshToken: run2Refresh, clientId: run2ClientId, clientSecret: run2ClientSecret });
    assert.equal(run2Diagnose.status, 400, 'run 2: its own, independently minted refresh token must ALSO be poisoned by a fresh trap');
    assert.equal(run2Diagnose.body.error, 'invalid_grant');
  } finally {
    server.close();
    engine.dispose();
  }
});
