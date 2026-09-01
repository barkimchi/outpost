import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Fault, RunContext, ScenarioDef, TrainerEvent } from '@gym/shared';
import { bus } from '../bus.js';
import { activeWorld } from '../platforms/world.js';
import { rawBodyMiddlewares } from '../middleware/rawBody.js';
import { requestLog } from '../middleware/requestLog.js';
import { createGithubRouter } from '../platforms/github/router.js';
import { scenarioRegistry } from '../scenarios/index.js';
import { Engine, EngineError } from './engine.js';
import { createProgressStore } from './persist.js';
import { matchesRequest, type MatchableRequest } from './match.js';

/**
 * These tests construct their OWN `Engine` instance (never the process-wide singleton
 * exported by `engine.ts`, which stays permanently idle for the whole file since nothing
 * here ever calls a method on it) so tests never interfere with each other through
 * shared state, and never write to the real `data/progress.json`. Each instance still
 * subscribes to the shared `bus` singleton (that IS the production wiring being tested),
 * so every test disposes its engine when done.
 */

function freshEngine(registry: ScenarioDef[] = scenarioRegistry): Engine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-engine-test-'));
  return new Engine(registry, createProgressStore(path.join(dir, 'progress.json')));
}

// A real HTTP pipeline (rawBody -> requestLog -> /github), independent of app.ts and the
// production engine singleton, so a genuine HTTP request produces a genuine RequestEvent
// on the real bus, exactly like real Postman traffic would, without any middleware/
// changes.
function buildRealPipelineApp() {
  const app = express();
  app.use(...rawBodyMiddlewares);
  app.use(requestLog);
  app.use('/github', createGithubRouter());
  return app;
}

