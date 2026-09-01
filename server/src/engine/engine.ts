import type {
  ActivatedPayload,
  BuiltScenario,
  EnginePublicState,
  Fault,
  RequestEvent,
  RunContext,
  ScenarioDef,
  StateStepSummary,
  Step,
  TrainerEvent,
} from '@gym/shared';
import { bus } from '../bus.js';
import { activeWorld, resetState } from '../platforms/world.js';
import { evaluateAssertions, customAssertions } from './assert.js';
import { generate, hashSeedToUint32, mintSeed } from './generate.js';
import { matchesRequest, toMatchable, type MatchableRequest } from './match.js';
import { defaultScenarioProgressEntry, progressStore, type JsonStore, type ProgressFile } from './persist.js';
import { scenarioRegistry } from '../scenarios/index.js';

/**
 * The engine: lifecycle state machine and `observe()` (docs/SPEC.md section 9), the heart
 * of this project. `idle -> active -> explaining -> solved`, driven entirely by
 * `RequestEvent`s arriving off the shared `bus` (requestLog emits them for every request
 * that reaches the middleware spine, whether it came from the built-in proxy or real
 * Postman desktop).
 */

export type EngineLifecycleState = 'idle' | 'active' | 'explaining' | 'solved';

export class EngineError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
  }
}

// `ActivatedPayload`, `StateStepSummary`, and `EnginePublicState` are imported from
// `@gym/shared` (`shared/src/api.ts`), not declared here. Final-review fix round, finding
// 3: this file used to declare its own, separate copies of all three, and they had
// already drifted from the shared ones the web client actually imports (this file's copy
// carried `docsRef`, `shared/src/api.ts`'s did not), so the server put `docsRef` on the
// wire while the type the web client imports never declared it existed. Two names for
// "the same shape" that quietly stop being the same shape is worse than no shared type at
// all, because it still typechecks clean on both sides. See `shared/src/api.ts`'s own
// header comment on `ActivatedPayload` for the rest of this reasoning.

export interface ScenarioListEntry {
  id: string;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  track: 'troubleshoot' | 'implementation';
  title: string;
  platform: 'github' | 'google' | 'glean' | 'slack' | 'mixed';
  solved: boolean;
  runs: number;
}

interface ActiveRun {
  def: ScenarioDef;
  built: BuiltScenario;
  ctx: RunContext;
  drill: boolean;
  stepIndex: number;
  attempts: number;
  hintsUnlocked: number;
  hintsRevealed: number;
  solutionRevealed: boolean;
  /** Every fault this run registered, by id (both kinds), so `clearFaults` can look one
   *  up regardless of kind (fix round 2). Populated once, at activation; never mutated. */
  faultsById: Map<string, Fault>;
  /**
   * Whether a request has matched the CURRENT step and failed at least one assertion
   * since this step became current (final-review fix round, finding 1). Gates whether
   * `getState()` may surface `attemptHint` at all: spec section 8 defines `attemptHint`
   * as shown "when match hits but assertions fail," an EVENT, not a standing property of
   * the step, so `/state` handing it over unconditionally (the pre-fix behavior) gave the
   * whole discovery away for free at zero attempts. Set `true` only by a genuine
   * current-step match+fail (`recordCurrentStepAttempt`); an out-of-order match against a
   * DIFFERENT step (finding 2, `maybeRecordOutOfOrderAttempt`) never sets it, since that
   * did not match the current step at all. Reset to `false` on activation and every time
   * `completeStep()` advances to a new current step.
   */
  currentStepAttemptFailed: boolean;
}

type InterceptFault = Extract<Fault, { kind: 'intercept' }>;

/** Attempt counts at which a new hint unlocks (docs/SPEC.md section 9: "Unlock hints at
 *  3/6/9"). */
const HINT_THRESHOLDS = [3, 6, 9];

export class Engine {
  private readonly registry: ScenarioDef[];
  private readonly progress: JsonStore<ProgressFile>;
  private state: EngineLifecycleState = 'idle';
  private current: ActiveRun | null = null;
  private readonly activeIntercepts = new Map<string, InterceptFault>();
  private readonly onRequest = (ev: RequestEvent): void => this.observe(ev);

  /** `registry`/`progress` are constructor parameters, not module-level imports used
   *  directly, specifically so tests can construct an isolated `Engine` (a fake scenario
   *  registry, a progress store pointed at a temp file) without touching the real
   *  `data/progress.json` or interfering with other tests through the shared `bus`
   *  singleton (each instance subscribes to `bus` on construction; call `dispose()` in
   *  test teardown to unsubscribe). The production singleton at the bottom of this file
   *  uses the real registry and the real progress store. */
  constructor(registry: ScenarioDef[], progress: JsonStore<ProgressFile> = progressStore) {
    this.registry = registry;
    this.progress = progress;
    bus.on('request', this.onRequest);
  }

