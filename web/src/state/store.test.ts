import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioAttemptEvent, TrainerEvent } from '@gym/shared';
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
  },
}));

const { trainerApi } = await import('../api/client.js');
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
};

const initialState = useStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState(initialState, true);
  vi.clearAllMocks();
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
});

describe('store: scenario list refresh', () => {
  it('loadScenarios stores the scenario list on success', async () => {
    const list: ScenarioListEntry[] = [{ id: 't1-wrong-method', tier: 1, track: 'troubleshoot', title: 'Wrong method', platform: 'github', solved: false, runs: 2 }];
    mocked.listScenarios.mockResolvedValue(list);

    await useStore.getState().loadScenarios();

    expect(useStore.getState().scenarios).toEqual(list);
  });
});
