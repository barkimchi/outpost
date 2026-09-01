import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { ScenarioDef, TrainerEvent } from '@gym/shared';
import { bus } from '../bus.js';
import { activeWorld } from '../platforms/world.js';
import { rawBodyMiddlewares } from '../middleware/rawBody.js';
import { requestLog } from '../middleware/requestLog.js';
import { createGoogleRouter } from '../platforms/google/router.js';
import { scenarioRegistry } from './index.js';
import { Engine } from '../engine/engine.js';
import { createProgressStore } from '../engine/persist.js';
import { registeredRedirectUris } from '../platforms/google/oauth.js';

/**
 * Scenario-level tests for tier 3 (docs/SPEC.md section 12, scenarios 8-11). Two kinds:
 *
 * 1. Distribution tests (docs/SPEC.md hard constraint 7a): across many activations, the
 *    generated ANSWER SHAPE varies, not only the concrete values. `t3-google.test.ts`
 *    mirrors `engine.test.ts`'s own precedent (`DISTRIBUTION_TEST_RUNS`) for this.
 * 2. Full live-HTTP solves: each scenario driven end to end through a real pipeline
 *    (rawBody -> requestLog -> /google), asserting the real `scenario:attempt` /
 *    `scenario:step` / `scenario:explaining` / `scenario:solved` events fire, exactly the
 *    same wiring `router.test.ts`'s `t1-content-type` test already proves for tier 1.
 */

function freshEngine(registry: ScenarioDef[] = scenarioRegistry): Engine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-t3-test-'));
  return new Engine(registry, createProgressStore(path.join(dir, 'progress.json')));
}

function buildRealPipelineApp() {
  const app = express();
  app.use(...rawBodyMiddlewares);
  app.use(requestLog);
  app.use('/google', createGoogleRouter());
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

function extractWrongRedirectUri(ticketMd: string): string {
  // Fix round: the ticket now wraps the value in backticks, same as every other value in
  // this ticket (Minors finding: a bare-text decoy next to backtick-wrapped correct values
  // was itself a formatting tell on exactly the value that most needed character-level
  // reading).
  const match = ticketMd.match(/Callback URL configured in the OAuth helper: `([^`]+)`/);
  if (!match?.[1]) throw new Error(`could not find the configured (wrong) redirect_uri in ticket:\n${ticketMd}`);
  return match[1];
}

function extractConfiguredScopeString(ticketMd: string): string {
  const match = ticketMd.match(/Scope string the OAuth helper is currently configured to request: `([^`]+)`/);
  if (!match?.[1]) throw new Error(`could not find the configured scope string in ticket:\n${ticketMd}`);
  return match[1].trim();
}

const [REGISTERED_URI_A, REGISTERED_URI_B] = registeredRedirectUris();

async function approveConsent(
  port: number,
  opts: { redirectUri: string; scope: string; clientId: string; state?: string; approve?: '1' | '0' },
): Promise<Response> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.scope,
    approve: opts.approve ?? '1',
    ...(opts.state !== undefined ? { state: opts.state } : {}),
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
): Promise<{ accessToken: string; refreshToken: string }> {
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
  const parsed = (await res.json()) as { access_token: string; refresh_token: string };
  assert.equal(res.status, 200, `expected a successful code exchange, got ${res.status}: ${JSON.stringify(parsed)}`);
  return { accessToken: parsed.access_token, refreshToken: parsed.refresh_token };
}

