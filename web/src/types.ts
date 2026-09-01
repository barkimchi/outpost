/**
 * Local type definitions for the trainer HTTP API's request/response shapes.
 *
 * `docs/SPEC.md` section 4 assigns these to `shared/src/api.ts`, and `shared/src/index.ts`
 * explicitly defers that file "until a task actually reads/writes one of those shapes"
 * (this task is that task). This dispatch scopes Task 4 to `web/**` only ("Do NOT edit
 * anything under server/**, shared/**, or scripts/**"), so `shared/src/api.ts` cannot be
 * authored here. These types are hand-transcribed from a live read of
 * `server/src/engine/engine.ts` (ActivatedPayload, EnginePublicState, ScenarioListEntry)
 * and `server/src/trainer/proxy.ts` (the proxy request/response envelope) as of this
 * task's dispatch. Flagged in the task report as a follow-up: once `web/**` and
 * `shared/**` are editable in the same task, hoist these into `shared/src/api.ts` and
 * import from `@gym/shared` instead of duplicating them here.
 */

export type Tier = 1 | 2 | 3 | 4 | 5 | 6;
export type Track = 'troubleshoot' | 'implementation';
export type Platform = 'github' | 'google' | 'glean' | 'slack' | 'mixed';
export type EngineLifecycleState = 'idle' | 'active' | 'explaining' | 'solved';

export interface ActivatedStepSummary {
  id: string;
  title: string;
}

/** `POST /_trainer/api/scenarios/:id/activate` and `POST /_trainer/api/scenarios/drill`
 *  response, and the `scenario:activated` SSE payload minus `type`/`ts`
 *  (`server/src/engine/engine.ts`'s `ActivatedPayload`). */
export interface ActivatedPayload {
  seed: string;
  tier: Tier;
  track: Track;
  platform: Platform;
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
  platform?: Platform;
  drill?: boolean;
  ticketMd?: string;
  steps?: StateStepSummary[];
  currentStepIndex?: number;
  stepCount?: number;
  attempts?: number;
  hintsUnlocked?: number;
  hintsRevealed?: number;
  solutionRevealed?: boolean;
  /**
   * The scenario author's human nudge for the most recent attempt (`Step.attemptHint` in
   * `shared/src/scenario.ts`), distinct from the mechanical `reason` on the
   * `scenario:attempt` SSE event. Landing on `GET /api/state` in a server fix round
   * concurrent with this task (see `server/src/engine/engine.ts` /
   * `shared/src/events.ts`, both off limits here); optional so this type keeps compiling
   * against the pre-fix server too.
   */
  attemptHint?: string;
}

/** `GET /_trainer/api/scenarios` response entry. */
export interface ScenarioListEntry {
  id: string;
  tier: Tier;
  track: Track;
  title: string;
  platform: Platform;
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