  dispose(): void {
    bus.off('request', this.onRequest);
  }

  /**
   * Boots a healthy World with no scenario active (docs/PLAN.md Task 3: "Boot the World
   * with a default run context"). Verified defect as of commit `351ecb3`: without this,
   * `GET /github/user` 500s before any scenario is ever activated, because
   * `activeWorld()` throws when `resetState()` has never run. Free exploration and the
   * implementation track both need a working World with no scenario chosen, and a 500
   * teaches nothing. Call once at server startup (`server/src/index.ts`); tests that need
   * a healthy, scenario-free World call it too.
   */
  boot(): void {
    resetState(generate(mintSeed()));
    this.state = 'idle';
    this.current = null;
    this.activeIntercepts.clear();
  }

  listScenarios(): ScenarioListEntry[] {
    const progress = this.progress.get();
    return this.registry.map((def) => {
      const entry = progress.scenarios[def.id];
      return {
        id: def.id,
        tier: def.tier,
        track: def.track,
        title: def.title,
        platform: def.platform,
        solved: entry?.solved ?? false,
        runs: entry?.runs ?? 0,
      };
    });
  }

  activate(scenarioId: string): ActivatedPayload {
    const def = this.registry.find((d) => d.id === scenarioId);
    if (!def) throw new EngineError(404, `no such scenario: ${scenarioId}`);
    return this.activateDef(def, false);
  }

  activateDrill(tier?: number): ActivatedPayload {
    const pool = this.registry.filter((d) => d.track === 'troubleshoot' && (tier === undefined || d.tier === tier));
    if (pool.length === 0) {
      throw new EngineError(
        400,
        tier === undefined ? 'no scenarios available for drill' : `no tier ${tier} scenarios available for drill`,
      );
    }
    // The scenario draw is derived from the same freshly minted seed used to generate the
    // run's data, not Math.random: given a seed, which scenario got drawn is reproducible
    // too, matching the "a seed fully reproduces a run for debugging" requirement.
    const seed = mintSeed();
    const index = hashSeedToUint32(seed) % pool.length;
    const def = pool[index];
    if (!def) throw new Error('activateDrill(): pool index out of bounds, this should be unreachable');
    return this.activateDef(def, true, seed);
  }

  /** Re-activates whichever scenario (or drill draw) is currently loaded, with a fresh
   *  seed (docs/SPEC.md section 10: "re-activates current, new seed"). */
  reset(): void {
    const c = this.current;
    if (!c) throw new EngineError(409, 'no scenario has been activated yet');
    this.activateDef(c.def, c.drill);
  }

  private activateDef(def: ScenarioDef, drill: boolean, seedOverride?: string): ActivatedPayload {
    const seed = seedOverride ?? mintSeed();
    const ctx = generate(seed);
    resetState(ctx);
    const built = def.build(ctx);
    this.validateClearFaults(def.id, built);
    const world = activeWorld();

    // Apply `setup` before faults are registered (docs/SPEC.md section 9: "def.build(ctx)
    // -> apply setup -> register faults"). Task 6 fix: this call was missing entirely
    // through Task 3's build and both its fix rounds; every scenario shipped so far
    // passed `setup: []`, so the gap was silent. `t3-token-expiry` is the first scenario
    // to rely on it (overriding `accessTokenTtlSec` for that one scenario only, without
    // touching `generate()`'s baseline), so this had to be fixed before it could work.
    for (const setupFn of built.setup) setupFn(world);

    const faultsById = new Map<string, Fault>();
    for (const fault of built.faults) faultsById.set(fault.id, fault);

    this.activeIntercepts.clear();
    for (const fault of built.faults) {
      // State faults mutate the World immediately, at activation (docs/SPEC.md section
      // 7); intercept faults are registered so activeInterceptFault() can find them
      // later, once a matching request arrives.
      if (fault.kind === 'state') {
        fault.apply(world);
      } else {
        this.activeIntercepts.set(fault.id, fault);
      }
    }

    this.current = {
      def,
      built,
      ctx,
      drill,
      stepIndex: 0,
      attempts: 0,
      hintsUnlocked: 0,
      hintsRevealed: 0,
      solutionRevealed: false,
      faultsById,
      currentStepAttemptFailed: false,
    };
    this.state = 'active';
    this.bumpRuns(def.id);

    const payload = this.buildActivatedPayload();
    this.emit({ type: 'scenario:activated', ts: Date.now(), ...payload });
    return payload;
  }

