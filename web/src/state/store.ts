import { create } from 'zustand';
import type { RequestEvent, ScenarioAttemptEvent, TrainerEvent } from '@gym/shared';
import { trainerApi } from '../api/client.js';
import type { SSEConnectionStatus } from '../api/sse.js';
import { loadPersistedUi, savePersistedUi } from './persistence.js';
import { TrainerApiError } from '../types.js';
import type {
  ActivatedPayload,
  EnginePublicState,
  HintResponse,
  Platform,
  ScenarioListEntry,
  Tier,
  Track,
} from '../types.js';

/**
 * The app's single Zustand store: workspace UI state, the current request draft and its
 * response, scenario/engine state, and the live request log. `api/sse.ts`'s single
 * `EventSource` drives everything under `scenario` and `logs` through `handleTrainerEvent`
 * below; REST calls (`activateScenario`, `sendRequest`, ...) never touch scenario progress
 * fields directly, because real Postman traffic must update this UI too and it can only
 * ever reach the app through SSE (docs/SPEC.md section 13's whole reason Demo mode
 * exists: a curl or real-Postman request that never goes through this UI still has to
 * move the step chips and the log).
 */

const MAX_LOGS = 1000;

/**
 * `attemptHint` on `scenario:attempt` (the scenario author's human nudge, distinct from
 * the mechanical `reason`) is landing on `shared/src/events.ts`'s `ScenarioAttemptEvent`
 * in a concurrent server fix round; `shared/**` is off limits to this task, so the field
 * is read defensively here rather than assumed present on the imported type. Once the
 * fix round lands, `ScenarioAttemptEvent` gains the field natively and this cast becomes
 * a no-op (still correct, just no longer load-bearing).
 */
function readAttemptHint(event: ScenarioAttemptEvent): string | undefined {
  const hint = (event as ScenarioAttemptEvent & { attemptHint?: unknown }).attemptHint;
  return typeof hint === 'string' && hint !== '' ? hint : undefined;
}

export interface HeaderRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface RequestDraft {
  method: string;
  url: string;
  headers: HeaderRow[];
  body: string;
}

export type ResponseState =
  | { kind: 'success'; status: number; headers: Record<string, string>; body: string; timeMs: number; sizeBytes: number }
  | { kind: 'error'; message: string };

export interface StepChip {
  id: string;
  title?: string;
  done: boolean;
}

export interface ScenarioSlice {
  state: 'idle' | 'active' | 'explaining' | 'solved';
  scenarioId?: string;
  title?: string;
  tier?: Tier;
  track?: Track;
  platform?: Platform;
  drill: boolean;
  seed?: string;
  ticketMd?: string;
  steps: StepChip[];
  currentStepIndex: number;
  stepCount: number;
  attempts: number;
  hintsUnlocked: number;
  hintsRevealed: number;
  solutionRevealed: boolean;
  solutionMd?: string;
  hints: HintResponse[];
  lastAttempt?: { stepId: string; attempts: number; reason: string; attemptHint?: string; ts: number };
  /**
   * Fallback for page-reload hydration: `GET /api/state` can report the current step's
   * `attemptHint` even though it has no `reason` text to pair it with (that only exists on
   * the live `scenario:attempt` SSE event). Prefer `lastAttempt.attemptHint` when a live
   * attempt is available; fall back to this field otherwise.
   */
  attemptHint?: string;
}

export type ReferenceTab = 'ticket' | 'docs' | 'logs' | 'notes';
export type ResponseViewMode = 'pretty' | 'raw' | 'headers';

export interface UiSlice {
  demoMode: boolean;
  dividerPct: number;
  activeReferenceTab: ReferenceTab;
  responseViewMode: ResponseViewMode;
}

export interface StoreState {
  serverPort: number | null;
  connectionStatus: SSEConnectionStatus;
  lastHeartbeatTs: number | null;
  scenarios: ScenarioListEntry[];
  scenario: ScenarioSlice;
  /**
   * Guards against a stale-response race: the server's engine state is a long-lived
   * singleton that outlives any one page load, so `init()`'s `GET /api/state` hydration
   * can still be in flight when the learner immediately clicks a different scenario in
   * the picker. If that slower hydration resolved after the faster `activate()` call, it
   * would silently overwrite the freshly activated ticket with whatever the server was
   * showing at the moment the page loaded, a genuine bug this task's own end-to-end
   * verification caught live. Every client-initiated scenario fetch (`init`,
   * `activateScenario`, `activateDrill`, `resetScenario`) bumps this counter before
   * awaiting and only commits its result if the counter has not moved on since; a fresher
   * action always wins over a slower, older one, regardless of resolution order. SSE-driven
   * updates (`handleTrainerEvent`) never need this guard: they push the server's actual
   * current state directly and are not racing a client-side fetch.
   */
  scenarioEpoch: number;
  /**
   * Fix round: `init()` used to bump the epoch only right before its `getState()` call,
   * after already awaiting `health()`. That still left a window open, wide enough for
   * `Drill`/`Reset` clicked during the health round trip to take an EARLIER epoch than
   * `init()`'s own later `getState()`, so `init()`'s stale hydration would win. The epoch
   * is now claimed as the very first synchronous step of `init()`, before any await, so
   * nothing issued after `init()` starts can ever be mistaken for older than it.
   */
  initStarted: boolean;
  logs: RequestEvent[];
  request: RequestDraft;
  response: ResponseState | null;
  sending: boolean;
  errorMessage: string | null;
  ui: UiSlice;

