import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioAttemptEvent, TrainerEvent } from '@gym/shared';
import { defaultWorkspace } from '@gym/shared';
import type { ActivatedPayload, EnginePublicState, HintResponse, ProxyResponseBody, ScenarioListEntry } from '../types.js';
import { TrainerApiError } from '../types.js';

vi.mock('../api/client.js', () => ({
  trainerApi: {
    health: vi.fn(),
    listScenarios: vi.fn(),
    activate: vi.fn(),
    activateDrill: vi.fn(),
    resetScenario: vi.fn(),
    getState: vi.fn(),
    hint: vi.fn(),
    revealSolution: vi.fn(),
    explain: vi.fn(),
    proxy: vi.fn(),
    getWorkspace: vi.fn(),
    putWorkspace: vi.fn(),
    listDocs: vi.fn(),
    getDoc: vi.fn(),
    resetProgress: vi.fn(),
  },
}));

// `runScript` (`scripts/run.ts`) spins up a real Worker from a Blob URL, neither of which
// jsdom implements; `worker.test.ts` and `run.test.ts` already cover that logic against a
// production-string harness and a mocked worker respectively. Here it is mocked at the
// module boundary so `sendRequest`'s ORCHESTRATION (pipeline order, envPatch application,
// testResults/consoleLines wiring) can be verified without touching either.
vi.mock('../scripts/run.js', () => ({
  runScript: vi.fn(),
}));

const { trainerApi } = await import('../api/client.js');
const { runScript } = await import('../scripts/run.js');
const { useStore } = await import('./store.js');

const mocked = trainerApi as unknown as {
  health: ReturnType<typeof vi.fn>;
  listScenarios: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
  activateDrill: ReturnType<typeof vi.fn>;
  resetScenario: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  hint: ReturnType<typeof vi.fn>;
  revealSolution: ReturnType<typeof vi.fn>;
  explain: ReturnType<typeof vi.fn>;
  proxy: ReturnType<typeof vi.fn>;
  getWorkspace: ReturnType<typeof vi.fn>;
  putWorkspace: ReturnType<typeof vi.fn>;
  listDocs: ReturnType<typeof vi.fn>;
  getDoc: ReturnType<typeof vi.fn>;
  resetProgress: ReturnType<typeof vi.fn>;
};

const mockedRunScript = runScript as ReturnType<typeof vi.fn>;