  /**
   * Fail-fast, at activation, on a `clearFaults` id that can never do anything (fix round
   * 2): either it names no fault the scenario actually registered, or it names a state
   * fault with no `revert()` to undo it. Both used to be silent no-ops at request time,
   * deep inside `completeStep()`, giving a scenario author (Task 8's capstone will be the
   * first to actually stage breakage this way) no signal that anything was wrong. Running
   * this here, inside `activate()`/`activateDrill()`/`reset()`, means a broken
   * `clearFaults` reference throws the moment the scenario is activated (caught by any
   * test that calls `engine.activate(id)`, including the smoke test that already loops
   * every registered scenario), not lazily only once a learner happens to complete the
   * specific step that references it. Express converts a synchronous throw from a route
   * handler into a clean 500 (app.ts's error handler), so this cannot crash the process
   * the way throwing from inside a bus-event listener (`observe()`, mid live-request)
   * could.
   */
  private validateClearFaults(scenarioId: string, built: BuiltScenario): void {
    for (const step of built.steps) {
      for (const id of step.clearFaults ?? []) {
        const fault = built.faults.find((f) => f.id === id);
        if (!fault) {
          throw new Error(
            `scenario "${scenarioId}": step "${step.id}" clearFaults references unknown fault id "${id}"`,
          );
        }
        if (fault.kind === 'state' && !fault.revert) {
          throw new Error(
            `scenario "${scenarioId}": step "${step.id}" clearFaults references state fault "${id}", ` +
              'which has no revert(). Add one, or drop it from clearFaults.',
          );
        }
      }
    }
  }

  private buildActivatedPayload(): ActivatedPayload {
    const c = this.mustCurrent();
    const base: ActivatedPayload = {
      seed: c.ctx.seed,
      tier: c.def.tier,
      track: c.def.track,
      platform: c.def.platform,
      ticketMd: c.built.ticketMd,
      stepCount: c.built.steps.length,
      drill: c.drill,
      docsRef: c.def.docsRef,
    };
    // Drill mode: "the activated payload omits title and any fault identity. Only
    // ticketMd and step count are exposed" (docs/SPEC.md section 9).
    if (c.drill) return base;
    return {
      ...base,
      scenarioId: c.def.id,
      title: c.def.title,
      steps: c.built.steps.map((s) => ({ id: s.id, title: s.title })),
    };
  }

  getState(): EnginePublicState {
    const c = this.current;
    if (!c) return { state: this.state };
    const steps: StateStepSummary[] = c.built.steps.map((s, i) => ({
      id: s.id,
      title: c.drill ? undefined : s.title,
      done: i < c.stepIndex,
    }));
    return {
      state: this.state,
      scenarioId: c.drill ? undefined : c.def.id,
      title: c.drill ? undefined : c.def.title,
      tier: c.def.tier,
      track: c.def.track,
      platform: c.def.platform,
      drill: c.drill,
      ticketMd: c.built.ticketMd,
      docsRef: c.def.docsRef,
      steps,
      currentStepIndex: c.stepIndex,
      stepCount: c.built.steps.length,
      attempts: c.attempts,
      hintsUnlocked: c.hintsUnlocked,
      hintsRevealed: c.hintsRevealed,
      solutionRevealed: c.solutionRevealed,
      // Fix round finding 1 (CRITICAL): only once a request has genuinely matched the
      // CURRENT step and failed an assertion, never unconditionally. See
      // `ActiveRun.currentStepAttemptFailed`'s own doc comment for the full reasoning.
      attemptHint: c.currentStepAttemptFailed ? c.built.steps[c.stepIndex]?.attemptHint : undefined,
    };
  }

  /** Progressive reveal: each call returns the next unlocked-but-not-yet-shown hint, or
   *  409 once the caller has caught up to what is unlocked. */
  hint(): { index: number; text: string } {
    const c = this.mustCurrent();
    if (c.hintsRevealed >= c.hintsUnlocked) {
      throw new EngineError(409, c.hintsUnlocked === 0 ? 'no hint unlocked yet' : 'no new hint unlocked yet');
    }
    const index = c.hintsRevealed;
    const text = c.built.hints[index];
    if (text === undefined) throw new EngineError(409, 'no hint available at this index');
    c.hintsRevealed += 1;
    return { index, text };
  }

  revealSolution(): { solutionMd: string } {
    const c = this.mustCurrent();
    c.solutionRevealed = true;
    return { solutionMd: c.built.solutionMd };
  }