async function freshConsentAndExchange(
  port: number,
  opts: { clientId: string; clientSecret: string; redirectUri: string; scope: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const approve = await approveConsent(port, { redirectUri: opts.redirectUri, scope: opts.scope, clientId: opts.clientId });
  assert.equal(approve.status, 302);
  const code = extractCode(approve.headers.get('location') ?? '');
  return exchangeAuthCode(port, { code, redirectUri: opts.redirectUri, clientId: opts.clientId, clientSecret: opts.clientSecret });
}

function collectTrainerEvents(): { events: TrainerEvent[]; stop: () => void } {
  const events: TrainerEvent[] = [];
  const onTrainerEvent = (ev: TrainerEvent): void => {
    events.push(ev);
  };
  bus.on('trainer-event', onTrainerEvent);
  return { events, stop: () => bus.off('trainer-event', onTrainerEvent) };
}

// --- Distribution tests (hard constraint 7a) ----------------------------------------------

const DISTRIBUTION_TEST_RUNS = 14;

test('t3-redirect-mismatch: across 14 activations, the shown wrong redirect_uri is genuinely drawn from more than one decoy', () => {
  const engine = freshEngine();
  try {
    const seenWrongUris = new Set<string>();
    const seenTickets = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t3-redirect-mismatch');
      seenTickets.add(activated.ticketMd);
      seenWrongUris.add(extractWrongRedirectUri(activated.ticketMd));
    }
    assert.equal(seenTickets.size, DISTRIBUTION_TEST_RUNS, 'every activation must produce distinct ticket text');
    assert.ok(
      seenWrongUris.size >= 2,
      `expected at least 2 distinct wrong-redirect-uri decoys across ${DISTRIBUTION_TEST_RUNS} runs, saw: ${[...seenWrongUris].join(', ')}`,
    );
    for (const uri of seenWrongUris) {
      assert.notEqual(uri, REGISTERED_URI_A, 'the "wrong" URI must never accidentally equal a real registered one');
      assert.notEqual(uri, REGISTERED_URI_B, 'the "wrong" URI must never accidentally equal a real registered one');
    }
  } finally {
    engine.dispose();
  }
});

test('t3-insufficient-scope: across 14 activations, both the "missing entirely" and "decoy scope" shapes appear', () => {
  const engine = freshEngine();
  try {
    let missingCount = 0;
    let decoyCount = 0;
    const seenTickets = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t3-insufficient-scope');
      seenTickets.add(activated.ticketMd);
      const scopeStr = extractConfiguredScopeString(activated.ticketMd);
      const hasCalendarEvents = scopeStr.includes('calendar.events');
      const hasCalendarReadonly = scopeStr.includes('calendar.readonly');
      assert.equal(hasCalendarReadonly, false, 'the CURRENT (broken) config must never already carry the fix');
      if (hasCalendarEvents) decoyCount += 1;
      else missingCount += 1;
    }
    assert.equal(seenTickets.size, DISTRIBUTION_TEST_RUNS, 'every activation must produce distinct ticket text');
    assert.equal(missingCount + decoyCount, DISTRIBUTION_TEST_RUNS);
    assert.ok(
      missingCount > 0 && decoyCount > 0,
      `expected both shapes across ${DISTRIBUTION_TEST_RUNS} runs; got missing=${missingCount}, decoy=${decoyCount}`,
    );
  } finally {
    engine.dispose();
  }
});

test('t3-token-expiry: across 14 activations, seed/company/credentials all differ (per-run generation, hard constraint 6)', () => {
  const engine = freshEngine();
  try {
    const seeds = new Set<string>();
    const tickets = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t3-token-expiry');
      seeds.add(activated.seed);
      tickets.add(activated.ticketMd);
    }
    assert.equal(seeds.size, DISTRIBUTION_TEST_RUNS, 'every activation must mint a distinct seed');
    assert.equal(tickets.size, DISTRIBUTION_TEST_RUNS, 'every activation must produce distinct ticket text');
  } finally {
    engine.dispose();
  }
});

test('t3-revoked-refresh: across 14 activations, the pre-issued access/refresh token strings all differ', () => {
  const engine = freshEngine();
  try {
    const accessTokens = new Set<string>();
    const refreshTokens = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t3-revoked-refresh');
      accessTokens.add(extractLabeled(activated.ticketMd, 'Access token'));
      refreshTokens.add(extractLabeled(activated.ticketMd, 'Refresh token'));
    }
    assert.equal(accessTokens.size, DISTRIBUTION_TEST_RUNS, 'every activation must mint a distinct access token');
    assert.equal(refreshTokens.size, DISTRIBUTION_TEST_RUNS, 'every activation must mint a distinct refresh token');
  } finally {
    engine.dispose();
  }
});

// --- Full live-HTTP solves ------------------------------------------------------------------