const initialState = useStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState(initialState, true);
  vi.clearAllMocks();
  // Sane defaults so tests that call init() without caring about the workspace/docs
  // hydration path do not have to mock every endpoint individually.
  mocked.getWorkspace.mockResolvedValue(defaultWorkspace());
  mocked.putWorkspace.mockResolvedValue({ ok: true });
  mocked.listDocs.mockResolvedValue([]);
  // Matches the real runScript's own empty-script fast path, so every existing
  // sendRequest test (none of which set a script) behaves identically whether or not
  // this module is mocked.
  mockedRunScript.mockResolvedValue({ testResults: [], envPatch: {}, consoleLines: [], error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function activatedPayload(overrides: Partial<ActivatedPayload> = {}): ActivatedPayload {
  return {
    seed: 'abc123',
    tier: 2,
    track: 'troubleshoot',
    platform: 'github',
    scenarioId: 't2-revoked-pat',
    title: 'Revoked PAT',
    ticketMd: '## Ticket\n\nSomething is broken.',
    steps: [{ id: 'step-1', title: 'Authenticate' }],
    stepCount: 1,
    drill: false,
    ...overrides,
  };
}

describe('store: SSE-driven scenario events', () => {
  it('scenario:activated (non-drill) populates the scenario slice with real step ids/titles', () => {
    const payload = activatedPayload();
    useStore.getState().handleTrainerEvent({ type: 'scenario:activated', ts: 1, ...payload });

    const scenario = useStore.getState().scenario;
    expect(scenario.state).toBe('active');
    expect(scenario.scenarioId).toBe('t2-revoked-pat');
    expect(scenario.steps).toEqual([{ id: 'step-1', title: 'Authenticate', done: false }]);
    expect(scenario.attempts).toBe(0);
    expect(scenario.currentStepIndex).toBe(0);
  });

  it('scenario:activated (drill) omits scenarioId/title and steps stay empty', () => {
    const payload = activatedPayload({ drill: true, scenarioId: undefined, title: undefined, steps: undefined, stepCount: 3 });
    useStore.getState().handleTrainerEvent({ type: 'scenario:activated', ts: 1, ...payload });

    const scenario = useStore.getState().scenario;
    expect(scenario.drill).toBe(true);
    expect(scenario.scenarioId).toBeUndefined();
    expect(scenario.steps).toEqual([]);
    expect(scenario.stepCount).toBe(3);
  });

  it('scenario:attempt bumps attempts and records the mechanical reason', () => {
    useStore.getState().handleTrainerEvent({ type: 'scenario:activated', ts: 1, ...activatedPayload() });
    useStore.getState().handleTrainerEvent({
      type: 'scenario:attempt',
      ts: 2,
      stepId: 'step-1',
      attempts: 1,
      reason: 'expected status 200, got 401',
    });

    const scenario = useStore.getState().scenario;
    expect(scenario.attempts).toBe(1);
    expect(scenario.lastAttempt).toEqual({
      stepId: 'step-1',
      attempts: 1,
      reason: 'expected status 200, got 401',
      attemptHint: undefined,
      ts: 2,
    });
  });

  it('scenario:attempt also carries the optional author attemptHint alongside reason', () => {
    // `attemptHint` is landing on ScenarioAttemptEvent in a concurrent server fix round
    // (shared/** is off limits here), so it is not yet on the imported type; build the
    // event through a widened local type the way the store's own reducer does.
    const eventWithHint = {
      type: 'scenario:attempt',
      ts: 2,
      stepId: 'step-1',
      attempts: 3,
      reason: 'expected status 200, got 403',
      attemptHint: 'Check X-OAuth-Scopes against X-Accepted-OAuth-Scopes.',
    } as ScenarioAttemptEvent & { attemptHint: string } as TrainerEvent;

    useStore.getState().handleTrainerEvent({ type: 'scenario:activated', ts: 1, ...activatedPayload() });
    useStore.getState().handleTrainerEvent(eventWithHint);

    const scenario = useStore.getState().scenario;
    expect(scenario.lastAttempt?.reason).toBe('expected status 200, got 403');
    expect(scenario.lastAttempt?.attemptHint).toBe('Check X-OAuth-Scopes against X-Accepted-OAuth-Scopes.');
    expect(scenario.attemptHint).toBe('Check X-OAuth-Scopes against X-Accepted-OAuth-Scopes.');
  });

  it('scenario:step marks the matching step done, advances the index, and clears stale attempt feedback', () => {
    useStore.getState().handleTrainerEvent({
      type: 'scenario:activated',
      ts: 1,
      ...activatedPayload({ steps: [{ id: 'step-1', title: 'A' }, { id: 'step-2', title: 'B' }], stepCount: 2 }),
    });
    useStore.getState().handleTrainerEvent({ type: 'scenario:attempt', ts: 2, stepId: 'step-1', attempts: 1, reason: 'still 401' });
    useStore.getState().handleTrainerEvent({ type: 'scenario:step', ts: 3, stepId: 'step-1', nextStepIndex: 1 });

    const scenario = useStore.getState().scenario;
    expect(scenario.currentStepIndex).toBe(1);
    expect(scenario.steps).toEqual([
      { id: 'step-1', title: 'A', done: true },
      { id: 'step-2', title: 'B', done: false },
    ]);
    expect(scenario.lastAttempt).toBeUndefined();
    expect(scenario.attemptHint).toBeUndefined();
  });

  it('scenario:explaining then scenario:solved transitions state and refreshes the scenario list', async () => {
    mocked.listScenarios.mockResolvedValue([]);
    useStore.getState().handleTrainerEvent({ type: 'scenario:activated', ts: 1, ...activatedPayload() });
    useStore.getState().handleTrainerEvent({ type: 'scenario:explaining', ts: 2 });
    expect(useStore.getState().scenario.state).toBe('explaining');

    useStore.getState().handleTrainerEvent({ type: 'scenario:solved', ts: 3 });
    expect(useStore.getState().scenario.state).toBe('solved');
    expect(useStore.getState().scenario.solutionRevealed).toBe(true);
    await vi.waitFor(() => expect(mocked.listScenarios).toHaveBeenCalledTimes(1));
  });

  it('hint:unlocked only ever moves hintsUnlocked forward', () => {
    useStore.getState().handleTrainerEvent({ type: 'scenario:activated', ts: 1, ...activatedPayload() });
    useStore.getState().handleTrainerEvent({ type: 'hint:unlocked', ts: 2, index: 1 });
    expect(useStore.getState().scenario.hintsUnlocked).toBe(2);
    useStore.getState().handleTrainerEvent({ type: 'hint:unlocked', ts: 3, index: 0 });
    expect(useStore.getState().scenario.hintsUnlocked).toBe(2); // does not regress
  });

  it('log events append newest-last and trim the oldest entry once MAX_LOGS is exceeded', () => {
    const MAX_LOGS = 1000;
    const filler = Array.from({ length: MAX_LOGS }, (_, i) => ({ id: `old-${i}` }) as unknown as import('@gym/shared').RequestEvent);
    useStore.setState({ logs: filler });

    const fresh = { id: 'new-1' } as unknown as import('@gym/shared').RequestEvent;
    useStore.getState().handleTrainerEvent({ type: 'log', event: fresh });

    const logs = useStore.getState().logs;
    expect(logs).toHaveLength(MAX_LOGS);
    expect(logs.at(-1)).toEqual(fresh);
    expect(logs[0]).toEqual({ id: 'old-1' }); // "old-0" was dropped
  });
});

describe('store: REST-driven actions', () => {
  it('activateScenario applies the activated payload and clears any stale response', async () => {
    mocked.activate.mockResolvedValue(activatedPayload({ scenarioId: 't1-wrong-method' }));
    useStore.setState({ response: { kind: 'error', message: 'stale' } });

    await useStore.getState().activateScenario('t1-wrong-method');

    expect(mocked.activate).toHaveBeenCalledWith('t1-wrong-method');
    expect(useStore.getState().scenario.scenarioId).toBe('t1-wrong-method');
    expect(useStore.getState().response).toBeNull();
  });

  it('activateScenario surfaces a failure as errorMessage instead of throwing', async () => {
    mocked.activate.mockRejectedValue(new TrainerApiError(404, { error: 'Not Found', message: 'no such scenario: bogus' }, 'no such scenario: bogus'));

    await useStore.getState().activateScenario('bogus');

    expect(useStore.getState().errorMessage).toContain('bogus');
  });

  it('requestHint appends a new hint and does not duplicate an already-held index', async () => {
    const hint: HintResponse = { index: 0, text: 'Check the Authorization header value.' };
    mocked.hint.mockResolvedValue(hint);

    await useStore.getState().requestHint();
    await useStore.getState().requestHint();

    expect(useStore.getState().scenario.hints).toEqual([hint]);
    expect(useStore.getState().scenario.hintsRevealed).toBe(1);
  });

  it('requestHint on a 409 sets errorMessage without touching existing hints', async () => {
    mocked.hint.mockRejectedValue(new TrainerApiError(409, { error: 'EngineError', message: 'no hint unlocked yet' }, 'no hint unlocked yet'));

    await useStore.getState().requestHint();

    expect(useStore.getState().errorMessage).toBe('no hint unlocked yet');
    expect(useStore.getState().scenario.hints).toEqual([]);
  });

  it('explain resolves true and marks the scenario solved with solutionMd', async () => {
    mocked.explain.mockResolvedValue({ solutionMd: '## Root cause\n\nWrong token.' });

    const ok = await useStore.getState().explain('The token was revoked.', 'Please use the second token.');

    expect(ok).toBe(true);
    expect(mocked.explain).toHaveBeenCalledWith('The token was revoked.', 'Please use the second token.');
    expect(useStore.getState().scenario.state).toBe('solved');
    expect(useStore.getState().scenario.solutionMd).toContain('Wrong token');
  });

  it('explain resolves false and sets errorMessage on failure', async () => {
    mocked.explain.mockRejectedValue(new TrainerApiError(400, { error: 'Bad Request', message: 'rootCause and customerReply are both required' }, 'rootCause and customerReply are both required'));

    const ok = await useStore.getState().explain('', '');

    expect(ok).toBe(false);
    expect(useStore.getState().errorMessage).toContain('required');
  });

  it('resetScenario calls the reset endpoint then rehydrates from getState', async () => {
    mocked.resetScenario.mockResolvedValue({ ok: true });
    const state: EnginePublicState = { state: 'active', scenarioId: 't1-pagination', attempts: 0, stepCount: 1, steps: [{ id: 's1', title: 'Page', done: false }] };
    mocked.getState.mockResolvedValue(state);

    await useStore.getState().resetScenario();

    expect(mocked.resetScenario).toHaveBeenCalledOnce();
    expect(useStore.getState().scenario.scenarioId).toBe('t1-pagination');
  });

  it('hydrates a reload-recovered attemptHint from GET /api/state even without a paired reason', async () => {
    mocked.resetScenario.mockResolvedValue({ ok: true });
    const state: EnginePublicState = {
      state: 'active',
      scenarioId: 't2-missing-scope',
      attempts: 4,
      stepCount: 1,
      steps: [{ id: 's1', title: 'Fix scope', done: false }],
      attemptHint: 'Compare X-OAuth-Scopes to X-Accepted-OAuth-Scopes on the failing response.',
    };
    mocked.getState.mockResolvedValue(state);

    await useStore.getState().resetScenario();

    expect(useStore.getState().scenario.attemptHint).toBe(
      'Compare X-OAuth-Scopes to X-Accepted-OAuth-Scopes on the failing response.',
    );
    expect(useStore.getState().scenario.lastAttempt).toBeUndefined(); // no reason available from state alone
  });

  /** `ResetProgressControl.tsx`'s store action (fix round, item 1). */
  it('resetAllProgress calls the confirm-token DELETE, refreshes scenarios, and resolves true', async () => {
    mocked.resetProgress.mockResolvedValue({ ok: true });
    mocked.listScenarios.mockResolvedValue([{ id: 't1-wrong-method', tier: 1, track: 'troubleshoot', title: 'Wrong method', platform: 'github', solved: false, runs: 0 }]);

    const ok = await useStore.getState().resetAllProgress();

    expect(ok).toBe(true);
    expect(mocked.resetProgress).toHaveBeenCalledOnce();
    expect(mocked.listScenarios).toHaveBeenCalledOnce();
    expect(useStore.getState().scenarios).toEqual([{ id: 't1-wrong-method', tier: 1, track: 'troubleshoot', title: 'Wrong method', platform: 'github', solved: false, runs: 0 }]);
    expect(useStore.getState().errorMessage).toBeNull();
  });

  it('resetAllProgress resolves false and sets errorMessage on failure, without touching scenarios', async () => {
    mocked.resetProgress.mockRejectedValue(new TrainerApiError(400, { error: 'Bad Request', message: 'nothing was changed' }, 'nothing was changed'));
    useStore.setState({ scenarios: [] });

    const ok = await useStore.getState().resetAllProgress();

    expect(ok).toBe(false);
    expect(mocked.listScenarios).not.toHaveBeenCalled();
    expect(useStore.getState().errorMessage).toContain('nothing was changed');
  });
});

describe('store: request builder and proxy send', () => {
  it('sendRequest only forwards enabled, non-empty headers and reports the response', async () => {
    const proxyResponse: ProxyResponseBody = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', timeMs: 12.5, sizeBytes: 11 };
    mocked.proxy.mockResolvedValue(proxyResponse);

    useStore.setState((s) => ({
      request: {
        ...s.request,
        url: 'http://127.0.0.1:4600/github/user',
        headers: [
          { id: '1', key: 'Authorization', value: 'token abc', enabled: true },
          { id: '2', key: 'X-Disabled', value: 'nope', enabled: false },
          { id: '3', key: '', value: 'ignored-empty-key', enabled: true },
        ],
      },
    }));

    await useStore.getState().sendRequest();

    expect(mocked.proxy).toHaveBeenCalledWith({
      method: 'GET',
      url: 'http://127.0.0.1:4600/github/user',
      headers: { Authorization: 'token abc' },
      body: undefined,
    });
    expect(useStore.getState().response).toEqual({ kind: 'success', ...proxyResponse });
    expect(useStore.getState().sending).toBe(false);
  });

  it('sendRequest refuses to fire with an empty URL', async () => {
    useStore.setState((s) => ({ request: { ...s.request, url: '' } }));

    await useStore.getState().sendRequest();

    expect(mocked.proxy).not.toHaveBeenCalled();
    expect(useStore.getState().errorMessage).toMatch(/URL/i);
  });

  it('sendRequest surfaces a proxy error as an error-kind response', async () => {
    mocked.proxy.mockRejectedValue(new TrainerApiError(400, { error: 'Bad Request', message: 'blocked' }, 'blocked'));
    useStore.setState((s) => ({ request: { ...s.request, url: 'http://evil.example/x' } }));

    await useStore.getState().sendRequest();

    expect(useStore.getState().response).toEqual({ kind: 'error', message: 'blocked' });
  });

  it('addHeaderRow/updateHeaderRow/removeHeaderRow mutate the draft immutably', () => {
    const before = useStore.getState().request.headers.length;
    useStore.getState().addHeaderRow();
    expect(useStore.getState().request.headers).toHaveLength(before + 1);

    const row = useStore.getState().request.headers[0];
    expect(row).toBeDefined();
    if (!row) throw new Error('unreachable');
    useStore.getState().updateHeaderRow(row.id, { key: 'Accept', value: 'application/json' });
    expect(useStore.getState().request.headers[0]).toMatchObject({ key: 'Accept', value: 'application/json' });

    useStore.getState().removeHeaderRow(row.id);
    expect(useStore.getState().request.headers.find((h) => h.id === row.id)).toBeUndefined();
  });
});

describe('store: ui slice + persistence', () => {
  it('setDemoMode persists to localStorage and toggleDemoMode flips it', () => {
    useStore.getState().setDemoMode(true);
    expect(useStore.getState().ui.demoMode).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('postman-gym:ui') ?? '{}')).toMatchObject({ demoMode: true });

    useStore.getState().toggleDemoMode();
    expect(useStore.getState().ui.demoMode).toBe(false);
  });

  it('setDividerPct clamps to the 30..80 range', () => {
    useStore.getState().setDividerPct(5);
    expect(useStore.getState().ui.dividerPct).toBe(30);
    useStore.getState().setDividerPct(95);
    expect(useStore.getState().ui.dividerPct).toBe(80);
    useStore.getState().setDividerPct(55);
    expect(useStore.getState().ui.dividerPct).toBe(55);
  });

  it('setReferenceTab and setResponseViewMode update independently', () => {
    useStore.getState().setReferenceTab('logs');
    expect(useStore.getState().ui.activeReferenceTab).toBe('logs');
    useStore.getState().setResponseViewMode('headers');
    expect(useStore.getState().ui.responseViewMode).toBe('headers');
  });
});