  explain(rootCause: string, customerReply: string): { solutionMd: string } {
    const c = this.mustCurrent();
    if (this.state !== 'explaining') {
      throw new EngineError(409, `cannot explain from state '${this.state}': finish every step first`);
    }
    if (rootCause.trim() === '' || customerReply.trim() === '') {
      throw new EngineError(400, 'rootCause and customerReply are both required');
    }
    const now = new Date().toISOString();
    this.progress.update((p) => {
      const entry = p.scenarios[c.def.id] ?? defaultScenarioProgressEntry();
      entry.solved = true;
      entry.solvedAt = now;
      entry.explanations.push({ at: now, rootCause, customerReply });
      p.scenarios[c.def.id] = entry;
    });
    this.state = 'solved';
    this.emit({ type: 'scenario:solved', ts: Date.now() });
    return { solutionMd: c.built.solutionMd };
  }

  /**
   * `faultInjector` (server/src/middleware/faultInjector.ts) consults this before a
   * request reaches the healthy platform routers, short-circuiting with the fault's
   * verbatim `respond` (docs/SPEC.md section 7). Wired in during the first Task 3 fix
   * round (`faultInjector.ts`'s `createFaultInjector`): it builds a `MatchableRequest`
   * from the incoming `req` and short-circuits when this returns non-undefined. None of
   * scenarios 1-7 use an intercept fault (all are state faults, per the brief's "prefer
   * state faults" guidance), so this path is unit-tested (`faultInjector.test.ts`,
   * `engine.test.ts`) but not exercised by the current registry's live traffic; ready for
   * Tasks 6/7's intercept faults.
   */
  activeInterceptFault(req: MatchableRequest): { status: number; headers: Record<string, string>; body: string } | undefined {
    if (this.state !== 'active' || !this.current) return undefined;
    for (const fault of this.activeIntercepts.values()) {
      if (matchesRequest(fault.match, req)) return fault.respond;
    }
    return undefined;
  }

  /**
   * Final-review fix round, finding 2 (the highest-value structural fix): before this,
   * only the CURRENT step's own matcher was ever consulted, so any reasonable but
   * out-of-order action (posting before joining, refreshing before the first exchange, a
   * step-3 request while still on step 1) was completely invisible to the engine: no
   * attempt, no reason, no hint, no way to unlock one. This is the THIRD instance of "a
   * wrong attempt registers as zero attempts" this build has shipped, and it sits exactly
   * where the multi-step scenarios are, so a request that matches no step at all is still
   * genuine browsing (ignored, same as before), but one that matches a DIFFERENT step now
   * falls through to `maybeRecordOutOfOrderAttempt` below instead of being dropped
   * silently.
   */
  private observe(ev: RequestEvent): void {
    if (this.state !== 'active' || !this.current) return;
    const c = this.current;
    const step = c.built.steps[c.stepIndex];
    if (!step) return;
    const matchable = toMatchable(ev);
    if (!matchesRequest(step.match, matchable)) {
      this.maybeRecordOutOfOrderAttempt(c, step, matchable);
      return;
    }

    const result = evaluateAssertions(step.assertions, ev, customAssertions);
    if (result.pass) {
      this.completeStep(step);
    } else {
      this.recordCurrentStepAttempt(step, result.reason ?? 'assertion failed');
    }
  }

  /**
   * Checks every OTHER step in this scenario (never the current one, already ruled out by
   * the caller) for a match against a request that missed the current step. A hit means
   * the learner did something that belongs to a different point in the scenario, real
   * signal worth counting toward the attempt total and the 3/6/9 hint gate, not silence.
   * The reason names the confusion directly ("that is step 3; you are on step 1"), the
   * exact framing finding 2 calls for. Never advances `stepIndex`, never runs the OTHER
   * step's assertions, and never completes anything: only the current step's own
   * match+assertions can do that, in `observe()` above. A request matching no step at all
   * (genuine browsing) still falls through with no attempt recorded.
   */
  private maybeRecordOutOfOrderAttempt(c: ActiveRun, currentStep: Step, matchable: MatchableRequest): void {
    const currentIndex = c.stepIndex;
    for (let i = 0; i < c.built.steps.length; i++) {
      if (i === currentIndex) continue;
      const other = c.built.steps[i];
      if (other && matchesRequest(other.match, matchable)) {
        const reason =
          `That request is step ${i + 1} ("${other.title}"); you are currently on step ` +
          `${currentIndex + 1} ("${currentStep.title}").`;
        // Not a current-step match+fail (it matched a DIFFERENT step's matcher, not this
        // one's), so no `attemptHint` and `currentStepAttemptFailed` stays untouched: see
        // that field's own doc comment.
        this.recordAttempt(currentStep, reason, undefined, false);
        return;
      }
    }
  }

