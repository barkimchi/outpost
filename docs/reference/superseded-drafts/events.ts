/**
 * Event schema shared between server (bus, SSE) and web (Logs tab, ExerciseBar, store).
 * See PLAN.md sections 2 ("requestLog" mounts on the bus) and 6 (engine lifecycle, SSE events).
 */

import type { Platform } from './scenario.js';

/**
 * One captured HTTP exchange through the middleware spine. Emitted by requestLog for every
 * request that reaches it, whether it originated from the built-in proxy or real Postman.
 */
export interface RequestEvent {
  id: string;
  ts: number;
  method: string;
  path: string;
  /** null when the request did not match a platform prefix (e.g. hit /_trainer directly). */
  platform: Platform | null;
  status: number;
  durationMs: number;
  requestHeaders: Record<string, string>;
  /** Captured request body, capped at ~64 KB by requestLog. */
  requestBody: unknown;
  responseHeaders: Record<string, string>;
  /** Captured response body, capped at ~64 KB by requestLog. */
  responseBody: unknown;
  /** Whether the request was sent through the built-in proxy or arrived from outside (real Postman). */
  source: 'proxy' | 'external';
}

/**
 * The bus fans a captured RequestEvent out to SSE as a 'log' event (PLAN.md section 2:
 * "the bus fans out to (a) SSE log events for the Logs tab"). This is how the Logs tab and
 * real-time traffic view stay in sync with every request the middleware spine observes.
 */
export interface LogEvent {
  type: 'log';
  event: RequestEvent;
}

/** A scenario was activated: fresh seed minted, world state reset, faults applied. */
export interface ScenarioActivatedEvent {
  type: 'scenario:activated';
  ts: number;
  scenarioId: string;
  seed: string;
}

/**
 * A request matched the current step's matcher but failed one or more assertions.
 * `reason` is mandatory and must say why the attempt did not count (PLAN.md section 5:
 * "Attempt feedback is mandatory and must say why").
 */
export interface ScenarioAttemptEvent {
  type: 'scenario:attempt';
  ts: number;
  scenarioId: string;
  stepId: string;
  attemptNumber: number;
  reason: string;
  requestEventId: string;
}

/** A step's assertions all passed; the scenario advanced (possibly into `explaining`). */
export interface ScenarioStepEvent {
  type: 'scenario:step';
  ts: number;
  scenarioId: string;
  stepId: string;
  /** True when this was the last step and the scenario moved to `explaining`. */
  isLastStep: boolean;
}

/** The explain-back gate was submitted and the scenario finalized as solved. */
export interface ScenarioSolvedEvent {
  type: 'scenario:solved';
  ts: number;
  scenarioId: string;
  seed: string;
}

/** A hint became available (unlocks at attempts 3 / 6 / 9). */
export interface HintUnlockedEvent {
  type: 'hint:unlocked';
  ts: number;
  scenarioId: string;
  hintIndex: number;
  text: string;
}

/** Keeps the SSE connection alive; also lets the client detect a dropped connection. */
export interface HeartbeatEvent {
  type: 'heartbeat';
  ts: number;
}

/** Everything the trainer bus can emit over SSE, discriminated on `type`. */
export type TrainerEvent =
  | LogEvent
  | ScenarioActivatedEvent
  | ScenarioAttemptEvent
  | ScenarioStepEvent
  | ScenarioSolvedEvent
  | HintUnlockedEvent
  | HeartbeatEvent;