describe('store: stale-response race guard', () => {
  it('a slow init() hydration cannot clobber a faster activateScenario() issued after it started', async () => {
    // Regression test for a real race this task's own end-to-end verification caught
    // live: the server's engine is a long-lived singleton that outlives one page load, so
    // init()'s GET /api/state can still be in flight when the learner immediately clicks
    // a different scenario. If that slower hydration resolved last, it used to silently
    // overwrite the freshly activated ticket with stale data from before the click.
    let resolveGetState: (value: EnginePublicState) => void = () => {};
    const pendingGetState = new Promise<EnginePublicState>((resolve) => {
      resolveGetState = resolve;
    });
    mocked.health.mockResolvedValue({ ok: true, version: '0.0.0', port: 4600 });
    mocked.getState.mockReturnValue(pendingGetState);
    mocked.listScenarios.mockResolvedValue([]);
    mocked.activate.mockResolvedValue(activatedPayload({ scenarioId: 't1-wrong-method' }));

    const initPromise = useStore.getState().init();
    // Flush pending microtasks so init() progresses past health() and issues its
    // getState() call (which then legitimately blocks on our manually-controlled promise).
    await new Promise((resolve) => setTimeout(resolve, 0));

    await useStore.getState().activateScenario('t1-wrong-method');
    expect(useStore.getState().scenario.scenarioId).toBe('t1-wrong-method');
    expect(useStore.getState().scenario.state).toBe('active');

    // Now let the slow, now-stale getState() resolve with data that would have reset the
    // scenario to idle. It must be discarded, not applied.
    resolveGetState({ state: 'idle' });
    await initPromise;

    expect(useStore.getState().scenario.scenarioId).toBe('t1-wrong-method');
    expect(useStore.getState().scenario.state).toBe('active');
  });

  it('a Drill click during init()\'s health() round trip still beats init()\'s later getState()', async () => {
    // Fix round: the epoch used to be claimed only right before getState(), after already
    // awaiting health(). That left a window: a click landing during the health() round
    // trip took an epoch NEWER than the one init() had not claimed yet, but init()'s own
    // later getState() call would still claim a newer epoch than that click's, once init()
    // finally got around to bumping it, so init() won anyway. The epoch is now claimed as
    // init()'s very first synchronous step, before any await, closing that window.
    let resolveHealth: (value: { ok: true; version: string; port: number }) => void = () => {};
    const pendingHealth = new Promise<{ ok: true; version: string; port: number }>((resolve) => {
      resolveHealth = resolve;
    });
    mocked.health.mockReturnValue(pendingHealth);
    mocked.getState.mockResolvedValue({ state: 'idle' });
    mocked.listScenarios.mockResolvedValue([]);
    mocked.activateDrill.mockResolvedValue(activatedPayload({ scenarioId: 't2-missing-scope', drill: true }));

    const initPromise = useStore.getState().init();
    // init() is now blocked on health(); a Drill click starts and finishes here, entirely
    // inside that window.
    await useStore.getState().activateDrill(2);
    expect(useStore.getState().scenario.scenarioId).toBe('t2-missing-scope');

    resolveHealth({ ok: true, version: '0.0.0', port: 4600 });
    await initPromise;

    // init()'s getState() (state: 'idle') must have been discarded, not applied on top.
    expect(useStore.getState().scenario.scenarioId).toBe('t2-missing-scope');
    expect(useStore.getState().scenario.state).toBe('active');
  });

  it('a scenario:activated push over SSE beats a slower, now-stale in-flight fetch', async () => {
    // The push could be this client's own activate() landing over SSE, or (Demo mode's
    // whole point) a curl / real-Postman / another-tab activation. Either way, once the
    // server has pushed authoritative state, an older fetch that only resolves afterward
    // must not be allowed to overwrite it.
    let resolveGetState: (value: EnginePublicState) => void = () => {};
    const pendingGetState = new Promise<EnginePublicState>((resolve) => {
      resolveGetState = resolve;
    });
    mocked.health.mockResolvedValue({ ok: true, version: '0.0.0', port: 4600 });
    mocked.getState.mockReturnValue(pendingGetState);
    mocked.listScenarios.mockResolvedValue([]);

    const initPromise = useStore.getState().init();
    await new Promise((resolve) => setTimeout(resolve, 0)); // let init() reach its getState() call

    useStore.getState().handleTrainerEvent({
      type: 'scenario:activated',
      ts: 1,
      ...activatedPayload({ scenarioId: 't5-hmac-signature' }),
    });
    expect(useStore.getState().scenario.scenarioId).toBe('t5-hmac-signature');

    // The stale getState() (captured before the SSE push) resolves last and must lose.
    resolveGetState({ state: 'idle' });
    await initPromise;

    expect(useStore.getState().scenario.scenarioId).toBe('t5-hmac-signature');
    expect(useStore.getState().scenario.state).toBe('active');
  });
});

