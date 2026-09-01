import type { GithubTokenRecord, RunContext, World } from '@gym/shared';

export type { World, GithubTokenRecord } from '@gym/shared';

/**
 * Module-level singleton holding all mutable per-run state (docs/SPEC.md section 4:
 * "world.ts # World type + resetState() + activeWorld()"; hard constraint 5: "Every
 * mutable counter/token/secret lives in the World and is reset by resetState()").
 *
 * The `World` TYPE itself is declared in shared/src/world.ts, not here: see that file's
 * header comment for why (Fault.apply(w: World) is a shared type, and importing a
 * server-only type into shared would create a circular workspace dependency). This file
 * re-exports it, so anything importing "the World type" from platforms/world.ts, as spec
 * section 4's file tree names it, still finds it here, and owns the one thing that
 * genuinely is server-only: the actual mutable state and the functions that manage it.
 *
 * Task 3's engine calls `resetState(ctx)` at the start of every `activate()`, before
 * `def.build(ctx)` runs (spec section 9). A scenario's `setup: Array<(w: World) => void>`
 * and its faults' `apply(w: World): void` (spec section 7) then layer scenario-specific
 * mutations on top of the healthy baseline this function builds.
 */

let world: World | null = null;

const RATE_LIMIT_WINDOW_SEC = 3600;

/**
 * Rebuilds the World from scratch as a healthy baseline derived from `ctx`. Every field a
 * scenario's setup or faults might later mutate is reset here first, so any scenario can
 * be activated any number of times in a row (hard constraint 6) without state leaking
 * from a previous run.
 */
export function resetState(ctx: RunContext): void {
  world = {
    github: buildGithubWorld(ctx),
    google: {
      clientId: ctx.google.clientId,
      clientSecret: ctx.google.clientSecret,
      // Task 6 fix round: World.google no longer mirrors ctx.google.grantedScopes /
      // requestedScopes. Both were write-only (populated here, read nowhere): this
      // mock's actual OAuth semantics are entirely request-driven, whatever scope
      // string a live authorize request carries becomes the granted set on the
      // resulting code/token, so a separate "granted vs requested" World field never
      // had a real behavioral role to play. RunContext.google still carries both
      // fields (shared/src/scenario.ts section 8 is a frozen contract this task does
      // not reshape); only World's redundant, unread copies were removed.
      accessTokenTtlSec: ctx.google.accessTokenTtlSec,
      // Empty baseline: populated live as `platforms/google/oauth.ts` issues codes and
      // tokens during the run (Task 6). A scenario's `setup` may pre-populate any of
      // these three registries before the first request ever arrives (e.g.
      // `t3-revoked-refresh` hands over an already-issued, already-dead refresh token).
      issuedTokens: {},
      authCodes: {},
      refreshTokens: {},
    },
    glean: {
      instance: ctx.glean.instance,
      clientToken: ctx.glean.clientToken,
      indexingToken: ctx.glean.indexingToken,
      datasource: ctx.glean.datasource,
      docs: ctx.glean.docs.map((doc) => ({ ...doc })),
    },
    slack: {
      botToken: ctx.slack.botToken,
      signingSecret: ctx.slack.signingSecret,
      teamId: ctx.slack.teamId,
      botUserId: ctx.slack.botUserId,
      channels: ctx.slack.channels.map((channel) => ({ ...channel })),
    },
  };
}

function buildGithubWorld(ctx: RunContext): World['github'] {
  const reset = Math.floor(Date.now() / 1000) + RATE_LIMIT_WINDOW_SEC;
  const freshRateLimit = (): GithubTokenRecord['rateLimit'] => ({
    limit: ctx.github.rateLimit,
    remaining: ctx.github.rateLimit,
    reset,
    used: 0,
    resource: 'core',
  });
  const tokens: Record<string, GithubTokenRecord> = {
    [ctx.github.validPat]: { valid: true, scopes: [...ctx.github.scopes], rateLimit: freshRateLimit() },
    [ctx.github.revokedPat]: { valid: false, scopes: [], rateLimit: freshRateLimit() },
    [ctx.github.secondPat]: { valid: true, scopes: [...ctx.github.scopes], rateLimit: freshRateLimit() },
  };
  return {
    user: { ...ctx.user },
    org: ctx.github.org,
    repos: ctx.github.repos.map((repo) => ({ ...repo })),
    tokens,
  };
}

/**
 * The current World. Throws if no scenario has been activated yet, so code that reads
 * World before resetState() ran fails loudly instead of silently touching undefined
 * state.
 */
export function activeWorld(): World {
  if (!world) {
    throw new Error('activeWorld() called before resetState(): no scenario is active yet');
  }
  return world;
}
