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
  const server = app.listen(0);
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

test('t2-revoked-pat: across 8 activations, the working token is NOT always in the same ticket slot (position varies, not just values)', async () => {
  const engine = freshEngine();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    let firstSlotWorkedCount = 0;
    let secondSlotWorkedCount = 0;
    const seenTicketTexts = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const activated = engine.activate('t2-revoked-pat');
      seenTicketTexts.add(activated.ticketMd);
      const [tokenA, tokenB] = extractTicketTokens(activated.ticketMd);
      const { working } = await determineWorkingPat(port, tokenA, tokenB);
      if (working === tokenA) firstSlotWorkedCount += 1;
      else secondSlotWorkedCount += 1;
    }
    assert.equal(seenTicketTexts.size, 8, 'every activation must produce distinct ticket text (values still differ every run)');
    assert.equal(firstSlotWorkedCount + secondSlotWorkedCount, 8);
    assert.ok(
      firstSlotWorkedCount > 0 && secondSlotWorkedCount > 0,
      `expected both ticket slots to win at least once across 8 runs; got first-slot=${firstSlotWorkedCount}, second-slot=${secondSlotWorkedCount}. ` +
        'A 8/0 or 0/8 split would mean the answer position is still fixed, exactly the bug this test guards against.',
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

test('every registered scenario 1-7 builds without throwing, for every scenario in the registry', () => {
  // A cheap smoke test: build() must not throw for a real generated RunContext, for
  // every scenario currently registered (all seven from this task).
  const engine = freshEngine();
  try {
    for (const def of scenarioRegistry) {
      const payload = engine.activate(def.id);
      assert.equal(payload.scenarioId, def.id);
      assert.ok(payload.ticketMd.length > 0);
      assert.ok((payload.steps ?? []).length > 0);
    }
    assert.equal(scenarioRegistry.length, 7, 'this task ships exactly scenarios 1-7');
  } finally {
    engine.dispose();
  }
});