describe('store: init() idempotency', () => {
  it('a second concurrent init() call (React StrictMode\'s double-invoke) issues no extra requests', async () => {
    mocked.health.mockResolvedValue({ ok: true, version: '0.0.0', port: 4600 });
    mocked.getState.mockResolvedValue({ state: 'idle' });
    mocked.listScenarios.mockResolvedValue([]);

    await Promise.all([useStore.getState().init(), useStore.getState().init()]);

    expect(mocked.health).toHaveBeenCalledTimes(1);
    expect(mocked.getState).toHaveBeenCalledTimes(1);
    expect(mocked.listScenarios).toHaveBeenCalledTimes(1);
  });

  it('a second sequential init() call after the first has already finished is also a no-op', async () => {
    mocked.health.mockResolvedValue({ ok: true, version: '0.0.0', port: 4600 });
    mocked.getState.mockResolvedValue({ state: 'idle' });
    mocked.listScenarios.mockResolvedValue([]);

    await useStore.getState().init();
    await useStore.getState().init();

    expect(mocked.health).toHaveBeenCalledTimes(1);
  });
});

describe('store: scenario list refresh', () => {
  it('loadScenarios stores the scenario list on success', async () => {
    const list: ScenarioListEntry[] = [{ id: 't1-wrong-method', tier: 1, track: 'troubleshoot', title: 'Wrong method', platform: 'github', solved: false, runs: 2 }];
    mocked.listScenarios.mockResolvedValue(list);

    await useStore.getState().loadScenarios();

    expect(useStore.getState().scenarios).toEqual(list);
  });
});