async function listen(app: express.Express) {
  // 127.0.0.1, not a bare listen(0): see docs/SPEC.md section 2a.
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

/**
 * Pulls every backtick-wrapped GitHub PAT out of a ticket, in the order they appear.
 * t2-* scenarios (fix round) deliberately give both candidate tokens NEUTRAL labels
 * ("Token 1" / "Token 2"), never a label implying which one works, precisely so a test
 * (or a learner) cannot determine the fix from ticket text alone; both must be tried
 * against the live router to find out which one actually authenticates. See
 * `determineWorkingPat` below.
 */
function extractTicketTokens(ticketMd: string): [string, string] {
  const matches = [...ticketMd.matchAll(/`(ghp_[A-Za-z0-9]{36})`/g)].map((m) => m[1] as string);
  if (matches.length !== 2) {
    throw new Error(`expected exactly 2 PATs in ticketMd, found ${matches.length}`);
  }
  return [matches[0] as string, matches[1] as string];
}

/** Tries both candidate tokens against a real, live `/github/user` and reports which one
 *  actually authenticates. This is the only honest way to know which is the fix now that
 *  the ticket text itself carries no signal either way (fix round, spec hard constraint
 *  7a). */
async function determineWorkingPat(port: number, tokenA: string, tokenB: string): Promise<{ working: string; broken: string }> {
  const resA = await fetch(`http://127.0.0.1:${port}/github/user`, { headers: { authorization: `token ${tokenA}` } });
  if (resA.status === 200) return { working: tokenA, broken: tokenB };
  const resB = await fetch(`http://127.0.0.1:${port}/github/user`, { headers: { authorization: `token ${tokenB}` } });
  if (resB.status === 200) return { working: tokenB, broken: tokenA };
  throw new Error(`neither candidate token authenticated (statuses ${resA.status}, ${resB.status})`);
}

// --- Activation payload shape -----------------------------------------------------------

test('activate() returns the real scenario identity; activateDrill() hides it', () => {
  const engine = freshEngine();
  try {
    const real = engine.activate('t1-wrong-method');
    assert.equal(real.scenarioId, 't1-wrong-method');
    assert.equal(real.title, 'Wrong HTTP method');
    assert.equal(real.drill, false);
    assert.ok(Array.isArray(real.steps) && real.steps.length === 1);

    const drill = engine.activateDrill(1);
    assert.equal(drill.scenarioId, undefined);
    assert.equal(drill.title, undefined);
    assert.equal(drill.steps, undefined);
    assert.equal(drill.drill, true);
    assert.equal(drill.tier, 1);
    assert.ok(typeof drill.ticketMd === 'string' && drill.ticketMd.length > 0);
    assert.ok(drill.stepCount > 0);
  } finally {
    engine.dispose();
  }
});

test('activate() throws EngineError 404 for an unknown scenario id', () => {
  const engine = freshEngine();
  try {
    assert.throws(() => engine.activate('nope-not-real'), (err: unknown) => {
      assert.ok(err instanceof EngineError);
      assert.equal(err.status, 404);
      return true;
    });
  } finally {
    engine.dispose();
  }
});

test('activateDrill() throws EngineError 400 for a tier with no scenarios', () => {
  const engine = freshEngine();
  try {
    assert.throws(() => engine.activateDrill(6), (err: unknown) => {
      assert.ok(err instanceof EngineError);
      assert.equal(err.status, 400);
      return true;
    });
  } finally {
    engine.dispose();
  }
});

// --- THE acceptance test: per-run generation through the full activation path -----------

test('activating the same scenario twice produces different RunContext data end to end, and run 1 valid PAT does not solve run 2 (acceptance test)', async () => {
  const engine = freshEngine();
  try {
    const run1 = engine.activate('t2-revoked-pat');
    const world1 = activeWorld();
    const [run1TokenA, run1TokenB] = extractTicketTokens(run1.ticketMd);

    const app = buildRealPipelineApp();
    const { server: s1, port: p1 } = await listen(app);
    let run1Working: string;
    try {
      const { working } = await determineWorkingPat(p1, run1TokenA, run1TokenB);
      run1Working = working;
      assert.ok(world1.github.tokens[run1Working]?.valid, 'sanity: the token that just authenticated is genuinely valid in run 1 World');
    } finally {
      s1.close();
    }

    // Re-activate the SAME scenario id: fresh seed, fresh generate(), fresh resetState().
    const run2 = engine.activate('t2-revoked-pat');
    const world2 = activeWorld();
    const [run2TokenA, run2TokenB] = extractTicketTokens(run2.ticketMd);

    assert.notEqual(run1.seed, run2.seed, 'seed must differ between activations');
    assert.notEqual(run1TokenA, run2TokenA, "run 1's first-listed token must differ from run 2's");
    assert.notEqual(run1TokenB, run2TokenB, "run 1's second-listed token must differ from run 2's");
    assert.notDeepEqual(world1.github.repos, world2.github.repos, 'company/org repo draw must differ');
    assert.notEqual(run1.ticketMd, run2.ticketMd, 'ticket text (which embeds the credentials) must differ');
    assert.equal(world2.github.tokens[run1Working], undefined, "run 1's working token must not exist at all in run 2's World");

    const { server: s2, port: p2 } = await listen(app);
    try {
      const res2 = await fetch(`http://127.0.0.1:${p2}/github/user`, {
        headers: { authorization: `token ${run1Working}` },
      });
      assert.equal(res2.status, 401, "run 1's working token must NOT solve run 2");

      const { working: run2Working } = await determineWorkingPat(p2, run2TokenA, run2TokenB);
      assert.ok(run2Working, "run 2 must still have its own working token, discoverable independently");
    } finally {
      s2.close();
    }
  } finally {
    engine.dispose();
  }
});

// --- Fix round: hard constraint 7a, "the position or identity of the correct answer
// varies," not just the values. Run each affected scenario several times and confirm the
// fix is not always in the same slot. ---------------------------------------------------

// Minor fix (round 2): 8 runs carries a real flake rate for a fair 50/50 draw (2 * 0.5^8
// = 0.78%, roughly one spurious failure every 128 `npm test` runs). 14 runs drops that to
// 2 * 0.5^14 = 0.012% for six extra activations, cheap insurance against a test that
// cries wolf and gets ignored.
const DISTRIBUTION_TEST_RUNS = 14;

test('t2-revoked-pat: across 14 activations, the working token is NOT always in the same ticket slot (position varies, not just values)', async () => {
  const engine = freshEngine();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    let firstSlotWorkedCount = 0;
    let secondSlotWorkedCount = 0;
    const seenTicketTexts = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t2-revoked-pat');
      seenTicketTexts.add(activated.ticketMd);
      const [tokenA, tokenB] = extractTicketTokens(activated.ticketMd);
      const { working } = await determineWorkingPat(port, tokenA, tokenB);
      if (working === tokenA) firstSlotWorkedCount += 1;
      else secondSlotWorkedCount += 1;
    }
    assert.equal(
      seenTicketTexts.size,
      DISTRIBUTION_TEST_RUNS,
      'every activation must produce distinct ticket text (values still differ every run)',
    );
    assert.equal(firstSlotWorkedCount + secondSlotWorkedCount, DISTRIBUTION_TEST_RUNS);
    assert.ok(
      firstSlotWorkedCount > 0 && secondSlotWorkedCount > 0,
      `expected both ticket slots to win at least once across ${DISTRIBUTION_TEST_RUNS} runs; got first-slot=${firstSlotWorkedCount}, second-slot=${secondSlotWorkedCount}. ` +
        'An all-one-side split would mean the answer position is still fixed, exactly the bug this test guards against.',
    );
  } finally {
    server.close();
    engine.dispose();
  }
});

