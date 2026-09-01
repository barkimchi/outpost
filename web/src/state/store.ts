import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { RequestEvent, ScenarioAttemptEvent, TrainerEvent } from '@gym/shared';
import { defaultCollection, defaultEnvironment, defaultSavedRequest, defaultWorkspaceUi } from '@gym/shared';
import type {
  ActivatedPayload,
  AuthType,
  BodyMode,
  Collection,
  DocDetail,
  DocSummary,
  EnginePublicState,
  Environment,
  HintResponse,
  KeyValueRow,
  ScenarioListEntry,
  Tier,
  Track,
  ScenarioPlatform,
  SavedRequest,
  Workspace,
} from '@gym/shared';
import { trainerApi } from '../api/client.js';
import type { SSEConnectionStatus } from '../api/sse.js';
import { loadPersistedUi, savePersistedUi } from './persistence.js';
import { TrainerApiError } from '../types.js';
import { buildResolvedRequest } from '../lib/buildRequest.js';
import { flattenEnvVars } from '../lib/vars.js';
import { buildUrlWithParams, parseUrlParams } from '../lib/urlParams.js';
import {
  deleteCollection as deleteCollectionTree,
  deleteItem as deleteCollectionItemTree,
  findRequestItem,
  insertItem,
  newFolder,
  newRequestItem,
  renameCollection as renameCollectionTree,
  renameItem as renameItemTree,
  updateRequestInTree,
} from '../lib/collections.js';

/**
 * The app's single Zustand store: workspace (collections/environments/notes/the current
 * request draft), the response, scenario/engine state, and the live request log.
 * `api/sse.ts`'s single `EventSource` drives everything under `scenario` and `logs` through
 * `handleTrainerEvent` below; REST calls (`activateScenario`, `sendRequest`, ...) never
 * touch scenario progress fields directly, because real Postman traffic must update this UI
 * too and it can only ever reach the app through SSE.
 *
 * Task 5: the request draft grew from a bare method/url/headers/body into the full
 * `SavedRequest` shape (`shared/src/api.ts`): Auth tab config, a body mode, form-encoded
 * rows, and Task 9's still-empty script slots. Collections, environments, notes, and the
 * active environment now live here too, all persisted through `GET`/`PUT
 * /_trainer/api/workspace` (`data/workspace.json`, debounced 400ms, same write-temp-then-
 * rename convention as `progress.json`).
 */

const MAX_LOGS = 1000;

function readAttemptHint(event: ScenarioAttemptEvent): string | undefined {
  const hint = (event as ScenarioAttemptEvent & { attemptHint?: unknown }).attemptHint;
  return typeof hint === 'string' && hint !== '' ? hint : undefined;
}

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
  platform?: ScenarioPlatform;
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
  attemptHint?: string;
}

export type ReferenceTab = 'ticket' | 'docs' | 'logs' | 'notes';
export type ResponseViewMode = 'pretty' | 'raw' | 'headers' | 'test-results' | 'console';
export type RequestTab = 'params' | 'auth' | 'headers' | 'body' | 'prerequest' | 'tests';

export interface UiSlice {
  demoMode: boolean;
  dividerPct: number;
  activeReferenceTab: ReferenceTab;
  responseViewMode: ResponseViewMode;
  activeRequestTab: RequestTab;
}

export type ResponseState =
  | { kind: 'success'; status: number; headers: Record<string, string>; body: string; timeMs: number; sizeBytes: number }
  | { kind: 'error'; message: string };

export interface StoreState {
  serverPort: number | null;
  connectionStatus: SSEConnectionStatus;
  lastHeartbeatTs: number | null;
  scenarios: ScenarioListEntry[];
  scenario: ScenarioSlice;
  scenarioEpoch: number;
  initStarted: boolean;
  logs: RequestEvent[];
  response: ResponseState | null;
  sending: boolean;
  errorMessage: string | null;
  ui: UiSlice;

  // --- Workspace (docs/SPEC.md section 4/10/13) ---------------------------------------
  workspaceLoaded: boolean;
  collections: Collection[];
  environments: Environment[];
  activeEnvironmentId: string | null;
  notes: string;
  request: SavedRequest;
  draftLinkedTo: { collectionId: string; itemId: string } | null;

  // --- Docs (GET /_trainer/api/docs, GET /_trainer/api/docs/:id) -----------------------
  docs: DocSummary[];
  activeDocId: string | null;
  activeDoc: DocDetail | null;
  docsError: string | null;

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