describe('store: {{var}} resolution on send', () => {
  it('refuses to send and reports the specific undefined variable, never the literal token', async () => {
    useStore.setState((s) => ({ request: { ...s.request, url: '{{baseUrl}}/user' } }));

    await useStore.getState().sendRequest();

    expect(mocked.proxy).not.toHaveBeenCalled();
    expect(useStore.getState().errorMessage).toContain('{{baseUrl}}');
  });

  it('resolves {{var}} from the active environment and sends the real value', async () => {
    const proxyResponse: ProxyResponseBody = { status: 200, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 };
    mocked.proxy.mockResolvedValue(proxyResponse);
    useStore.setState({
      environments: [{ id: 'e1', name: 'Local', variables: [{ id: 'v1', key: 'baseUrl', value: 'http://127.0.0.1:4600/github', enabled: true }] }],
      activeEnvironmentId: 'e1',
    });
    useStore.setState((s) => ({ request: { ...s.request, url: '{{baseUrl}}/user' } }));

    await useStore.getState().sendRequest();

    expect(mocked.proxy).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://127.0.0.1:4600/github/user' }));
    expect(useStore.getState().errorMessage).toBeNull();
  });

  it('a disabled environment variable does not resolve: sending is still refused', async () => {
    useStore.setState({
      environments: [{ id: 'e1', name: 'Local', variables: [{ id: 'v1', key: 'baseUrl', value: 'http://x', enabled: false }] }],
      activeEnvironmentId: 'e1',
    });
    useStore.setState((s) => ({ request: { ...s.request, url: '{{baseUrl}}/user' } }));

    await useStore.getState().sendRequest();

    expect(mocked.proxy).not.toHaveBeenCalled();
  });

  it('injects the Auth tab Bearer token as a real Authorization header', async () => {
    const proxyResponse: ProxyResponseBody = { status: 200, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 };
    mocked.proxy.mockResolvedValue(proxyResponse);
    useStore.setState((s) => ({
      request: { ...s.request, url: 'http://x/y', auth: { ...s.request.auth, type: 'bearer', bearer: { token: 'abc123' } } },
    }));

    await useStore.getState().sendRequest();

    expect(mocked.proxy).toHaveBeenCalledWith(expect.objectContaining({ headers: { Authorization: 'Bearer abc123' } }));
  });
});