test('t3-redirect-mismatch solved end to end: wrong URI attempt recorded, then consent -> exchange -> userinfo', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t3-redirect-mismatch');
    const clientId = extractLabeled(activated.ticketMd, 'Client ID');
    const clientSecret = extractLabeled(activated.ticketMd, 'Client secret');
    const wrongUri = extractWrongRedirectUri(activated.ticketMd);

    // Wrong attempt: still matches step-1 (method+path only), still fails its assertion.
    const badAttempt = await approveConsent(port, { redirectUri: wrongUri, scope: 'openid email profile', clientId });
    assert.equal(badAttempt.status, 400);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attemptEvent = events.find((e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> => e.type === 'scenario:attempt');
    assert.ok(attemptEvent, 'the wrong-URI consent attempt must be recorded as a scenario:attempt with a reason');
    assert.ok(attemptEvent?.reason.length ?? 0 > 0);

    // Real fix: a registered URI.
    const good = await approveConsent(port, { redirectUri: REGISTERED_URI_A as string, scope: 'openid email profile', clientId });
    assert.equal(good.status, 302);
    const code = extractCode(good.headers.get('location') ?? '');
    const { accessToken } = await exchangeAuthCode(port, { code, redirectUri: REGISTERED_URI_A as string, clientId, clientSecret });
    const userinfoRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(userinfoRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-2'));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-3'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    const result = engine.explain('The callback URL did not exactly match a registered one.', 'Fixed the callback URL and reconnected.');
    assert.ok(result.solutionMd.length > 0);
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

// --- Fix round, finding 1: the wrong-URI failure mode is a GET (the consent page never
// renders, so there is no form to POST). Before the fix, `method: 'POST'` alone meant
// three wrong GETs produced attempts: 0, hintsUnlocked: 0, and POST /_trainer/api/hint
// returned 409: hard constraint 9 violated on this scenario's PRIMARY failure path. -------

test('a wrong GET to the authorize endpoint (not just a wrong POST) registers as a scenario:attempt and unlocks hints at 3, 6, 9', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t3-redirect-mismatch');
    const clientId = extractLabeled(activated.ticketMd, 'Client ID');
    const wrongUri = extractWrongRedirectUri(activated.ticketMd);

    async function wrongGet(): Promise<Response> {
      const url = new URL(`http://127.0.0.1:${port}/google/o/oauth2/v2/auth`);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', wrongUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      return fetch(url);
    }

    for (let i = 0; i < 9; i++) {
      const res = await wrongGet();
      assert.equal(res.status, 400, `wrong GET attempt ${i + 1} must still be a real 400 from the mock itself`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    const attemptEvents = events.filter((e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> => e.type === 'scenario:attempt');
    assert.equal(attemptEvents.length, 9, 'every one of the 9 wrong GETs must count as an attempt, not be silently ignored');
    assert.ok(
      attemptEvents.every((e) => e.reason.length > 0 && e.reason.includes('GET')),
      'each attempt reason must be non-empty and name the method that failed (hard constraint 9)',
    );
    assert.ok(attemptEvents[0]?.attemptHint, 'attemptHint must be present so the learner is not just told "wrong" with no guidance');

    const hintEvents = events.filter((e) => e.type === 'hint:unlocked');
    assert.deepEqual(
      hintEvents.map((e) => (e as { index: number }).index),
      [0, 1, 2],
      'hints must unlock at attempts 3, 6, and 9 (docs/SPEC.md section 9)',
    );
    assert.equal(engine.getState().hintsUnlocked, 3);

    // Confirm this is really reachable through the trainer API too, not just the engine's
    // internal counters: POST /_trainer/api/hint must now succeed instead of 409ing.
    const world = engine.getState();
    assert.equal(world.attempts, 9);
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

test('a correct GET (before ever POSTing) completes step 1; a POST that merely denies consent does not', async () => {
  const engine = freshEngine();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t3-redirect-mismatch');
    const clientId = extractLabeled(activated.ticketMd, 'Client ID');

    // A deliberate denial is also a 302 (to ?error=access_denied), but carries no code:
    // must NOT be mistaken for progress.
    const denied = await approveConsent(port, {
      redirectUri: REGISTERED_URI_A as string,
      scope: 'openid email profile',
      clientId,
      approve: '0',
    });
    assert.equal(denied.status, 302, 'sanity: a denial is still a real 302, just without a code');
    assert.equal(engine.getState().currentStepIndex, 0, 'a denial must not advance past step 1');

    // A plain, correct GET (the realistic first move, before any POST at all) DOES count:
    // it proves the callback URL is genuinely valid, even before a code exists.
    const url = new URL(`http://127.0.0.1:${port}/google/o/oauth2/v2/auth`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', REGISTERED_URI_A as string);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    const res = await fetch(url);
    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(engine.getState().currentStepIndex, 1, 'a correct GET alone must complete step 1');
  } finally {
    server.close();
    engine.dispose();
  }
});

test('t3-token-expiry solved end to end: fresh token works immediately, refresh grant completes the flow', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t3-token-expiry');
    const clientId = extractLabeled(activated.ticketMd, 'Client ID');
    const clientSecret = extractLabeled(activated.ticketMd, 'Client secret');

    // Fix round: the TTL is now drawn per run (SHORT_ACCESS_TOKEN_TTL_POOL_SEC in
    // generate.ts), not fixed at 15, so this only checks that setup() genuinely overrode
    // World's baseline (3600), not a specific number.
    const ttlSec = activeWorld().google.accessTokenTtlSec;
    assert.notEqual(ttlSec, 3600, 'setup() must have overridden the TTL for this scenario');
    assert.ok(ttlSec > 0 && ttlSec <= 30, `expected a short TTL, got ${ttlSec}`);

    const { accessToken, refreshToken } = await freshConsentAndExchange(port, {
      clientId,
      clientSecret,
      redirectUri: REGISTERED_URI_B as string,
      scope: 'openid email profile',
    });

    // Step 1: satisfiable with a freshly issued token (the explicit ruling this scenario
    // must honor), well within the 15s TTL.
    const userinfoRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(userinfoRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));

    // Wrong attempt at step 2: a bogus refresh token still matches (same endpoint), still fails.
    const bad = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'not-the-real-one',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const badRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: bad.toString(),
    });
    assert.equal(badRes.status, 400);

    // Real fix: refresh with the actual refresh token.
    const good = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const goodRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: good.toString(),
    });
    assert.equal(goodRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:attempt' && e.stepId === 'step-2'));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-2'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('The 15s TTL killed the first access token.', 'Reconnected using the refresh token.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

test('t3-revoked-refresh solved end to end: given access token works, given refresh token is dead, full re-auth fixes it', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t3-revoked-refresh');
    const clientId = extractLabeled(activated.ticketMd, 'Client ID');
    const clientSecret = extractLabeled(activated.ticketMd, 'Client secret');
    const givenAccessToken = extractLabeled(activated.ticketMd, 'Access token');
    const givenRefreshToken = extractLabeled(activated.ticketMd, 'Refresh token');

    const userinfoRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${givenAccessToken}` },
    });
    assert.equal(userinfoRes.status, 200, "the given access token must genuinely still work");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));

    // Wrong attempt: the dead refresh token, no matter how it's retried, is invalid_grant.
    const deadRefresh = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: givenRefreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const deadRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: deadRefresh.toString(),
    });
    assert.equal(deadRes.status, 400);
    assert.deepEqual(await deadRes.json(), { error: 'invalid_grant', error_description: 'Bad Request' });

    // Real fix: brand new consent.
    await freshConsentAndExchange(port, { clientId, clientSecret, redirectUri: REGISTERED_URI_A as string, scope: 'openid email profile' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:attempt' && e.stepId === 'step-2'));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-2'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('The refresh token on file was already revoked.', 'Ran consent again for a fresh pair.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

test('t3-insufficient-scope solved end to end: given token 403s, re-consent with the calendar scope fixes it', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t3-insufficient-scope');
    const clientId = extractLabeled(activated.ticketMd, 'Client ID');
    const clientSecret = extractLabeled(activated.ticketMd, 'Client secret');
    const givenAccessToken = extractLabeled(activated.ticketMd, 'Currently issued access token');

    const denied = await fetch(`http://127.0.0.1:${port}/google/calendar/v3/users/me/calendarList`, {
      headers: { authorization: `Bearer ${givenAccessToken}` },
    });
    assert.equal(denied.status, 403);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:attempt' && e.stepId === 'step-1'));

    const { accessToken: fixedToken } = await freshConsentAndExchange(port, {
      clientId,
      clientSecret,
      redirectUri: REGISTERED_URI_B as string,
      scope: 'openid email profile https://www.googleapis.com/auth/calendar.readonly',
    });
    const allowed = await fetch(`http://127.0.0.1:${port}/google/calendar/v3/users/me/calendarList`, {
      headers: { authorization: `Bearer ${fixedToken}` },
    });
    assert.equal(allowed.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('The scope config never included calendar.readonly.', 'Added the scope and re-authorized.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});