  // --- Request builder ------------------------------------------------------------------
  setMethod: (method: string) => void;
  setUrl: (url: string) => void;
  setRequestName: (name: string) => void;
  addHeaderRow: () => void;
  updateHeaderRow: (id: string, patch: Partial<Omit<KeyValueRow, 'id'>>) => void;
  removeHeaderRow: (id: string) => void;
  addParamRow: () => void;
  updateParamRow: (index: number, patch: Partial<Omit<KeyValueRow, 'id'>>) => void;
  removeParamRow: (index: number) => void;
  setBodyMode: (mode: BodyMode) => void;
  setRawBody: (value: string) => void;
  addFormRow: () => void;
  updateFormRow: (id: string, patch: Partial<Omit<KeyValueRow, 'id'>>) => void;
  removeFormRow: (id: string) => void;
  setAuthType: (type: AuthType) => void;
  updateBearerAuth: (patch: { token: string }) => void;
  updateBasicAuth: (patch: Partial<{ username: string; password: string }>) => void;
  updateApiKeyAuth: (patch: Partial<{ key: string; value: string; addTo: 'header' | 'query' }>) => void;
  updateOAuth2Auth: (patch: Partial<{ accessToken: string; authUrl: string; tokenUrl: string; clientId: string; clientSecret: string; scope: string; redirectUri: string }>) => void;
  setScriptPreRequest: (value: string) => void;
  setScriptTest: (value: string) => void;
  sendRequest: () => Promise<void>;
  newRequestDraft: () => void;

  // --- Collections ------------------------------------------------------------------
  createCollection: (name?: string) => void;
  renameCollection: (collectionId: string, name: string) => void;
  deleteCollection: (collectionId: string) => void;
  createFolder: (collectionId: string, parentFolderId: string | null, name?: string) => void;
  createRequestItem: (collectionId: string, parentFolderId: string | null, name?: string) => void;
  renameCollectionItem: (collectionId: string, itemId: string, name: string) => void;
  deleteCollectionItem: (collectionId: string, itemId: string) => void;
  loadRequestFromCollection: (collectionId: string, itemId: string) => void;
  saveCurrentRequest: (target?: { collectionId: string; parentFolderId: string | null; name: string }) => void;

  // --- Environments ------------------------------------------------------------------
  createEnvironment: (name?: string) => void;
  renameEnvironment: (id: string, name: string) => void;
  deleteEnvironment: (id: string) => void;
  setActiveEnvironment: (id: string | null) => void;
  addEnvVariable: (envId: string) => void;
  updateEnvVariable: (envId: string, varId: string, patch: Partial<Omit<KeyValueRow, 'id'>>) => void;
  removeEnvVariable: (envId: string, varId: string) => void;

  setNotes: (notes: string) => void;

  // --- Docs ------------------------------------------------------------------
  loadDocs: () => Promise<void>;
  selectDoc: (id: string) => Promise<void>;

