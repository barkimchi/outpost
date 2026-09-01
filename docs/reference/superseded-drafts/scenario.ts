/**
 * Shared scenario schema. Transcribed from PLAN.md section 5 ("Shared schema").
 * These types are the contract between the server engine, the scenario definitions,
 * and the web reference panel. Keep this file in sync with PLAN.md; if PLAN.md changes,
 * this file changes with it.
 */

/** Curriculum tier. 1-5 are troubleshooting tiers (T1-T5), 6 is the capstone (T6). */
export type Tier = 1 | 2 | 3 | 4 | 5 | 6;

/** The four mocked platforms, one URL prefix each (see PLAN.md section 1). */
export type Platform = 'github' | 'google' | 'glean' | 'slack';

/**
 * Per-run generated data. A fresh RunContext is minted on every scenario activation
 * (see PLAN.md section 4) so nothing about a run is memorizable across attempts.
 */
export interface RunContext {
  /** The seed string this context was generated from. Same seed -> same context. */
  seed: string;
  company: { name: string; slug: string; domain: string };
  actor: { login: string; name: string; email: string; id: number };
  github: {
    validPat: string;
    revokedPat: string;
    scopes: string[];
    grantedScopes: string[];
    repos: { name: string; private: boolean }[];
    rateLimitResetEpoch: number;
  };
  google: {
    clientId: string;
    clientSecret: string;
    scopes: string[];
    accessTokenTtlSec: number;
    refreshToken: string;
  };
  glean: {
    clientToken: string;
    indexingToken: string;
    datasource: string;
    docs: { id: string; title: string; body: string }[];
  };
  slack: {
    botToken: string;
    signingSecret: string;
    channels: { id: string; name: string; joined: boolean }[];
  };
  /** Extra template values that don't fit a platform bucket, e.g. malformed field name, cursor. */
  vars: Record<string, string>;
}

/** Describes which incoming request a Step or intercept Fault cares about. */
export interface RequestMatcher {
  method?: string | string[];
  /** Matched against the full mock path, e.g. '/github/user'. */
  path?: string | RegExp;
  platform?: Platform;
  query?: Record<string, string>;
  bodyContains?: string;
}

/** A single check run against a matched RequestEvent. */
export type Assertion =
  | { kind: 'status'; equals: number }
  | { kind: 'statusIn'; oneOf: number[] }
  | { kind: 'bodyJsonPath'; path: string; equals?: unknown; exists?: boolean }
  | { kind: 'bodyContains'; text: string }
  | { kind: 'headerEquals'; name: string; value: string }
  /** Resolved in engine/assert.ts by id; for checks that don't fit the other kinds. */
  | { kind: 'custom'; id: string };

/** One step in a scenario's progression. Steps are evaluated in order. */
export interface Step {
  id: string;
  /** Shown on the progress chip. */
  label: string;
  match: RequestMatcher;
  assertions: Assertion[];
  /** Fault ids retired when this step completes. */
  clearFaults?: string[];
  /** Fallback reason text shown when a request matches but assertions fail. */
  attemptHint?: string;
}

/**
 * A fault injected into a run. State faults mutate the world once at activation so the
 * healthy router errors naturally (preferred). Intercept faults short-circuit middleware
 * with a verbatim fixture, for stateless breakage no state mutation can produce.
 */
export interface Fault {
  id: string;
  kind: 'state' | 'intercept';
  /** State faults mutate platforms/state here. Intercept faults may leave this a no-op. */
  apply: (ctx: RunContext) => void;
  /** Intercept only: which request this fault short-circuits. */
  match?: RequestMatcher;
  /** Intercept only: the verbatim response to return instead of hitting the real router. */
  respond?: (ctx: RunContext) => { status: number; headers?: Record<string, string>; body: unknown };
}

/**
 * A scenario template. Everything concrete (ticket text, seeded data, fault parameters,
 * assertions) is a function of RunContext, never a hardcoded literal, so the same
 * scenario id produces a different run every activation.
 */
export interface ScenarioTemplate {
  /** Stable across runs, e.g. 't2-revoked-pat'. Used for progress tracking. */
  id: string;
  tier: Tier;
  platform: Platform;
  /** Hidden in Drill mode. */
  title: string;
  docsRef: Platform;
  /** Support-escalation markdown shown in the Ticket tab. */
  ticket: (ctx: RunContext) => string;
  /** Seed healthy world state for this run. */
  setup: (ctx: RunContext) => void;
  faults: (ctx: RunContext) => Fault[];
  steps: (ctx: RunContext) => Step[];
  /** Unlock at attempt counts 3 / 6 / 9, in order. */
  hints: (ctx: RunContext) => string[];
  solutionMd: (ctx: RunContext) => string;
  /** When true: no faults, greenfield go-live framing instead of an escalation. */
  implementationTrack?: true;
}
