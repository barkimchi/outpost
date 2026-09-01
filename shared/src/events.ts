/**
 * Event schema shared between server (bus, SSE) and web (Logs tab, ExerciseBar, store).
 * See docs/SPEC.md section 6 (middleware spine, requestLog) and section 10 (trainer API,
 * SSE event names).
 *
 * Task 1 owns this file. `RequestEvent` is fully specified by spec section 6 and is
 * final. The `scenario:*` and `hint:unlocked` members of `TrainerEvent` are shaped from
 * the engine lifecycle description in spec section 9 and the trainer API table in
 * section 10, since the engine itself (`server/src/engine/engine.ts`) is Task 3's build.
 * Task 3 may extend these payloads but should not reshape the fields already here,
 * matching the "additive, not a rewrite" convention used elsewhere in this plan.
 */

export type Platform = 'github' | 'google' | 'glean' | 'slack';

/**
 * One captured HTTP exchange through the middleware spine (spec section 6). Emitted by
 * `requestLog` for every request that reaches it, whether it originated from the
 * built-in proxy or real Postman desktop.
 */
export interface RequestEvent {
  id: string;
  ts: number;
  method: string;
  /** Verbatim, for display in the Logs tab: evidence a learner reads, showing exactly
   *  what was sent (spec section 6). Never matched on; see pathLower. */
  path: string;
  /**
   * Lowercased, with any trailing slash stripped (except root `/`). THE ENGINE MATCHES
   * ON THIS, NEVER ON `path` (spec section 6). Express routes case-insensitively, so
   * `GET /GitHub/user` gets a real 200 from a platform mock; matching on the verbatim
   * `path` would make that request invisible to the engine, the worst failure mode this
   * project has (a scenario silently un-completable). Platform derivation and the
   * requestLog skip list use this too, for the same reason.
   */
  pathLower: string;
  query: Record<string, string>;
  /** null when the path does not start with a known platform prefix (e.g. /_trainer). */
  platform: Platform | null;
  /**
   * Header VALUES are kept, not redacted: this is a training tool and every credential
   * is a generated fake (spec section 6: "redacted values kept -- this is a training
   * tool, secrets are fake").
   */
  reqHeaders: Record<string, string>;
  /** utf8, capped at 8KB. null when the request had no body. */
  reqBody: string | null;
  reqBodyTruncated: boolean;
  status: number;
  resHeaders: Record<string, string>;
  /** utf8, capped at 8KB. null when the response had no body. */
  resBody: string | null;
  resBodyTruncated: boolean;
  durationMs: number;
  /**
   * Whether the request arrived through the built-in `/_trainer/api/proxy` (the
   * built-in Postman clone) or from outside the process (real Postman desktop hitting
   * the platform routers directly). Dual-client parity is the point of this project, and
   * the Logs tab distinguishes the two. Set by requestLog from a marker header the proxy
   * adds to its own outbound calls; never present on genuinely external traffic.
   *
   * Accepted limitation (final-review fix round, finding 9, documented not fixed): this
   * is spoofable. Any client, real Postman desktop included, can send the same marker
   * header by hand and be badged `'proxy'` despite never having gone through the
   * built-in proxy at all. Harmless: nothing in this project makes a trust or security
   * decision based on `source`, it is purely a Logs tab display label ("did this come
   * from the built-in UI or from outside"), and every credential in this project is
   * already a generated fake (hard constraint 3), so there is nothing a spoofed badge
   * could gain access to. Fixing it (an HMAC'd or otherwise unforgeable marker) would add
   * real complexity for a cosmetic label with no security surface behind it.
   */
  source: 'proxy' | 'external';
}

/** The bus fans a captured RequestEvent out to SSE as a `log` event. */
export interface LogEvent {
  type: 'log';
  event: RequestEvent;
}

/** Kept alive every 15s so proxies and browsers do not time out an idle SSE connection. */
export interface HeartbeatEvent {
  type: 'heartbeat';
  ts: number;
}

export interface ActivatedStepSummary {
  id: string;
  title: string;
}

/**
 * A scenario (or a drill draw) was activated: resetState() ran, a fresh seed was minted,
 * and step index is 0 (spec section 9). In Drill mode, `scenarioId`, `title`, and `steps`
 * are omitted (undefined): "the activated payload omits title and any fault identity.
 * Only ticketMd and step count are exposed." `stepCount` is always present either way.
 */
export interface ScenarioActivatedEvent {
  type: 'scenario:activated';
  ts: number;
  seed: string;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  track: 'troubleshoot' | 'implementation';
  platform: 'github' | 'google' | 'glean' | 'slack' | 'mixed';
  scenarioId?: string;
  title?: string;
  ticketMd: string;
  steps?: ActivatedStepSummary[];
  stepCount: number;
  drill: boolean;
}

/**
 * A request matched the current step's matcher but failed one or more assertions.
 * `reason` is mandatory and built from the first failing assertion (spec section 9:
 * "'right endpoint, still 401'", "'200 but the body has 0 repos, expected at least 1'").
 * Never empty (spec hard constraint 9: "Attempt feedback always says why it didn't
 * count").
 *
 * `attemptHint` (Task 3 second fix round) carries the current step's `Step.attemptHint`
 * (spec section 8: "shown when match hits but assertions fail"), when the scenario
 * author wrote one. Every scenario in this registry writes one, but until this round no
 * event or state payload ever surfaced it: `reason` is mechanical ("expected status 200,
 * got 401"), `attemptHint` is the author's human nudge, and the two are deliberately
 * separate fields so a consumer can show both, distinctly.
 */
export interface ScenarioAttemptEvent {
  type: 'scenario:attempt';
  ts: number;
  stepId: string;
  attempts: number;
  reason: string;
  attemptHint?: string;
}

/** A step's match and all its assertions passed; the engine advanced to the next step. */
export interface ScenarioStepEvent {
  type: 'scenario:step';
  ts: number;
  stepId: string;
  nextStepIndex: number;
}

/** The last step completed; the engine is waiting on the Explain-back submission. */
export interface ScenarioExplainingEvent {
  type: 'scenario:explaining';
  ts: number;
}

/** explain() persisted rootCause + customerReply into progress.json. */
export interface ScenarioSolvedEvent {
  type: 'scenario:solved';
  ts: number;
}

/** Attempt count crossed a 3/6/9 threshold and a new hint became available. */
export interface HintUnlockedEvent {
  type: 'hint:unlocked';
  ts: number;
  index: number;
}

export type TrainerEvent =
  | LogEvent
  | HeartbeatEvent
  | ScenarioActivatedEvent
  | ScenarioAttemptEvent
  | ScenarioStepEvent
  | ScenarioExplainingEvent
  | ScenarioSolvedEvent
  | HintUnlockedEvent;