  init: () => Promise<void>;
  handleTrainerEvent: (event: TrainerEvent) => void;
  setConnectionStatus: (status: SSEConnectionStatus) => void;

  loadScenarios: () => Promise<void>;
  activateScenario: (id: string) => Promise<void>;
  activateDrill: (tier?: number) => Promise<void>;
  resetScenario: () => Promise<void>;
  requestHint: () => Promise<void>;
  revealSolution: () => Promise<void>;
  explain: (rootCause: string, customerReply: string) => Promise<boolean>;

  updateRequestDraft: (patch: Partial<Omit<RequestDraft, 'headers'>>) => void;
  addHeaderRow: () => void;
  updateHeaderRow: (id: string, patch: Partial<Omit<HeaderRow, 'id'>>) => void;
  removeHeaderRow: (id: string) => void;
  sendRequest: () => Promise<void>;

  setDemoMode: (demoMode: boolean) => void;
  toggleDemoMode: () => void;
  setDividerPct: (pct: number) => void;
  setReferenceTab: (tab: ReferenceTab) => void;
  setResponseViewMode: (mode: ResponseViewMode) => void;
  setErrorMessage: (message: string | null) => void;
}

function defaultScenarioSlice(): ScenarioSlice {
  return {
    state: 'idle',
    drill: false,
    steps: [],
    currentStepIndex: 0,
    stepCount: 0,
    attempts: 0,
    hintsUnlocked: 0,
    hintsRevealed: 0,
    solutionRevealed: false,
    hints: [],
  };
}

function newHeaderRow(): HeaderRow {
  return { id: crypto.randomUUID(), key: '', value: '', enabled: true };
}

function defaultRequestDraft(): RequestDraft {
  return { method: 'GET', url: '', headers: [newHeaderRow()], body: '' };
}

function activatedPayloadToSlice(payload: ActivatedPayload): ScenarioSlice {
  return {
    state: 'active',
    scenarioId: payload.scenarioId,
    title: payload.title,
    tier: payload.tier,
    track: payload.track,
    platform: payload.platform,
    drill: payload.drill,
    seed: payload.seed,
    ticketMd: payload.ticketMd,
    steps: (payload.steps ?? []).map((s) => ({ id: s.id, title: s.title, done: false })),
    currentStepIndex: 0,
    stepCount: payload.stepCount,
    attempts: 0,
    hintsUnlocked: 0,
    hintsRevealed: 0,
    solutionRevealed: false,
    hints: [],
  };
}

/** `GET /_trainer/api/state` does not carry `seed` or hint/solution text (only counts and
 *  a revealed flag), so those fields stay unset on hydration: a page reload mid-scenario
 *  cannot recover previously-revealed hint text without the learner re-triggering it, and
 *  `POST /api/hint` will correctly 409 in that case since `hintsRevealed` is already
 *  caught up to `hintsUnlocked` on the server. Minor, documented gap; not fixable from
 *  `web/**` alone since the server would need to start returning hint text in state. */
function engineStateToSlice(s: EnginePublicState): ScenarioSlice {
  if (s.state === 'idle') return defaultScenarioSlice();
  return {
    state: s.state,
    scenarioId: s.scenarioId,
    title: s.title,
    tier: s.tier,
    track: s.track,
    platform: s.platform,
    drill: s.drill ?? false,
    ticketMd: s.ticketMd,
    steps: (s.steps ?? []).map((st) => ({ id: st.id, title: st.title, done: st.done })),
    currentStepIndex: s.currentStepIndex ?? 0,
    stepCount: s.stepCount ?? s.steps?.length ?? 0,
    attempts: s.attempts ?? 0,
    hintsUnlocked: s.hintsUnlocked ?? 0,
    hintsRevealed: s.hintsRevealed ?? 0,
    solutionRevealed: s.solutionRevealed ?? false,
    hints: [],
    attemptHint: s.attemptHint,
  };
}