describe('store: script engine pipeline (docs/SPEC.md section 14)', () => {
  it('runs neither script when both are empty (the default draft)', async () => {
    mocked.proxy.mockResolvedValue({ status: 200, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 });
    useStore.setState((s) => ({ request: { ...s.request, url: 'http://x/y' } }));

    await useStore.getState().sendRequest();

    expect(mockedRunScript).not.toHaveBeenCalled();
    expect(useStore.getState().testResults).toEqual([]);
    expect(useStore.getState().consoleLines).toEqual([]);
  });

  it('applies the pre-request script envPatch to the active environment BEFORE resolving {{vars}}, so the sent request carries the computed value', async () => {
    mocked.proxy.mockResolvedValue({ status: 200, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 });
    useStore.setState({
      environments: [{ id: 'e1', name: 'Local', variables: [{ id: 'v1', key: 'baseUrl', value: 'http://x', enabled: true }] }],
      activeEnvironmentId: 'e1',
    });
    useStore.setState((s) => ({
      request: {
        ...s.request,
        url: '{{baseUrl}}/y',
        headers: [{ id: 'h1', key: 'X-Sig', value: '{{sig}}', enabled: true }],
        scripts: { ...s.request.scripts, preRequest: 'pm.environment.set("sig", "computed-signature");' },
      },
    }));
    mockedRunScript.mockResolvedValueOnce({ testResults: [], envPatch: { sig: 'computed-signature' }, consoleLines: [], error: null });

    await useStore.getState().sendRequest();

    // The literal {{sig}} never reaches the proxy call: the pre-request script's write
    // landed in the environment before {{vars}} resolution ran.
    expect(mocked.proxy).toHaveBeenCalledWith(expect.objectContaining({ headers: { 'X-Sig': 'computed-signature' } }));
    // And it is durably visible in the environment afterward, not a one-request overlay.
    expect(useStore.getState().environments[0]?.variables).toContainEqual(expect.objectContaining({ key: 'sig', value: 'computed-signature', enabled: true }));
  });

  it('with no active environment, envPatch is applied only for this one send (no environment to persist into)', async () => {
    mocked.proxy.mockResolvedValue({ status: 200, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 });
    useStore.setState((s) => ({
      request: {
        ...s.request,
        url: 'http://x/y',
        headers: [{ id: 'h1', key: 'X-Sig', value: '{{sig}}', enabled: true }],
        scripts: { ...s.request.scripts, preRequest: 'pm.environment.set("sig", "ephemeral");' },
      },
    }));
    mockedRunScript.mockResolvedValueOnce({ testResults: [], envPatch: { sig: 'ephemeral' }, consoleLines: [], error: null });

    await useStore.getState().sendRequest();

    expect(mocked.proxy).toHaveBeenCalledWith(expect.objectContaining({ headers: { 'X-Sig': 'ephemeral' } }));
    expect(useStore.getState().environments).toEqual([]);
  });

  it('runs the tests script after the response arrives, with the real status/body/headers, and records pass/fail rows', async () => {
    const proxyResponse: ProxyResponseBody = { status: 200, headers: { 'x-test': 'yes' }, body: '{"ok":true}', timeMs: 5, sizeBytes: 12 };
    mocked.proxy.mockResolvedValue(proxyResponse);
    useStore.setState((s) => ({
      request: { ...s.request, url: 'http://x/y', scripts: { ...s.request.scripts, test: 'pm.test("status is 200", () => pm.response.to.have.status(200));' } },
    }));
    mockedRunScript.mockResolvedValueOnce({
      testResults: [{ name: 'status is 200', passed: true }],
      envPatch: {},
      consoleLines: ['checked status'],
      error: null,
    });

    await useStore.getState().sendRequest();

    expect(mockedRunScript).toHaveBeenCalledWith(
      'pm.test("status is 200", () => pm.response.to.have.status(200));',
      expect.objectContaining({ response: expect.objectContaining({ status: 200, statusText: 'OK', body: '{"ok":true}' }) }),
    );
    expect(useStore.getState().testResults).toEqual([{ name: 'status is 200', passed: true }]);
    expect(useStore.getState().consoleLines).toEqual(['checked status']);
  });

  it('a failing test row does not surface as an errorMessage banner and does not break the response', async () => {
    mocked.proxy.mockResolvedValue({ status: 500, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 });
    useStore.setState((s) => ({
      request: { ...s.request, url: 'http://x/y', scripts: { ...s.request.scripts, test: 'pm.test("status is 200", () => pm.response.to.have.status(200));' } },
    }));
    mockedRunScript.mockResolvedValueOnce({
      testResults: [{ name: 'status is 200', passed: false, error: 'expected response to have status 200 but got 500' }],
      envPatch: {},
      consoleLines: [],
      error: null,
    });

    await useStore.getState().sendRequest();

    expect(useStore.getState().testResults).toEqual([{ name: 'status is 200', passed: false, error: 'expected response to have status 200 but got 500' }]);
    expect(useStore.getState().response).toEqual({ kind: 'success', status: 500, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 });
    expect(useStore.getState().errorMessage).toBeNull();
  });

  it('a script-level failure (timeout, syntax error) shows up as its own named row in testResults', async () => {
    mocked.proxy.mockResolvedValue({ status: 200, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 });
    useStore.setState((s) => ({
      request: { ...s.request, url: 'http://x/y', scripts: { ...s.request.scripts, test: 'while(true){}' } },
    }));
    mockedRunScript.mockResolvedValueOnce({ testResults: [], envPatch: {}, consoleLines: [], error: 'Script timed out after 2000ms (an infinite loop is the usual cause).' });

    await useStore.getState().sendRequest();

    expect(useStore.getState().testResults).toEqual([{ name: 'Tests script', passed: false, error: 'Script timed out after 2000ms (an infinite loop is the usual cause).' }]);
  });

  it('resets testResults/consoleLines at the start of every sendRequest, so a stale run never lingers', async () => {
    useStore.setState({ testResults: [{ name: 'stale', passed: true }], consoleLines: ['stale line'] });
    mocked.proxy.mockResolvedValue({ status: 200, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 });
    useStore.setState((s) => ({ request: { ...s.request, url: 'http://x/y' } }));

    await useStore.getState().sendRequest();

    expect(useStore.getState().testResults).toEqual([]);
    expect(useStore.getState().consoleLines).toEqual([]);
  });

  /** Fix round (coordinator review, finding 6 / constraint 7b): a `pm.test(...)` call
   *  inside a Pre-request script used to run for real and have its result thrown away;
   *  only `preResult.error` was ever read. Now wired into `testResults` the same as a
   *  Tests-script row. */
  it('pm.test rows from the Pre-request script are wired into testResults, not silently dropped', async () => {
    mocked.proxy.mockResolvedValue({ status: 200, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 });
    useStore.setState((s) => ({
      request: { ...s.request, url: 'http://x/y', scripts: { ...s.request.scripts, preRequest: 'pm.test("pre-check", () => {});' } },
    }));
    mockedRunScript.mockResolvedValueOnce({ testResults: [{ name: 'pre-check', passed: true }], envPatch: {}, consoleLines: [], error: null });

    await useStore.getState().sendRequest();

    expect(useStore.getState().testResults).toEqual([{ name: 'pre-check', passed: true }]);
  });
});

/**
 * Fix round (coordinator review, finding 5): `CodeExportModal` used to call
 * `buildResolvedRequest` directly, skipping the Pre-request script entirely, so a script
 * setting `{{sig}}` made Send succeed while the export either refused with "Undefined
 * variable" or showed a stale value. `resolveRequestForExport` routes through the exact
 * same `runPreRequestScript` helper `sendRequest` uses, which these tests verify directly
 * against the store (the component-level behavior is `CodeExportModal`'s own concern).
 */