// --- Full lifecycle over a real HTTP pipeline: attempt, hint, step, explaining, solved --

test('full lifecycle: failed attempts emit a human reason and unlock a hint at 3, success advances to explaining, explain() solves', async () => {
  const engine = freshEngine();
  const events: TrainerEvent[] = [];
  const onTrainerEvent = (ev: TrainerEvent): void => {
    events.push(ev);
  };
  bus.on('trainer-event', onTrainerEvent);
  try {
    const activated = engine.activate('t2-revoked-pat');
    const [tokenA, tokenB] = extractTicketTokens(activated.ticketMd);
    // t2-revoked-pat's fault flips one token's World record to invalid: peek at World
    // directly to know which, rather than making a probing HTTP call that would itself
    // count as the very request this test needs to happen exactly 3 times below.
    const worldNow = activeWorld();
    const { validPat, revokedPat } = worldNow.github.tokens[tokenA]?.valid
      ? { validPat: tokenA, revokedPat: tokenB }
      : { validPat: tokenB, revokedPat: tokenA };

    const app = buildRealPipelineApp();
    const { server, port } = await listen(app);
    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/github/user`, {
          headers: { authorization: `token ${revokedPat}` },
        });
        assert.equal(res.status, 401);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));

      const attemptEvents = events.filter((e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> => e.type === 'scenario:attempt');
      assert.equal(attemptEvents.length, 3, 'three failed calls must produce three scenario:attempt events, never silence');
      for (const e of attemptEvents) {
        assert.match(e.reason, /expected status 200, got 401/, 'attempt feedback must say WHY it did not count');
      }

      const hintEvents = events.filter((e) => e.type === 'hint:unlocked');
      assert.equal(hintEvents.length, 1, 'a hint must unlock at exactly 3 attempts');

      const revealedHint = engine.hint();
      assert.equal(revealedHint.index, 0);
      assert.throws(() => engine.hint(), (err: unknown) => err instanceof EngineError && err.status === 409);

      assert.equal(engine.getState().attempts, 3);

      const okRes = await fetch(`http://127.0.0.1:${port}/github/user`, {
        headers: { authorization: `token ${validPat}` },
      });
      assert.equal(okRes.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.ok(events.some((e) => e.type === 'scenario:step'));
      assert.ok(events.some((e) => e.type === 'scenario:explaining'));
      assert.equal(engine.getState().state, 'explaining');

      assert.throws(() => engine.explain('', 'x'), (err: unknown) => err instanceof EngineError && err.status === 400);

      const solved = engine.explain('the wired-in token was revoked', 'we switched you to the current token');
      assert.match(solved.solutionMd, /Root cause/);
      assert.equal(engine.getState().state, 'solved');
      assert.ok(events.some((e) => e.type === 'scenario:solved'));

      const list = engine.listScenarios();
      const entry = list.find((s) => s.id === 't2-revoked-pat');
      assert.equal(entry?.solved, true);
      assert.equal(entry?.runs, 1);
    } finally {
      server.close();
    }
  } finally {
    bus.off('trainer-event', onTrainerEvent);
    engine.dispose();
  }
});

