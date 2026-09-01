/**
 * Trainer HTTP API request/response types (docs/SPEC.md section 4: "api.ts # trainer HTTP
 * request/response types"), plus the persisted workspace shape behind
 * `GET`/`PUT /_trainer/api/workspace` and the docs registry shapes behind
 * `GET /_trainer/api/docs`/`GET /_trainer/api/docs/:id` (spec section 10).
 *
 * Until this task, `web/src/types.ts` hand-transcribed the scenario/engine slice of this
 * file from a live read of the server (see that file's own header comment for the history):
 * nothing kept the two in sync, so the server could rename a field and typecheck would stay
 * green on the web side. This file is the single source of truth both `server/**` and
 * `web/**` import from; `web/src/types.ts` re-exports it rather than redeclaring it.
 *
 * `RequestScripts` and `scripts` on `SavedRequest` exist for Task 9 (docs/SPEC.md section
 * 14, the Web Worker script engine, "Two script slots per request, persisted in
 * workspace.json on the request object as `scripts: { preRequest: string, test: string }`").
 * This task builds the persisted shape and the request-builder tab strip for them; it does
 * not build the worker or execute either script.
 */

import type { ActivatedStepSummary, Platform } from './events.js';

// --- Scenario/engine types (moved from web/src/types.ts) -------------------------------

export type Tier = 1 | 2 | 3 | 4 | 5 | 6;
export type Track = 'troubleshoot' | 'implementation';
/** `events.ts`'s `Platform` plus `'mixed'`: a scenario (`shared/src/scenario.ts`'s
 *  `ScenarioDef.platform`) can be `'mixed'` (the capstone spans multiple platforms), but a
 *  single captured `RequestEvent` (`events.ts`'s `Platform`) never is, so the two names stay
 *  distinct rather than one of them silently gaining a value the other never produces. */
export type ScenarioPlatform = Platform | 'mixed';
export type EngineLifecycleState = 'idle' | 'active' | 'explaining' | 'solved';

/** `POST /_trainer/api/scenarios/:id/activate` and `POST /_trainer/api/scenarios/drill`
 *  response, and the `scenario:activated` SSE payload minus `type`/`ts`
 *  (`server/src/engine/engine.ts`'s `ActivatedPayload`). Reuses `events.ts`'s
 *  `ActivatedStepSummary` rather than redeclaring an identical `{id, title}` shape. */
export interface ActivatedPayload {
  seed: string;
  tier: Tier;
  track: Track;
  platform: ScenarioPlatform;
  scenarioId?: string;
  title?: string;
  ticketMd: string;
  steps?: ActivatedStepSummary[];
  stepCount: number;
  drill: boolean;
}

export interface StateStepSummary {
  id: string;
  title?: string;
  done: boolean;
}

/** `GET /_trainer/api/state` response (`server/src/engine/engine.ts`'s
 *  `EnginePublicState`). */
export interface EnginePublicState {
  state: EngineLifecycleState;
  scenarioId?: string;
  title?: string;
  tier?: Tier;
  track?: Track;
  platform?: ScenarioPlatform;
  drill?: boolean;
  ticketMd?: string;
  steps?: StateStepSummary[];
  currentStepIndex?: number;
  stepCount?: number;
  attempts?: number;
  hintsUnlocked?: number;
  hintsRevealed?: number;
  solutionRevealed?: boolean;
  /** The scenario author's human nudge for the most recent attempt (`Step.attemptHint` in
   *  `shared/src/scenario.ts`), distinct from the mechanical `reason` on the
   *  `scenario:attempt` SSE event. */
  attemptHint?: string;
}

/** `GET /_trainer/api/scenarios` response entry. */
export interface ScenarioListEntry {
  id: string;
  tier: Tier;
  track: Track;
  title: string;
  platform: ScenarioPlatform;
  solved: boolean;
  runs: number;
}

export interface HintResponse {
  index: number;
  text: string;
}

export interface SolutionResponse {
  solutionMd: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  port: number;
}