describe('store: resolveRequestForExport (finding 5, coordinator review)', () => {
  it('runs the Pre-request script, applies its envPatch, and resolves {{vars}} against the result', async () => {
    useStore.setState({ environments: [{ id: 'e1', name: 'Local', variables: [] }], activeEnvironmentId: 'e1' });
    useStore.setState((s) => ({
      request: {
        ...s.request,
        url: 'http://x/y',
        headers: [{ id: 'h1', key: 'X-Sig', value: '{{sig}}', enabled: true }],
        scripts: { ...s.request.scripts, preRequest: 'pm.environment.set("sig", "computed");' },
      },
    }));
    mockedRunScript.mockResolvedValueOnce({ testResults: [], envPatch: { sig: 'computed' }, consoleLines: [], error: null });

    const { resolved, scriptError } = await useStore.getState().resolveRequestForExport();

    expect(resolved.headers).toEqual({ 'X-Sig': 'computed' });
    expect(resolved.missing).toEqual([]);
    expect(scriptError).toBeNull();
    // Durably visible afterward, exactly like Send leaves it (same helper, same side effect).
    expect(useStore.getState().environments[0]?.variables).toContainEqual(expect.objectContaining({ key: 'sig', value: 'computed' }));
  });

  it('surfaces a Pre-request script error as scriptError, without throwing', async () => {
    useStore.setState((s) => ({
      request: { ...s.request, url: 'http://x/y', scripts: { ...s.request.scripts, preRequest: 'bad script (((' } },
    }));
    mockedRunScript.mockResolvedValueOnce({ testResults: [], envPatch: {}, consoleLines: [], error: 'SyntaxError: boom' });

    const { scriptError } = await useStore.getState().resolveRequestForExport();

    expect(scriptError).toBe('SyntaxError: boom');
  });

  it('does not run any script when the request has no Pre-request script', async () => {
    useStore.setState((s) => ({ request: { ...s.request, url: 'http://x/y' } }));

    const { resolved } = await useStore.getState().resolveRequestForExport();

    expect(mockedRunScript).not.toHaveBeenCalled();
    expect(resolved.url).toBe('http://x/y');
  });

  it('resolves the SAME header value Send actually sent, from the same Pre-request script: no divergence', async () => {
    mocked.proxy.mockResolvedValue({ status: 200, headers: {}, body: '{}', timeMs: 1, sizeBytes: 2 });
    useStore.setState((s) => ({
      request: {
        ...s.request,
        url: 'http://x/y',
        headers: [{ id: 'h1', key: 'X-Sig', value: '{{sig}}', enabled: true }],
        scripts: { ...s.request.scripts, preRequest: 'pm.environment.set("sig", "same-value");' },
      },
    }));
    mockedRunScript.mockResolvedValue({ testResults: [], envPatch: { sig: 'same-value' }, consoleLines: [], error: null });

    await useStore.getState().sendRequest();
    const sentCall = mocked.proxy.mock.calls[0]?.[0] as { headers: Record<string, string> } | undefined;

    const exportResult = await useStore.getState().resolveRequestForExport();

    expect(exportResult.resolved.headers).toEqual(sentCall?.headers);
    expect(exportResult.resolved.headers).toEqual({ 'X-Sig': 'same-value' });
  });
});

describe('store: collections', () => {
  it('createCollection adds an empty collection', () => {
    useStore.getState().createCollection('GitHub');
    expect(useStore.getState().collections).toHaveLength(1);
    expect(useStore.getState().collections[0]).toMatchObject({ name: 'GitHub', items: [] });
  });

  it('createRequestItem then loadRequestFromCollection loads it into the builder and links the draft', () => {
    useStore.getState().createCollection('GitHub');
    const collection = useStore.getState().collections[0];
    if (!collection) throw new Error('unreachable');
    useStore.getState().createRequestItem(collection.id, null, 'Get user');
    const item = useStore.getState().collections[0]?.items[0];
    if (!item) throw new Error('unreachable');

    useStore.getState().loadRequestFromCollection(collection.id, item.id);

    expect(useStore.getState().request.name).toBe('Get user');
    expect(useStore.getState().draftLinkedTo).toEqual({ collectionId: collection.id, itemId: item.id });
  });

  it('saveCurrentRequest with no target updates the already-linked request in place', () => {
    useStore.getState().createCollection('GitHub');
    const collection = useStore.getState().collections[0];
    if (!collection) throw new Error('unreachable');
    useStore.getState().createRequestItem(collection.id, null, 'Get user');
    const item = useStore.getState().collections[0]?.items[0];
    if (!item) throw new Error('unreachable');
    useStore.getState().loadRequestFromCollection(collection.id, item.id);

    useStore.getState().setUrl('http://x/user');
    useStore.getState().saveCurrentRequest();

    const saved = useStore.getState().collections[0]?.items[0];
    if (!saved || saved.kind !== 'request') throw new Error('unreachable');
    expect(saved.request.url).toBe('http://x/user');
  });

  it('saveCurrentRequest with an explicit target creates a new item and links the draft to it', () => {
    useStore.getState().createCollection('GitHub');
    const collection = useStore.getState().collections[0];
    if (!collection) throw new Error('unreachable');

    useStore.getState().saveCurrentRequest({ collectionId: collection.id, parentFolderId: null, name: 'New save' });

    expect(useStore.getState().collections[0]?.items).toHaveLength(1);
    expect(useStore.getState().request.name).toBe('New save');
    expect(useStore.getState().draftLinkedTo?.collectionId).toBe(collection.id);
  });

  it('deleteCollectionItem clears draftLinkedTo when the deleted item was the linked one', () => {
    useStore.getState().createCollection('GitHub');
    const collection = useStore.getState().collections[0];
    if (!collection) throw new Error('unreachable');
    useStore.getState().createRequestItem(collection.id, null, 'Get user');
    const item = useStore.getState().collections[0]?.items[0];
    if (!item) throw new Error('unreachable');
    useStore.getState().loadRequestFromCollection(collection.id, item.id);

    useStore.getState().deleteCollectionItem(collection.id, item.id);

    expect(useStore.getState().draftLinkedTo).toBeNull();
  });

  it('createFolder then createRequestItem nests the request inside that folder, not the collection root', () => {
    useStore.getState().createCollection('GitHub');
    const collection = useStore.getState().collections[0];
    if (!collection) throw new Error('unreachable');
    useStore.getState().createFolder(collection.id, null, 'Auth');
    const folder = useStore.getState().collections[0]?.items[0];
    if (!folder || folder.kind !== 'folder') throw new Error('unreachable');

    useStore.getState().createRequestItem(collection.id, folder.id, 'Token exchange');

    const updatedFolder = useStore.getState().collections[0]?.items[0];
    expect(updatedFolder?.kind === 'folder' ? updatedFolder.items : []).toHaveLength(1);
    expect(useStore.getState().collections[0]?.items).toHaveLength(1); // still just the folder at root
  });
});