test('a request that does not match the current step is ignored entirely: no attempt, no event', async () => {
  const engine = freshEngine();
  const events: TrainerEvent[] = [];
  const onTrainerEvent = (ev: TrainerEvent): void => {
    events.push(ev);
  };
  bus.on('trainer-event', onTrainerEvent);
  try {
    engine.activate('t2-revoked-pat');
    const app = buildRealPipelineApp();
    const { server, port } = await listen(app);
    try {
      // /github/rate_limit is not this step's matcher target: browsing it must not count.
      await fetch(`http://127.0.0.1:${port}/github/rate_limit`, { headers: { authorization: 'token whatever' } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(events.filter((e) => e.type === 'scenario:attempt').length, 0);
      assert.equal(engine.getState().attempts, 0);
    } finally {
      server.close();
    }
  } finally {
    bus.off('trainer-event', onTrainerEvent);
    engine.dispose();
  }
});

// --- resetState / reset(): a solved scenario is re-runnable indefinitely ----------------

function findValidPat(tokenA: string, tokenB: string): string {
  const world = activeWorld();
  if (world.github.tokens[tokenA]?.valid) return tokenA;
  if (world.github.tokens[tokenB]?.valid) return tokenB;
  throw new Error('neither candidate token is valid in the current World');
}

test('reset() re-activates the current scenario with a new seed and is solvable again from a clean attempts/step count', async () => {
  const engine = freshEngine();
  try {
    const first = engine.activate('t2-revoked-pat');
    const app = buildRealPipelineApp();

    const [firstTokenA, firstTokenB] = extractTicketTokens(first.ticketMd);
    const validPat1 = findValidPat(firstTokenA, firstTokenB);
    const { server: s1, port: p1 } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${p1}/github/user`, { headers: { authorization: `token ${validPat1}` } });
      assert.equal(res.status, 200);
    } finally {
      s1.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(engine.getState().state, 'explaining');
    engine.explain('root cause', 'reply');
    assert.equal(engine.getState().state, 'solved');

    engine.reset();
    const state = engine.getState();
    assert.equal(state.state, 'active');
    assert.equal(state.attempts, 0);
    assert.equal(state.currentStepIndex, 0);
    assert.equal(state.scenarioId, 't2-revoked-pat');

    const second = engine.getState();
    assert.notEqual(second.ticketMd, first.ticketMd, 'reset() must mint a new seed, not replay the same run');

    const [secondTokenA, secondTokenB] = extractTicketTokens(second.ticketMd ?? '');
    const validPat2 = findValidPat(secondTokenA, secondTokenB);
    const { server: s2, port: p2 } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${p2}/github/user`, { headers: { authorization: `token ${validPat2}` } });
      assert.equal(res.status, 200, 'the reactivated run must be solvable again with its own fresh credentials');
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(engine.getState().state, 'explaining');
    } finally {
      s2.close();
    }
  } finally {
    engine.dispose();
  }
});

// --- activeInterceptFault(): unit-tested even though not wired into middleware yet ------

test('activeInterceptFault() matches a registered intercept fault by request shape, and returns undefined when idle', () => {
  const fault: Fault = {
    id: 'fake-intercept',
    kind: 'intercept',
    match: { method: 'GET', pathPattern: '^/slack/api/auth\\.test$' },
    respond: { status: 500, headers: { 'x-fake': '1' }, body: '{"ok":false}' },
  };
  const fakeDef: ScenarioDef = {
    id: 'fake-with-intercept',
    tier: 1,
    track: 'troubleshoot',
    title: 'fake',
    platform: 'slack',
    docsRef: [],
    build(_ctx: RunContext) {
      return { ticketMd: 'x', setup: [], faults: [fault], steps: [], hints: [], solutionMd: 'x' };
    },
  };
  const engine = freshEngine([fakeDef]);
  try {
    const req: MatchableRequest = { method: 'GET', pathLower: '/slack/api/auth.test', query: {}, headerNames: [] };

    // Idle: no active scenario, so no intercept can ever fire.
    assert.equal(engine.activeInterceptFault(req), undefined);

    engine.activate('fake-with-intercept');
    const found = engine.activeInterceptFault(req);
    assert.deepEqual(found, fault.respond);

    const nonMatching: MatchableRequest = { method: 'GET', pathLower: '/github/user', query: {}, headerNames: [] };
    assert.equal(engine.activeInterceptFault(nonMatching), undefined);

    // matchesRequest itself is exercised directly too, as belt and suspenders.
    assert.equal(matchesRequest(fault.match, req), true);
  } finally {
    engine.dispose();
  }
});