/** `POST /_trainer/api/proxy` request body. */
export interface ProxyRequestBody {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** `POST /_trainer/api/proxy` success response. */
export interface ProxyResponseBody {
  status: number;
  headers: Record<string, string>;
  body: string;
  timeMs: number;
  sizeBytes: number;
}

/** `POST /_trainer/api/proxy` (and other trainer endpoints') error envelope: a 4xx/5xx
 *  JSON body with `error` (name) and `message` (human text). */
export interface ApiErrorBody {
  error: string;
  message: string;
}

// --- Docs registry (spec section 10: GET /api/docs, GET /api/docs/:id) -----------------

export interface DocSummary {
  id: string;
  title: string;
  /** A `Platform` for a single-platform doc, or `'mixed'` for a cross-cutting topic like
   *  environments/variables or the Auth tab's auth methods. Left as `string` rather than
   *  `Platform` so a doc is never forced to claim a platform it does not have. */
  platform: string;
}

export interface DocDetail {
  id: string;
  title: string;
  md: string;
}

// --- Workspace persistence (spec section 4/10/13: GET/PUT /api/workspace, data/workspace.json) --

export interface KeyValueRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface EnvironmentVariable {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface Environment {
  id: string;
  name: string;
  variables: EnvironmentVariable[];
}

export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2';

export interface BearerAuth {
  token: string;
}

export interface BasicAuth {
  username: string;
  password: string;
}

export interface ApiKeyAuth {
  key: string;
  value: string;
  addTo: 'header' | 'query';
}

/** The OAuth 2.0 helper (spec section 13): fields enough to drive the authorization-code
 *  flow through `/_trainer/api/proxy` the same way spec section 11's Google mock expects.
 *  `accessToken` is the token the helper most recently obtained (or one pasted by hand);
 *  it is what actually gets applied to the outgoing request, exactly like real Postman's
 *  OAuth 2.0 helper applies whichever token is "currently selected" for the request. */
export interface OAuth2Auth {
  accessToken: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
}

/** Every auth type's config is always present, not just the active one's: switching the
 *  Auth tab's dropdown from Bearer to Basic and back must not lose the bearer token, the
 *  same round-trip guarantee real Postman gives. `type` selects which one is actually
 *  applied to the outgoing request. */
export interface AuthConfig {
  type: AuthType;
  bearer: BearerAuth;
  basic: BasicAuth;
  apikey: ApiKeyAuth;
  oauth2: OAuth2Auth;
}

export type BodyMode = 'none' | 'raw-json' | 'form-urlencoded';

/** Task 9 (spec section 14). Persisted here now so this task's `SavedRequest` shape is the
 *  final one Task 9 extends into, not a shape that has to be reworked later. Empty strings
 *  until Task 9 wires the Pre-request/Tests tabs up to a script engine. */
export interface RequestScripts {
  preRequest: string;
  test: string;
}

export interface SavedRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: KeyValueRow[];
  auth: AuthConfig;
  bodyMode: BodyMode;
  rawBody: string;
  formBody: KeyValueRow[];
  scripts: RequestScripts;
}

export interface CollectionRequestItem {
  kind: 'request';
  id: string;
  request: SavedRequest;
}

export interface CollectionFolderItem {
  kind: 'folder';
  id: string;
  name: string;
  items: CollectionItem[];
}

export type CollectionItem = CollectionRequestItem | CollectionFolderItem;

export interface Collection {
  id: string;
  name: string;
  items: CollectionItem[];
}

export interface WorkspaceUi {
  demoMode: boolean;
  dividerPct: number;
}

/** `GET`/`PUT /_trainer/api/workspace` body (spec section 10, section 13's "persisted in
 *  workspace.json"). `draft` is the request currently open in the builder (so a server
 *  restart or a page reload does not lose in-progress edits the learner never explicitly
 *  saved into a collection); `draftLinkedTo` names which saved request `draft` was loaded
 *  from, if any, so the builder's Save button knows whether to update that request in place
 *  or prompt for a new one. */
export interface Workspace {
  version: 1;
  collections: Collection[];
  environments: Environment[];
  activeEnvironmentId: string | null;
  notes: string;
  draft: SavedRequest;
  draftLinkedTo: { collectionId: string; itemId: string } | null;
  ui: WorkspaceUi;
}

// --- Factories -----------------------------------------------------------------------
// Shared by server (the on-disk default when workspace.json does not exist yet) and web
// (creating a new request/environment/collection in the UI), so "what does an empty one of
// these look like" has exactly one definition instead of drifting between the two sides.

export function defaultAuthConfig(): AuthConfig {
  return {
    type: 'none',
    bearer: { token: '' },
    basic: { username: '', password: '' },
    apikey: { key: '', value: '', addTo: 'header' },
    oauth2: { accessToken: '', authUrl: '', tokenUrl: '', clientId: '', clientSecret: '', scope: '', redirectUri: '' },
  };
}

export function defaultRequestScripts(): RequestScripts {
  return { preRequest: '', test: '' };
}

export function defaultSavedRequest(id: string, name = 'Untitled request'): SavedRequest {
  return {
    id,
    name,
    method: 'GET',
    url: '',
    headers: [],
    auth: defaultAuthConfig(),
    bodyMode: 'none',
    rawBody: '',
    formBody: [],
    scripts: defaultRequestScripts(),
  };
}

export function defaultEnvironment(id: string, name = 'New Environment'): Environment {
  return { id, name, variables: [] };
}

export function defaultCollection(id: string, name = 'New Collection'): Collection {
  return { id, name, items: [] };
}

export function defaultWorkspaceUi(): WorkspaceUi {
  return { demoMode: false, dividerPct: 62 };
}

export function defaultWorkspace(): Workspace {
  return {
    version: 1,
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    notes: '',
    draft: defaultSavedRequest('draft'),
    draftLinkedTo: null,
    ui: defaultWorkspaceUi(),
  };
}

export class TrainerApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | undefined;
  constructor(status: number, body: ApiErrorBody | undefined, message: string) {
    super(message);
    this.name = 'TrainerApiError';
    this.status = status;
    this.body = body;
  }
}
