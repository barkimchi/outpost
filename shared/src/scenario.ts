/**
 * The scenario type contract, transcribed from docs/SPEC.md section 8 ("Types
 * (shared/src/scenario.ts)"). Pure type declarations, no runtime code. Task 3's engine
 * (server/src/engine/*) and the scenario definitions (server/src/scenarios/*) implement
 * against these types and may extend them, but must not reshape the fields already
 * defined here.
 *
 * This file intentionally does NOT reuse anything from docs/reference/superseded-drafts/
 * (removed from an earlier session because it contradicts this section). Everything below
 * is written directly from spec section 8.
 *
 * `World` is not part of spec section 8's own code block (it is introduced by the Fault
 * model in spec section 7, "apply(w: World): void"), but Fault cannot compile without it.
 * It lives in the sibling file world.ts, not here: World is expected to keep growing
 * (Task 6 adds Google token/code registries, Task 7 adds Slack and Glean state) and this
 * file, the frozen section 8 contract, should not have to absorb that churn. See
 * world.ts's header comment for the rest of that reasoning.
 */

import type { World } from './world.js';

/** One generated training run's concrete data. Every scenario is a template over this. */
export interface RunContext {
  /** 8 hex chars, shown in the UI as "run #a3f9c1d2". */
  seed: string;
  company: { name: string; slug: string; domain: string };
  user: { login: string; name: string; email: string; id: number };
  github: {
    validPat: string;
    revokedPat: string;
    secondPat: string;
    scopes: string[];
    org: string;
    repos: Array<{ name: string; private: boolean; id: number }>;
    privateRepo: string;
    rateLimit: number;
  };
  google: {
    clientId: string;
    clientSecret: string;
    grantedScopes: string[];
    requestedScopes: string[];
    /** 15 for the expiry scenario, 3600 otherwise. */
    accessTokenTtlSec: number;
  };
  glean: {
    instance: string;
    clientToken: string;
    indexingToken: string;
    datasource: string;
    docs: Array<{ id: string; title: string; body: string }>;
  };
  slack: {
    botToken: string;
    signingSecret: string;
    teamId: string;
    botUserId: string;
    channels: Array<{ id: string; name: string; isMember: boolean }>;
  };
  /**
   * Extra per-run template values that do not belong to one platform: which field is
   * malformed this run, the cursor contents, a page size, a reset epoch. Ticket text,
   * docs callouts, and assertions read from here so they stay data-driven.
   */
  vars: Record<string, string>;
}

export type Assertion =
  | { kind: 'status'; equals: number }
  | { kind: 'statusIn'; oneOf: number[] }
  | { kind: 'jsonPath'; path: string; equals?: unknown; matches?: string; exists?: boolean }
  | { kind: 'jsonArrayLength'; path: string; min?: number; max?: number; equals?: number }
  /** name lowercased. */
  | { kind: 'headerEquals'; name: string; equals: string }
  | { kind: 'headerMatches'; name: string; matches: string }
  | { kind: 'bodyMatches'; matches: string }
  | { kind: 'reqHeaderMatches'; name: string; matches: string }
  | { kind: 'reqJsonPath'; path: string; equals?: unknown; matches?: string; exists?: boolean }
  /**
   * Escape hatch for a check the declarative kinds cannot express (a decoded cursor, a
   * recomputed HMAC). Resolved by id in engine/assert.ts against a small registry. Use
   * sparingly: a scenario made entirely of custom assertions is unreviewable.
   */
  | { kind: 'custom'; id: string };

export interface RequestMatcher {
  method?: string | string[];
  /** RegExp source, anchored by the matcher. */
  pathPattern: string;
  queryIncludes?: Record<string, string>;
  reqHeaderPresent?: string[];
}

export interface Step {
  id: string;
  title: string;
  match: RequestMatcher;
  assertions: Assertion[];
  clearFaults?: string[];
  /** Shown when match hits but assertions fail. */
  attemptHint?: string;
}

/** docs/SPEC.md section 7: two kinds of fault, state preferred over intercept. */
export type Fault =
  | { id: string; kind: 'state'; apply(w: World): void }
  | {
      id: string;
      kind: 'intercept';
      match: RequestMatcher;
      respond: { status: number; headers: Record<string, string>; body: string };
    };

export interface BuiltScenario {
  ticketMd: string;
  setup: Array<(w: World) => void>;
  faults: Fault[];
  steps: Step[];
  /** Unlock at 3 / 6 / 9 attempts. */
  hints: string[];
  solutionMd: string;
}

export interface ScenarioDef {
  /** Stable across runs (progress key). */
  id: string;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  track: 'troubleshoot' | 'implementation';
  /** Hidden in Drill mode. */
  title: string;
  platform: 'github' | 'google' | 'glean' | 'slack' | 'mixed';
  docsRef: string[];
  build(ctx: RunContext): BuiltScenario;
}