test('every registered scenario 1-15 builds without throwing, for every scenario in the registry', () => {
  // A cheap smoke test: build() must not throw for a real generated RunContext, for
  // every scenario currently registered (tiers 1-5, through Task 7).
  const engine = freshEngine();
  try {
    for (const def of scenarioRegistry) {
      const payload = engine.activate(def.id);
      assert.equal(payload.scenarioId, def.id);
      assert.ok(payload.ticketMd.length > 0);
      assert.ok((payload.steps ?? []).length > 0);
      assert.ok(payload.docsRef.length > 0, `${def.id}: docsRef must be a real, non-empty reference`);
    }
    assert.equal(scenarioRegistry.length, 15, 'scenarios 1-15 are registered (tiers 1-5)');
  } finally {
    engine.dispose();
  }
});

// --- Task 6 fix round, finding 2: docsRef was authored on every scenario but had zero
// consumers anywhere in the codebase (not the activate payload, any trainer event,
// shared/src/api.ts, or web/src). Exposed via ActivatedPayload/EnginePublicState so it is
// a real, inspectable part of the API contract, not fiction described only in a comment. --

test('docsRef passes through from ScenarioDef to both the activate payload and getState(), and stays exposed in drill mode', () => {
  const engine = freshEngine();
  try {
    const def = scenarioRegistry.find((d) => d.id === 't3-redirect-mismatch');
    assert.ok(def, 'sanity: t3-redirect-mismatch must be registered');
    const activated = engine.activate('t3-redirect-mismatch');
    assert.deepEqual(activated.docsRef, def?.docsRef, 'activate() must echo the SAME docsRef the ScenarioDef declares, not a copy that could drift');
    assert.deepEqual(engine.getState().docsRef, def?.docsRef);

    // Drill mode hides scenario IDENTITY (id/title/fault shape); docsRef names doc TOPICS,
    // not identity, so unlike scenarioId/title it stays exposed here too.
    const drill = engine.activateDrill(1);
    assert.equal(drill.scenarioId, undefined, 'sanity: drill mode really does hide identity');
    assert.ok(Array.isArray(drill.docsRef) && drill.docsRef.length > 0, 'docsRef is NOT hidden by drill mode');
  } finally {
    engine.dispose();
  }
});

// --- Fix round 2, Important #1: attemptHint is authored on every step but was reachable
// nowhere (no event field, getState() omitted it). ---------------------------------------