describe('store: environments', () => {
  it('createEnvironment adds one and, if none was active, makes it active', () => {
    useStore.getState().createEnvironment('Local');
    const env = useStore.getState().environments[0];
    expect(env?.name).toBe('Local');
    expect(useStore.getState().activeEnvironmentId).toBe(env?.id);
  });

  it('addEnvVariable/updateEnvVariable/removeEnvVariable mutate the right environment only', () => {
    useStore.getState().createEnvironment('Local');
    useStore.getState().createEnvironment('Prod');
    const [local, prod] = useStore.getState().environments;
    if (!local || !prod) throw new Error('unreachable');

    useStore.getState().addEnvVariable(local.id);
    const varRow = useStore.getState().environments.find((e) => e.id === local.id)?.variables[0];
    if (!varRow) throw new Error('unreachable');
    useStore.getState().updateEnvVariable(local.id, varRow.id, { key: 'baseUrl', value: 'http://127.0.0.1:4600' });

    expect(useStore.getState().environments.find((e) => e.id === local.id)?.variables).toEqual([
      { id: varRow.id, key: 'baseUrl', value: 'http://127.0.0.1:4600', enabled: true },
    ]);
    expect(useStore.getState().environments.find((e) => e.id === prod.id)?.variables).toEqual([]);

    useStore.getState().removeEnvVariable(local.id, varRow.id);
    expect(useStore.getState().environments.find((e) => e.id === local.id)?.variables).toEqual([]);
  });

  it('deleteEnvironment clears activeEnvironmentId only if the deleted one was active', () => {
    useStore.getState().createEnvironment('Local');
    const env = useStore.getState().environments[0];
    if (!env) throw new Error('unreachable');

    useStore.getState().deleteEnvironment(env.id);

    expect(useStore.getState().environments).toEqual([]);
    expect(useStore.getState().activeEnvironmentId).toBeNull();
  });
});

describe('store: docs', () => {
  it('loadDocs populates the doc list', async () => {
    mocked.listDocs.mockResolvedValue([{ id: 'github', title: 'GitHub REST API', platform: 'github' }]);

    await useStore.getState().loadDocs();

    expect(useStore.getState().docs).toEqual([{ id: 'github', title: 'GitHub REST API', platform: 'github' }]);
  });

  it('selectDoc fetches the doc detail and a stale, slower response cannot clobber a faster later pick', async () => {
    let resolveSlow: (v: { id: string; title: string; md: string }) => void = () => {};
    const slow = new Promise<{ id: string; title: string; md: string }>((resolve) => {
      resolveSlow = resolve;
    });
    mocked.getDoc.mockImplementation((id: string) => (id === 'slow' ? slow : Promise.resolve({ id, title: id, md: `# ${id}` })));

    const slowPromise = useStore.getState().selectDoc('slow');
    await useStore.getState().selectDoc('fast');
    expect(useStore.getState().activeDoc?.id).toBe('fast');

    resolveSlow({ id: 'slow', title: 'slow', md: '# slow' });
    await slowPromise;

    expect(useStore.getState().activeDoc?.id).toBe('fast');
  });
});

describe('store: workspace persistence (GET/PUT /_trainer/api/workspace)', () => {
  it('init() hydrates collections/environments/notes/draft from the server', async () => {
    mocked.health.mockResolvedValue({ ok: true, version: '0.0.0', port: 4600 });
    mocked.getState.mockResolvedValue({ state: 'idle' });
    const ws = defaultWorkspace();
    ws.notes = 'hello from disk';
    ws.environments = [{ id: 'e1', name: 'Local', variables: [{ id: 'v1', key: 'baseUrl', value: 'http://x', enabled: true }] }];
    ws.activeEnvironmentId = 'e1';
    mocked.getWorkspace.mockResolvedValue(ws);

    await useStore.getState().init();

    expect(useStore.getState().notes).toBe('hello from disk');
    expect(useStore.getState().environments).toEqual(ws.environments);
    expect(useStore.getState().activeEnvironmentId).toBe('e1');
    expect(useStore.getState().workspaceLoaded).toBe(true);
  });

  it('never saves before the workspace has loaded once, so it can never overwrite the server with default state', () => {
    useStore.getState().setNotes('too early');
    expect(mocked.putWorkspace).not.toHaveBeenCalled();
  });

  it('a mutating action schedules a debounced PUT once the workspace has loaded', async () => {
    vi.useFakeTimers();
    try {
      mocked.health.mockResolvedValue({ ok: true, version: '0.0.0', port: 4600 });
      mocked.getState.mockResolvedValue({ state: 'idle' });
      mocked.getWorkspace.mockResolvedValue(defaultWorkspace());

      await useStore.getState().init();
      useStore.getState().setNotes('scratch notes');
      expect(mocked.putWorkspace).not.toHaveBeenCalled(); // debounced, not immediate

      await vi.advanceTimersByTimeAsync(500);

      expect(mocked.putWorkspace).toHaveBeenCalledTimes(1);
      expect(mocked.putWorkspace.mock.calls[0]?.[0]).toMatchObject({ notes: 'scratch notes' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fast burst of edits coalesces into a single PUT, not one per keystroke', async () => {
    vi.useFakeTimers();
    try {
      mocked.health.mockResolvedValue({ ok: true, version: '0.0.0', port: 4600 });
      mocked.getState.mockResolvedValue({ state: 'idle' });
      mocked.getWorkspace.mockResolvedValue(defaultWorkspace());
      await useStore.getState().init();

      useStore.getState().setUrl('h');
      useStore.getState().setUrl('ht');
      useStore.getState().setUrl('htt');
      useStore.getState().setUrl('http://x');

      await vi.advanceTimersByTimeAsync(500);

      expect(mocked.putWorkspace).toHaveBeenCalledTimes(1);
      expect(mocked.putWorkspace.mock.calls[0]?.[0]).toMatchObject({ draft: expect.objectContaining({ url: 'http://x' }) });
    } finally {
      vi.useRealTimers();
    }
  });
});