function messageFromError(err: unknown): string {
  if (err instanceof TrainerApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

export const useStore = create<StoreState>((set, get) => ({
  serverPort: null,
  connectionStatus: 'connecting',
  lastHeartbeatTs: null,
  scenarios: [],
  scenario: defaultScenarioSlice(),
  scenarioEpoch: 0,
  initStarted: false,
  logs: [],
  request: defaultRequestDraft(),
  response: null,
  sending: false,
  errorMessage: null,
  ui: { ...loadPersistedUi(), activeReferenceTab: 'ticket', responseViewMode: 'pretty' },

  async init() {
    // Idempotency guard: React StrictMode double-invokes this effect's callback in dev
    // (mount -> cleanup -> mount), which used to fire every request in here twice,
    // producing the paired 200/304 bursts visible in the Logs tab. Both invocations run
    // this synchronous prefix before either one's first `await`, so the second call
    // always sees `initStarted` already true and returns without issuing a single
    // request. This is not a StrictMode-only shim: `init()` genuinely should run exactly
    // once per page load in production too.
    if (get().initStarted) return;
    set({ initStarted: true });

    // The epoch is claimed here, as the very first thing this action does, before any
    // await: anything a learner triggers (Drill, Reset, picking a scenario) after init()
    // has started must always be treated as newer than init()'s own hydration, including
    // during the health() round trip below, not just during the getState() call after it.
    const epoch = get().scenarioEpoch + 1;
    set({ scenarioEpoch: epoch });

    try {
      const health = await trainerApi.health();
      set({ serverPort: health.port });
      const current = get().request;
      if (current.url === '') {
        set({ request: { ...current, url: `http://127.0.0.1:${health.port}/github/user` } });
      }
    } catch (err) {
      set({ errorMessage: `Could not reach the trainer server: ${messageFromError(err)}` });
    }

    try {
      const state = await trainerApi.getState();
      // Discard if a faster, more recent scenario action (a click, or the server pushing
      // its own scenario:activated over SSE) already moved the epoch on: this hydration
      // is now stale and must not clobber it.
      if (get().scenarioEpoch === epoch) set({ scenario: engineStateToSlice(state) });
    } catch {
      // Health already reported the outage above; do not double up the banner.
    }

    await get().loadScenarios();
  },

  handleTrainerEvent(event) {
    switch (event.type) {
      case 'log': {
        const logs = [...get().logs, event.event];
        if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
        set({ logs });
        break;
      }
      case 'heartbeat':
        set({ lastHeartbeatTs: event.ts });
        break;
      case 'scenario:activated':
        // Also bumps the epoch: this is the server's own authoritative push (it could be
        // this client's own activate() landing over SSE, or a curl/real-Postman/other-tab
        // activation in Demo mode), so any REST fetch still in flight from before this
        // moment (an init() hydration, a slower activate() response arriving out of
        // order) must now be treated as stale, even though nothing about the epoch would
        // otherwise say so.
        set({ scenarioEpoch: get().scenarioEpoch + 1, scenario: activatedPayloadToSlice(event) });
        break;
      case 'scenario:attempt': {
        const scenario = get().scenario;
        set({
          scenario: {
            ...scenario,
            attempts: event.attempts,
            attemptHint: readAttemptHint(event),
            lastAttempt: {
              stepId: event.stepId,
              attempts: event.attempts,
              reason: event.reason,
              attemptHint: readAttemptHint(event),
              ts: event.ts,
            },
          },
        });
        break;
      }
      case 'scenario:step': {
        const scenario = get().scenario;
        set({
          scenario: {
            ...scenario,
            currentStepIndex: event.nextStepIndex,
            steps: scenario.steps.map((s) => (s.id === event.stepId ? { ...s, done: true } : s)),
            // The previous step's attempt feedback is stale once it is cleared by success.
            lastAttempt: undefined,
            attemptHint: undefined,
          },
        });
        break;
      }
      case 'scenario:explaining':
        set({ scenario: { ...get().scenario, state: 'explaining' } });
        break;
      case 'scenario:solved':
        set({ scenario: { ...get().scenario, state: 'solved', solutionRevealed: true } });
        void get().loadScenarios(); // refresh the picker's solved checkmark
        break;
      case 'hint:unlocked': {
        const scenario = get().scenario;
        set({ scenario: { ...scenario, hintsUnlocked: Math.max(scenario.hintsUnlocked, event.index + 1) } });
        break;
      }
    }
  },

  setConnectionStatus(status) {
    set({ connectionStatus: status });
  },

  async loadScenarios() {
    try {
      const scenarios = await trainerApi.listScenarios();
      set({ scenarios });
    } catch (err) {
      set({ errorMessage: `Could not load scenarios: ${messageFromError(err)}` });
    }
  },

  async activateScenario(id) {
    const epoch = get().scenarioEpoch + 1;
    set({ scenarioEpoch: epoch });
    try {
      const payload = await trainerApi.activate(id);
      if (get().scenarioEpoch === epoch) set({ scenario: activatedPayloadToSlice(payload), response: null, errorMessage: null });
    } catch (err) {
      if (get().scenarioEpoch === epoch) set({ errorMessage: `Could not activate ${id}: ${messageFromError(err)}` });
    }
  },

  async activateDrill(tier) {
    const epoch = get().scenarioEpoch + 1;
    set({ scenarioEpoch: epoch });
    try {
      const payload = await trainerApi.activateDrill(tier);
      if (get().scenarioEpoch === epoch) set({ scenario: activatedPayloadToSlice(payload), response: null, errorMessage: null });
    } catch (err) {
      if (get().scenarioEpoch === epoch) set({ errorMessage: `Could not start a drill: ${messageFromError(err)}` });
    }
  },

  async resetScenario() {
    const epoch = get().scenarioEpoch + 1;
    set({ scenarioEpoch: epoch });
    try {
      await trainerApi.resetScenario();
      const state = await trainerApi.getState();
      if (get().scenarioEpoch === epoch) set({ scenario: engineStateToSlice(state), response: null, errorMessage: null });
    } catch (err) {
      if (get().scenarioEpoch === epoch) set({ errorMessage: `Could not reset: ${messageFromError(err)}` });
    }
  },

  async requestHint() {
    try {
      const hint = await trainerApi.hint();
      const scenario = get().scenario;
      const alreadyHave = scenario.hints.some((h) => h.index === hint.index);
      set({
        scenario: {
          ...scenario,
          hints: alreadyHave ? scenario.hints : [...scenario.hints, hint],
          hintsRevealed: Math.max(scenario.hintsRevealed, hint.index + 1),
        },
        errorMessage: null,
      });
    } catch (err) {
      set({ errorMessage: messageFromError(err) });
    }
  },

  async revealSolution() {
    try {
      const { solutionMd } = await trainerApi.revealSolution();
      set({ scenario: { ...get().scenario, solutionMd, solutionRevealed: true }, errorMessage: null });
    } catch (err) {
      set({ errorMessage: messageFromError(err) });
    }
  },

  async explain(rootCause, customerReply) {
    try {
      const { solutionMd } = await trainerApi.explain(rootCause, customerReply);
      set({
        scenario: { ...get().scenario, state: 'solved', solutionMd, solutionRevealed: true },
        errorMessage: null,
      });
      return true;
    } catch (err) {
      set({ errorMessage: messageFromError(err) });
      return false;
    }
  },

  updateRequestDraft(patch) {
    set({ request: { ...get().request, ...patch } });
  },

  addHeaderRow() {
    const request = get().request;
    set({ request: { ...request, headers: [...request.headers, newHeaderRow()] } });
  },

  updateHeaderRow(id, patch) {
    const request = get().request;
    set({
      request: {
        ...request,
        headers: request.headers.map((h) => (h.id === id ? { ...h, ...patch } : h)),
      },
    });
  },

  removeHeaderRow(id) {
    const request = get().request;
    set({ request: { ...request, headers: request.headers.filter((h) => h.id !== id) } });
  },

  async sendRequest() {
    const { request } = get();
    if (request.url.trim() === '') {
      set({ errorMessage: 'Enter a URL before sending.' });
      return;
    }
    const headers: Record<string, string> = {};
    for (const row of request.headers) {
      const key = row.key.trim();
      if (row.enabled && key !== '') headers[key] = row.value;
    }
    set({ sending: true, errorMessage: null });
    try {
      const result = await trainerApi.proxy({
        method: request.method,
        url: request.url.trim(),
        headers,
        body: request.body === '' ? undefined : request.body,
      });
      set({
        response: {
          kind: 'success',
          status: result.status,
          headers: result.headers,
          body: result.body,
          timeMs: result.timeMs,
          sizeBytes: result.sizeBytes,
        },
      });
    } catch (err) {
      set({ response: { kind: 'error', message: messageFromError(err) } });
    } finally {
      set({ sending: false });
    }
  },

  setDemoMode(demoMode) {
    const ui = { ...get().ui, demoMode };
    set({ ui });
    savePersistedUi({ demoMode: ui.demoMode, dividerPct: ui.dividerPct });
  },

  toggleDemoMode() {
    get().setDemoMode(!get().ui.demoMode);
  },

  setDividerPct(pct) {
    const clamped = Math.min(80, Math.max(30, pct));
    const ui = { ...get().ui, dividerPct: clamped };
    set({ ui });
    savePersistedUi({ demoMode: ui.demoMode, dividerPct: ui.dividerPct });
  },

  setReferenceTab(tab) {
    set({ ui: { ...get().ui, activeReferenceTab: tab } });
  },

  setResponseViewMode(mode) {
    set({ ui: { ...get().ui, responseViewMode: mode } });
  },

  setErrorMessage(message) {
    set({ errorMessage: message });
  },
}));