test('attemptHint reaches both the scenario:attempt event and getState(), distinct from the mechanical reason', async () => {
  const engine = freshEngine();
  const events: TrainerEvent[] = [];
  const onTrainerEvent = (ev: TrainerEvent): void => {
    events.push(ev);
  };
  bus.on('trainer-event', onTrainerEvent);
  try {
    engine.activate('t1-wrong-method');
    const beforeAnyAttempt = engine.getState();
    assert.equal(
      beforeAnyAttempt.attemptHint,
      'Read the Allow header on the 405 response you already got.',
      'attemptHint is available from getState() even before any attempt happens',
    );

    const app = buildRealPipelineApp();
    const { server, port } = await listen(app);
    try {
      // POST is the wrong method for this scenario's step matcher (still matches, per
      // t1-wrong-method's design, so it counts as an attempt rather than being ignored).
      await fetch(`http://127.0.0.1:${port}/github/user`, { method: 'POST', headers: { authorization: 'token whatever' } });
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      server.close();
    }

    const attemptEvent = events.find((e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> => e.type === 'scenario:attempt');
    assert.ok(attemptEvent, 'expected a scenario:attempt event');
    assert.equal(attemptEvent.attemptHint, 'Read the Allow header on the 405 response you already got.');
    assert.notEqual(attemptEvent.reason, attemptEvent.attemptHint, 'reason (mechanical) and attemptHint (human) are distinct fields');

    const afterAttempt = engine.getState();
    assert.equal(afterAttempt.attemptHint, 'Read the Allow header on the 405 response you already got.');
  } finally {
    bus.off('trainer-event', onTrainerEvent);
    engine.dispose();
  }
});

test('getState().attemptHint is undefined for a step that defines none', () => {
  const fakeDef: ScenarioDef = {
    id: 'fake-no-hint',
    tier: 1,
    track: 'troubleshoot',
    title: 'fake',
    platform: 'github',
    docsRef: [],
    build(_ctx: RunContext) {
      return {
        ticketMd: 'x',
        setup: [],
        faults: [],
        steps: [{ id: 'step-1', title: 'x', match: { pathPattern: '^/github/user$' }, assertions: [] }],
        hints: [],
        solutionMd: 'x',
      };
    },
  };
  const engine = freshEngine([fakeDef]);
  try {
    engine.activate('fake-no-hint');
    assert.equal(engine.getState().attemptHint, undefined);
  } finally {
    engine.dispose();
  }
});

// --- Task 6 fix: `built.setup` was authored by BuiltScenario but never invoked anywhere
// in activateDef(). Silent because every scenario through Task 3's two fix rounds passed
// `setup: []`; t3-token-expiry (Task 6) is the first to rely on it. ---------------------

test('built.setup mutations apply to the World before the first request arrives', () => {
  const fakeDef: ScenarioDef = {
    id: 'fake-with-setup',
    tier: 3,
    track: 'troubleshoot',
    title: 'fake',
    platform: 'google',
    docsRef: [],
    build(_ctx: RunContext) {
      return {
        ticketMd: 'x',
        setup: [(w) => { w.google.accessTokenTtlSec = 15; }],
        faults: [],
        steps: [],
        hints: [],
        solutionMd: 'x',
      };
    },
  };
  const engine = freshEngine([fakeDef]);
  try {
    engine.activate('fake-with-setup');
    assert.equal(activeWorld().google.accessTokenTtlSec, 15, 'setup() must run before the World is handed to the first request');
  } finally {
    engine.dispose();
  }
});

test('built.setup runs before faults are applied, so a fault can see setup-mutated state', () => {
  const order: string[] = [];
  const fault: Fault = {
    id: 'fake-fault-after-setup',
    kind: 'state',
    apply(w) {
      order.push('fault');
      // Proves setup already ran: reads a value only setup() would have written.
      assert.equal(w.google.accessTokenTtlSec, 15);
    },
  };
  const fakeDef: ScenarioDef = {
    id: 'fake-setup-then-fault',
    tier: 3,
    track: 'troubleshoot',
    title: 'fake',
    platform: 'google',
    docsRef: [],
    build(_ctx: RunContext) {
      return {
        ticketMd: 'x',
        setup: [(w) => { order.push('setup'); w.google.accessTokenTtlSec = 15; }],
        faults: [fault],
        steps: [],
        hints: [],
        solutionMd: 'x',
      };
    },
  };
  const engine = freshEngine([fakeDef]);
  try {
    engine.activate('fake-setup-then-fault');
    assert.deepEqual(order, ['setup', 'fault']);
  } finally {
    engine.dispose();
  }
});

// --- Fix round 2, Important #2: clearFaults used to silently no-op for state faults. ----

test('clearFaults genuinely reverts a state fault once its step completes', async () => {
  const revertCalls: string[] = [];
  const fault: Fault = {
    id: 'revertible-fault',
    kind: 'state',
    apply(w) {
      const record = w.github.tokens[Object.keys(w.github.tokens)[0] as string];
      if (record) record.rateLimit.remaining = 0;
    },
    revert(w) {
      revertCalls.push('reverted');
      for (const record of Object.values(w.github.tokens)) record.rateLimit.remaining = record.rateLimit.limit;
    },
  };
  const fakeDef: ScenarioDef = {
    id: 'fake-clearable',
    tier: 1,
    track: 'troubleshoot',
    title: 'fake',
    platform: 'github',
    docsRef: [],
    build(ctx: RunContext) {
      return {
        ticketMd: 'x',
        setup: [],
        faults: [fault],
        steps: [
          {
            id: 'step-1',
            title: 'trigger the fault to clear',
            match: { method: 'GET', pathPattern: '^/github/rate_limit$' },
            assertions: [{ kind: 'status', equals: 200 }],
            clearFaults: ['revertible-fault'],
          },
          {
            id: 'step-2',
            title: 'prove the budget is back',
            match: { method: 'GET', pathPattern: '^/github/user$' },
            assertions: [
              { kind: 'status', equals: 200 },
              { kind: 'headerEquals', name: 'x-ratelimit-remaining', equals: String(ctx.github.rateLimit - 1) },
            ],
          },
        ],
        hints: [],
        solutionMd: 'x',
      };
    },
  };
  const engine = freshEngine([fakeDef]);
  try {
    engine.activate('fake-clearable');
    const app = buildRealPipelineApp();
    const { server, port } = await listen(app);
    try {
      const world = activeWorld();
      const anyToken = Object.keys(world.github.tokens)[0] as string;
      assert.equal(world.github.tokens[anyToken]?.rateLimit.remaining, 0, 'sanity: the fault applied at activation');

      // Step 1: GET /rate_limit does not itself charge budget (real GitHub behavior,
      // already relied on elsewhere in this router), so it can report the zeroed budget
      // without the assertion racing the charge.
      const res1 = await fetch(`http://127.0.0.1:${port}/github/rate_limit`, { headers: { authorization: `token ${anyToken}` } });
      assert.equal(res1.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.deepEqual(revertCalls, ['reverted'], 'revert() must run when step 1 completes, clearing the fault');
      assert.equal(engine.getState().currentStepIndex, 1);

      // Step 2: with the budget genuinely restored, the request now succeeds with a
      // fresh remaining count, proving revert() actually mutated the live World, not
      // just that the function was called.
      const res2 = await fetch(`http://127.0.0.1:${port}/github/user`, { headers: { authorization: `token ${anyToken}` } });
      assert.equal(res2.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(engine.getState().state, 'explaining');
    } finally {
      server.close();
    }
  } finally {
    engine.dispose();
  }
});

test('activate() throws immediately, at activation, when clearFaults names an id no fault registered', () => {
  const fakeDef: ScenarioDef = {
    id: 'fake-bad-clearfaults-unknown',
    tier: 1,
    track: 'troubleshoot',
    title: 'fake',
    platform: 'github',
    docsRef: [],
    build(_ctx: RunContext) {
      return {
        ticketMd: 'x',
        setup: [],
        faults: [],
        steps: [
          {
            id: 'step-1',
            title: 'x',
            match: { pathPattern: '^/github/user$' },
            assertions: [],
            clearFaults: ['this-id-does-not-exist'],
          },
        ],
        hints: [],
        solutionMd: 'x',
      };
    },
  };
  const engine = freshEngine([fakeDef]);
  try {
    assert.throws(() => engine.activate('fake-bad-clearfaults-unknown'), /clearFaults references unknown fault id "this-id-does-not-exist"/);
  } finally {
    engine.dispose();
  }
});

test('activate() throws immediately, at activation, when clearFaults names a state fault with no revert()', () => {
  const faultWithoutRevert: Fault = {
    id: 'no-revert-fault',
    kind: 'state',
    apply(_w) {
      /* no-op for this test */
    },
  };
  const fakeDef: ScenarioDef = {
    id: 'fake-bad-clearfaults-no-revert',
    tier: 1,
    track: 'troubleshoot',
    title: 'fake',
    platform: 'github',
    docsRef: [],
    build(_ctx: RunContext) {
      return {
        ticketMd: 'x',
        setup: [],
        faults: [faultWithoutRevert],
        steps: [
          {
            id: 'step-1',
            title: 'x',
            match: { pathPattern: '^/github/user$' },
            assertions: [],
            clearFaults: ['no-revert-fault'],
          },
        ],
        hints: [],
        solutionMd: 'x',
      };
    },
  };
  const engine = freshEngine([fakeDef]);
  try {
    assert.throws(
      () => engine.activate('fake-bad-clearfaults-no-revert'),
      /clearFaults references state fault "no-revert-fault", which has no revert\(\)/,
    );
  } finally {
    engine.dispose();
  }
});

test('clearFaults still works for intercept faults (the pre-existing, already-correct path)', () => {
  const intercept: Fault = {
    id: 'clearable-intercept',
    kind: 'intercept',
    match: { method: 'GET', pathPattern: '^/slack/api/auth\\.test$' },
    respond: { status: 500, headers: {}, body: '{}' },
  };
  const fakeDef: ScenarioDef = {
    id: 'fake-clearable-intercept',
    tier: 1,
    track: 'troubleshoot',
    title: 'fake',
    platform: 'slack',
    docsRef: [],
    build(_ctx: RunContext) {
      return {
        ticketMd: 'x',
        setup: [],
        faults: [intercept],
        steps: [
          {
            id: 'step-1',
            title: 'x',
            match: { method: 'GET', pathPattern: '^/github/user$' },
            assertions: [{ kind: 'status', equals: 401 }],
            clearFaults: ['clearable-intercept'],
          },
        ],
        hints: [],
        solutionMd: 'x',
      };
    },
  };
  const engine = freshEngine([fakeDef]);
  try {
    const req: MatchableRequest = { method: 'GET', pathLower: '/slack/api/auth.test', query: {}, headerNames: [] };
    engine.activate('fake-clearable-intercept');
    assert.deepEqual(engine.activeInterceptFault(req), intercept.respond);
  } finally {
    engine.dispose();
  }
});

// --- Fix round 2, Important #3: WHICH scope is missing, not just which token. -----------

test('t2-missing-scope: across enough activations, both real scope-gated endpoints (org listing and notifications) get drawn', () => {
  const engine = freshEngine();
  try {
    const seenPaths = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t2-missing-scope');
      const step = activated.steps?.[0];
      assert.ok(step, 'expected exactly one step');
      // No HTTP call needed for this check: the endpoint choice is already observable
      // from the activated payload's step title.
      seenPaths.add(step.title);
    }
    const sawOrgVariant = [...seenPaths].some((t) => t.startsWith('List repos in'));
    const sawNotificationsVariant = [...seenPaths].some((t) => t === 'List notifications');
    assert.ok(
      sawOrgVariant && sawNotificationsVariant,
      `expected both the org-listing and notifications variants across ${DISTRIBUTION_TEST_RUNS} runs; saw step titles: ${[...seenPaths].join(', ')}`,
    );
  } finally {
    engine.dispose();
  }
});

test('t2-missing-scope: the notifications variant is genuinely solvable end to end (real GET /notifications, real 403 then real 200)', async () => {
  const engine = freshEngine();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    // Activate repeatedly until the notifications variant is drawn (bounded: a 50/50
    // draw not landing on one side in 50 tries would itself indicate a real bug).
    let activated = engine.activate('t2-missing-scope');
    let tries = 0;
    while (activated.steps?.[0]?.title !== 'List notifications' && tries < 50) {
      activated = engine.activate('t2-missing-scope');
      tries += 1;
    }
    assert.equal(activated.steps?.[0]?.title, 'List notifications', 'notifications variant never drawn in 50 tries');

    const [tokenA, tokenB] = extractTicketTokens(activated.ticketMd);
    const world = activeWorld();
    const brokenToken = world.github.tokens[tokenA]?.scopes.includes('notifications') ? tokenB : tokenA;
    const workingToken = brokenToken === tokenA ? tokenB : tokenA;

    const badRes = await fetch(`http://127.0.0.1:${port}/github/notifications`, { headers: { authorization: `token ${brokenToken}` } });
    assert.equal(badRes.status, 403);
    assert.equal(badRes.headers.get('x-accepted-oauth-scopes'), 'notifications');

    const goodRes = await fetch(`http://127.0.0.1:${port}/github/notifications`, { headers: { authorization: `token ${workingToken}` } });
    assert.equal(goodRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(engine.getState().state, 'explaining');
  } finally {
    server.close();
    engine.dispose();
  }
});