  private completeStep(step: Step): void {
    const c = this.mustCurrent();
    if (step.clearFaults) {
      for (const id of step.clearFaults) this.clearFault(c, id);
    }
    const nextStepIndex = c.stepIndex + 1;
    this.emit({ type: 'scenario:step', ts: Date.now(), stepId: step.id, nextStepIndex });
    c.stepIndex = nextStepIndex;
    // A new step is now current (or none is, once the scenario is fully complete): any
    // matched-but-failed attempt recorded against the PREVIOUS current step no longer
    // says anything about this one (fix round finding 1).
    c.currentStepAttemptFailed = false;
    if (c.stepIndex >= c.built.steps.length) {
      this.state = 'explaining';
      this.emit({ type: 'scenario:explaining', ts: Date.now() });
    }
  }

  /**
   * Actually undoes a fault, by kind (fix round 2; previously this only handled intercept
   * faults, silently no-oping for state faults). `validateClearFaults` already guaranteed
   * at activation time that `id` names a registered fault, and that a state fault named
   * here has a `revert`, so both branches are safe without re-checking.
   */
  private clearFault(c: ActiveRun, id: string): void {
    const fault = c.faultsById.get(id);
    if (!fault) return; // unreachable given activation-time validation; defensive only
    if (fault.kind === 'intercept') {
      this.activeIntercepts.delete(id);
      return;
    }
    fault.revert?.(activeWorld());
  }

  /** The CURRENT step's own match hit but an assertion failed: the case spec section 8
   *  actually describes ("shown when match hits but assertions fail"). Carries the
   *  step's `attemptHint` on the event and marks `currentStepAttemptFailed`, the one
   *  thing that lets `getState()` surface that same hint later (fix round finding 1). */
  private recordCurrentStepAttempt(step: Step, reason: string): void {
    this.recordAttempt(step, reason, step.attemptHint, true);
  }

  /**
   * Shared bookkeeping for both attempt kinds: a genuine current-step match+fail
   * (`recordCurrentStepAttempt` above) and an out-of-order match against a different step
   * (`maybeRecordOutOfOrderAttempt`, fix round finding 2). Both count toward `attempts`
   * and the 3/6/9 hint gate identically; they differ only in `attemptHint` (never present
   * on an out-of-order hit, since that request did not match the current step's own
   * matcher) and in whether `currentStepAttemptFailed` gets set.
   */
  private recordAttempt(step: Step, reason: string, attemptHint: string | undefined, marksCurrentStepFailure: boolean): void {
    const c = this.mustCurrent();
    c.attempts += 1;
    if (marksCurrentStepFailure) c.currentStepAttemptFailed = true;
    this.bumpAttempts(c.def.id);
    this.emit({
      type: 'scenario:attempt',
      ts: Date.now(),
      stepId: step.id,
      attempts: c.attempts,
      reason,
      attemptHint,
    });
    this.maybeUnlockHint(c);
  }

  private maybeUnlockHint(c: ActiveRun): void {
    const nextIndex = c.hintsUnlocked;
    const threshold = HINT_THRESHOLDS[nextIndex];
    if (threshold === undefined) return; // all defined thresholds already crossed
    if (nextIndex >= c.built.hints.length) return; // scenario has no hint at this index
    if (c.attempts >= threshold) {
      c.hintsUnlocked += 1;
      this.emit({ type: 'hint:unlocked', ts: Date.now(), index: nextIndex });
    }
  }

  private bumpRuns(id: string): void {
    this.progress.update((p) => {
      const entry = p.scenarios[id] ?? defaultScenarioProgressEntry();
      entry.runs += 1;
      p.scenarios[id] = entry;
    });
  }

  private bumpAttempts(id: string): void {
    this.progress.update((p) => {
      const entry = p.scenarios[id] ?? defaultScenarioProgressEntry();
      entry.attempts += 1;
      p.scenarios[id] = entry;
    });
  }

  private mustCurrent(): ActiveRun {
    if (!this.current) throw new EngineError(409, 'no active scenario');
    return this.current;
  }

  private emit(ev: TrainerEvent): void {
    bus.emit('trainer-event', ev);
  }
}

/** The process-wide singleton, wired with the real scenario registry and the real
 *  progress store. `server/src/index.ts` calls `engine.boot()` once at startup;
 *  `server/src/trainer/router.ts` drives everything else through this instance. */
export const engine = new Engine(scenarioRegistry);