  setDemoMode: (demoMode: boolean) => void;
  toggleDemoMode: () => void;
  setDividerPct: (pct: number) => void;
  setReferenceTab: (tab: ReferenceTab) => void;
  setResponseViewMode: (mode: ResponseViewMode) => void;
  setRequestTab: (tab: RequestTab) => void;
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

function newKeyValueRow(): KeyValueRow {
  return { id: crypto.randomUUID(), key: '', value: '', enabled: true };
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

/** The active environment's enabled variables, flattened to a plain key/value map. The one
 *  place "what does `{{var}}` resolve against right now" is decided, so `sendRequest`, the
 *  `</> Code` export, and every highlighted field in the builder all read the identical
 *  answer. */
function activeVarsFromState(s: Pick<StoreState, 'environments' | 'activeEnvironmentId'>): Record<string, string> {
  const env = s.environments.find((e) => e.id === s.activeEnvironmentId);
  return env ? flattenEnvVars(env.variables) : {};
}

/** Selector hook for the resolved active-environment variable map, used by every field that
 *  highlights `{{var}}` references. Wrapped in `useShallow` so unrelated store churn (a log
 *  line arriving over SSE, an attempt counter ticking up) does not force every highlighted
 *  field to re-render on a brand-new object reference it did not actually need. */
export function useActiveVars(): Record<string, string> {
  return useStore(useShallow((s) => activeVarsFromState(s)));
}

function buildWorkspaceSnapshot(s: StoreState): Workspace {
  return {
    version: 1,
    collections: s.collections,
    environments: s.environments,
    activeEnvironmentId: s.activeEnvironmentId,
    notes: s.notes,
    draft: s.request,
    draftLinkedTo: s.draftLinkedTo,
    ui: { demoMode: s.ui.demoMode, dividerPct: s.ui.dividerPct },
  };
}

export const useStore = create<StoreState>((set, get) => {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced `PUT /_trainer/api/workspace` (docs/SPEC.md section 3: "debounced 250ms",
   *  matching progress.json's own convention; 400ms here to comfortably coalesce a fast
   *  typing burst in the URL bar or Notes tab into one write). Guarded on `workspaceLoaded`
   *  so nothing here can ever overwrite the real, on-disk workspace with this store's
   *  still-default, not-yet-hydrated initial state during the brief window before `init()`'s
   *  `GET /api/workspace` resolves. */
  function scheduleWorkspaceSave(): void {
    if (!get().workspaceLoaded) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      trainerApi.putWorkspace(buildWorkspaceSnapshot(get())).catch((err: unknown) => {
        set({ errorMessage: `Could not save workspace: ${messageFromError(err)}` });
      });
    }, 400);
  }

  function patchRequest(patch: Partial<SavedRequest>): void {
    set({ request: { ...get().request, ...patch } });
    scheduleWorkspaceSave();
  }

  return {
    serverPort: null,
    connectionStatus: 'connecting',
    lastHeartbeatTs: null,
    scenarios: [],
    scenario: defaultScenarioSlice(),
    scenarioEpoch: 0,
    initStarted: false,
    logs: [],
    response: null,
    sending: false,
    errorMessage: null,
    ui: { ...loadPersistedUi(), ...defaultWorkspaceUi(), activeReferenceTab: 'ticket', responseViewMode: 'pretty', activeRequestTab: 'params' },

    workspaceLoaded: false,
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    notes: '',
    request: defaultSavedRequest('draft'),
    draftLinkedTo: null,

    docs: [],
    activeDocId: null,
    activeDoc: null,
    docsError: null,

    async init() {
      if (get().initStarted) return;
      set({ initStarted: true });

      const epoch = get().scenarioEpoch + 1;
      set({ scenarioEpoch: epoch });

      try {
        const health = await trainerApi.health();
        set({ serverPort: health.port });
      } catch (err) {
        set({ errorMessage: `Could not reach the trainer server: ${messageFromError(err)}` });
      }

      try {
        const state = await trainerApi.getState();
        if (get().scenarioEpoch === epoch) set({ scenario: engineStateToSlice(state) });
      } catch {
        // Health already reported the outage above; do not double up the banner.
      }

      try {
        const workspace = await trainerApi.getWorkspace();
        set({
          collections: workspace.collections,
          environments: workspace.environments,
          activeEnvironmentId: workspace.activeEnvironmentId,
          notes: workspace.notes,
          request: workspace.draft,
          draftLinkedTo: workspace.draftLinkedTo,
          // The server's persisted UI wins over the localStorage instant-paint cache once
          // it is known, so a different browser/session picks up the same demo mode and
          // divider position rather than each keeping its own local guess forever.
          ui: { ...get().ui, demoMode: workspace.ui.demoMode, dividerPct: workspace.ui.dividerPct },
          workspaceLoaded: true,
        });
      } catch (err) {
        set({ errorMessage: `Could not load workspace: ${messageFromError(err)}`, workspaceLoaded: true });
      }

      await get().loadScenarios();
      await get().loadDocs();
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
          void get().loadScenarios();
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

    // --- Request builder --------------------------------------------------------------

    setMethod(method) {
      patchRequest({ method });
    },

    setUrl(url) {
      patchRequest({ url });
    },

    setRequestName(name) {
      patchRequest({ name });
    },

    addHeaderRow() {
      patchRequest({ headers: [...get().request.headers, newKeyValueRow()] });
    },

    updateHeaderRow(id, patch) {
      patchRequest({ headers: get().request.headers.map((h) => (h.id === id ? { ...h, ...patch } : h)) });
    },

    removeHeaderRow(id) {
      patchRequest({ headers: get().request.headers.filter((h) => h.id !== id) });
    },

    addParamRow() {
      const { base, params } = parseUrlParams(get().request.url);
      patchRequest({ url: buildUrlWithParams(base, [...params, { key: '', value: '', enabled: true }]) });
    },

    updateParamRow(index, patch) {
      const { base, params } = parseUrlParams(get().request.url);
      const updated = params.map((p, i) => (i === index ? { ...p, ...patch } : p));
      patchRequest({ url: buildUrlWithParams(base, updated) });
    },

    removeParamRow(index) {
      const { base, params } = parseUrlParams(get().request.url);
      patchRequest({ url: buildUrlWithParams(base, params.filter((_, i) => i !== index)) });
    },

    setBodyMode(mode) {
      patchRequest({ bodyMode: mode });
    },

    setRawBody(value) {
      patchRequest({ rawBody: value });
    },

    addFormRow() {
      patchRequest({ formBody: [...get().request.formBody, newKeyValueRow()] });
    },

    updateFormRow(id, patch) {
      patchRequest({ formBody: get().request.formBody.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
    },

    removeFormRow(id) {
      patchRequest({ formBody: get().request.formBody.filter((r) => r.id !== id) });
    },

    setAuthType(type) {
      patchRequest({ auth: { ...get().request.auth, type } });
    },

    updateBearerAuth(patch) {
      const auth = get().request.auth;
      patchRequest({ auth: { ...auth, bearer: { ...auth.bearer, ...patch } } });
    },

    updateBasicAuth(patch) {
      const auth = get().request.auth;
      patchRequest({ auth: { ...auth, basic: { ...auth.basic, ...patch } } });
    },

    updateApiKeyAuth(patch) {
      const auth = get().request.auth;
      patchRequest({ auth: { ...auth, apikey: { ...auth.apikey, ...patch } } });
    },

    updateOAuth2Auth(patch) {
      const auth = get().request.auth;
      patchRequest({ auth: { ...auth, oauth2: { ...auth.oauth2, ...patch } } });
    },

    setScriptPreRequest(value) {
      patchRequest({ scripts: { ...get().request.scripts, preRequest: value } });
    },

    setScriptTest(value) {
      patchRequest({ scripts: { ...get().request.scripts, test: value } });
    },

    newRequestDraft() {
      set({ request: defaultSavedRequest(crypto.randomUUID()), draftLinkedTo: null, response: null });
      scheduleWorkspaceSave();
    },

    async sendRequest() {
      const { request } = get();
      if (request.url.trim() === '') {
        set({ errorMessage: 'Enter a URL before sending.' });
        return;
      }

      const vars = activeVarsFromState(get());
      const resolved = buildResolvedRequest(request, vars);

      // Never render a secret as unresolvable and silently send the literal `{{token}}`
      // (this task's dispatch). Refuse to fire, and say exactly which variable(s) are
      // undefined, before touching the proxy at all.
      if (resolved.missing.length > 0) {
        const list = resolved.missing.map((name) => `{{${name}}}`).join(', ');
        set({
          errorMessage: `Undefined variable${resolved.missing.length > 1 ? 's' : ''}: ${list}. Set ${
            resolved.missing.length > 1 ? 'them' : 'it'
          } in the active environment before sending.`,
        });
        return;
      }

      set({ sending: true, errorMessage: null });
      try {
        const result = await trainerApi.proxy({
          method: resolved.method,
          url: resolved.url,
          headers: resolved.headers,
          body: resolved.body,
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

    // --- Collections --------------------------------------------------------------------

    createCollection(name) {
      set({ collections: [...get().collections, defaultCollection(crypto.randomUUID(), name)] });
      scheduleWorkspaceSave();
    },

    renameCollection(collectionId, name) {
      set({ collections: renameCollectionTree(get().collections, collectionId, name) });
      scheduleWorkspaceSave();
    },

    deleteCollection(collectionId) {
      set({ collections: deleteCollectionTree(get().collections, collectionId) });
      if (get().draftLinkedTo?.collectionId === collectionId) set({ draftLinkedTo: null });
      scheduleWorkspaceSave();
    },

    createFolder(collectionId, parentFolderId, name) {
      set({ collections: insertItem(get().collections, collectionId, parentFolderId, newFolder(crypto.randomUUID(), name)) });
      scheduleWorkspaceSave();
    },

    createRequestItem(collectionId, parentFolderId, name) {
      const request = defaultSavedRequest(crypto.randomUUID(), name ?? 'New Request');
      set({ collections: insertItem(get().collections, collectionId, parentFolderId, newRequestItem(request)) });
      scheduleWorkspaceSave();
    },

    renameCollectionItem(collectionId, itemId, name) {
      set({ collections: renameItemTree(get().collections, collectionId, itemId, name) });
      scheduleWorkspaceSave();
    },

    deleteCollectionItem(collectionId, itemId) {
      set({ collections: deleteCollectionItemTree(get().collections, collectionId, itemId) });
      const linked = get().draftLinkedTo;
      if (linked && linked.collectionId === collectionId && linked.itemId === itemId) set({ draftLinkedTo: null });
      scheduleWorkspaceSave();
    },

    loadRequestFromCollection(collectionId, itemId) {
      const item = findRequestItem(get().collections, collectionId, itemId);
      if (!item) return;
      set({ request: item.request, draftLinkedTo: { collectionId, itemId }, response: null });
      scheduleWorkspaceSave();
    },

    saveCurrentRequest(target) {
      const { request, draftLinkedTo } = get();
      if (!target && draftLinkedTo) {
        set({ collections: updateRequestInTree(get().collections, draftLinkedTo.collectionId, draftLinkedTo.itemId, request) });
        scheduleWorkspaceSave();
        return;
      }
      if (!target) return; // no link and no explicit target: caller must prompt for one (Sidebar's Save modal)
      const named: SavedRequest = { ...request, name: target.name };
      set({
        collections: insertItem(get().collections, target.collectionId, target.parentFolderId, newRequestItem(named)),
        request: named,
        draftLinkedTo: { collectionId: target.collectionId, itemId: named.id },
      });
      scheduleWorkspaceSave();
    },

    // --- Environments -------------------------------------------------------------------

    createEnvironment(name) {
      const env = defaultEnvironment(crypto.randomUUID(), name);
      set({ environments: [...get().environments, env], activeEnvironmentId: get().activeEnvironmentId ?? env.id });
      scheduleWorkspaceSave();
    },

    renameEnvironment(id, name) {
      set({ environments: get().environments.map((e) => (e.id === id ? { ...e, name } : e)) });
      scheduleWorkspaceSave();
    },

    deleteEnvironment(id) {
      set({ environments: get().environments.filter((e) => e.id !== id) });
      if (get().activeEnvironmentId === id) set({ activeEnvironmentId: null });
      scheduleWorkspaceSave();
    },

    setActiveEnvironment(id) {
      set({ activeEnvironmentId: id });
      scheduleWorkspaceSave();
    },

    addEnvVariable(envId) {
      set({
        environments: get().environments.map((e) => (e.id === envId ? { ...e, variables: [...e.variables, newKeyValueRow()] } : e)),
      });
      scheduleWorkspaceSave();
    },

    updateEnvVariable(envId, varId, patch) {
      set({
        environments: get().environments.map((e) =>
          e.id === envId ? { ...e, variables: e.variables.map((v) => (v.id === varId ? { ...v, ...patch } : v)) } : e,
        ),
      });
      scheduleWorkspaceSave();
    },

    removeEnvVariable(envId, varId) {
      set({
        environments: get().environments.map((e) => (e.id === envId ? { ...e, variables: e.variables.filter((v) => v.id !== varId) } : e)),
      });
      scheduleWorkspaceSave();
    },

    setNotes(notes) {
      set({ notes });
      scheduleWorkspaceSave();
    },

    // --- Docs ---------------------------------------------------------------------------

    async loadDocs() {
      try {
        const docs = await trainerApi.listDocs();
        set({ docs, docsError: null });
      } catch (err) {
        set({ docsError: messageFromError(err) });
      }
    },

    async selectDoc(id) {
      set({ activeDocId: id });
      try {
        const doc = await trainerApi.getDoc(id);
        // Guard against a stale response landing after the learner already clicked a
        // different doc in the list.
        if (get().activeDocId === id) set({ activeDoc: doc, docsError: null });
      } catch (err) {
        if (get().activeDocId === id) set({ docsError: messageFromError(err) });
      }
    },

    setDemoMode(demoMode) {
      const ui = { ...get().ui, demoMode };
      set({ ui });
      savePersistedUi({ demoMode: ui.demoMode, dividerPct: ui.dividerPct });
      scheduleWorkspaceSave();
    },

    toggleDemoMode() {
      get().setDemoMode(!get().ui.demoMode);
    },

    setDividerPct(pct) {
      const clamped = Math.min(80, Math.max(30, pct));
      const ui = { ...get().ui, dividerPct: clamped };
      set({ ui });
      savePersistedUi({ demoMode: ui.demoMode, dividerPct: ui.dividerPct });
      scheduleWorkspaceSave();
    },

    setReferenceTab(tab) {
      set({ ui: { ...get().ui, activeReferenceTab: tab } });
    },

    setResponseViewMode(mode) {
      set({ ui: { ...get().ui, responseViewMode: mode } });
    },

    setRequestTab(tab) {
      set({ ui: { ...get().ui, activeRequestTab: tab } });
    },

    setErrorMessage(message) {
      set({ errorMessage: message });
    },
  };
});
