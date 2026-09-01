import type { GithubTokenRecord, RunContext, SlackMessage, World } from '@gym/shared';
import { hashSeedToUint32, mulberry32 } from '../engine/generate.js';

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

// --- Task 7: seeded Slack message history ------------------------------------------------
//
// `RunContext.slack.channels` (shared/src/scenario.ts, frozen per spec section 8) carries
// no message content, only channel identity + membership. `conversations.history`'s
// cursor-pagination lesson (t5-envelope-trap) needs real, reproducible content to page
// through, so it is generated here, deterministically from the run's seed plus the
// channel id, the same "derive from seed, never Math.random" discipline
// `engine/generate.ts` itself follows (reusing its exported `mulberry32`/
// `hashSeedToUint32` rather than a second PRNG implementation). This is genuinely
// per-channel, per-run data (hard constraint 6), just generated one layer later than
// `generate.ts` itself, since `RunContext` has nowhere to hold it without reshaping the
// frozen section-8 contract.

const SLACK_MESSAGE_POOL = [
  'Deploy went out clean, no errors in the logs.',
  'Can someone review the open PR when they get a chance?',
  'Heads up, staging is being redeployed in 10 minutes.',
  'Thanks for the quick turnaround on that.',
  'Anyone else seeing slow response times this morning?',
  'Meeting notes are up in the shared doc.',
  'Reminder: standup moved to 10am today.',
  'Fixed, was a stale cache on our end.',
  'Looks good to me, approving now.',
  'Following up on this, any update?',
  'On it, will report back shortly.',
  'That matches what I am seeing too.',
] as const;

const SLACK_MESSAGE_AUTHORS = ['U0MSGAUTH1', 'U0MSGAUTH2', 'U0MSGAUTH3'] as const;

/**
 * The last (oldest) message in every seeded channel history, always. `platforms/slack/
 * router.ts`'s `conversations.history` pagination is deliberately clamped to a small page
 * size (see that file), so reaching this text in a response is only possible once the
 * cursor has genuinely been followed to the final page: `t5-envelope-trap`'s step 2
 * asserts on it directly, which is how "prove the pagination loop terminates and the
 * learner actually walked it" is graded server-side, not just exercised by this project's
 * own tests.
 */
export const OLDEST_SLACK_MESSAGE_MARKER = 'This is the oldest message on record. Channel history begins here.';

function pick<T>(next: () => number, arr: readonly T[]): T {
  const item = arr[Math.floor(next() * arr.length)];
  if (item === undefined) throw new Error('pick() called on an empty array');
  return item;
}

function buildSlackChannelMessages(seed: string, channelId: string): SlackMessage[] {
  const next = mulberry32(hashSeedToUint32(`${seed}:slack-history:${channelId}`));
  const count = 9 + Math.floor(next() * 5); // 9..13: at a 4-per-page clamp, always 3-4 pages.
  const nowSec = Math.floor(Date.now() / 1000);
  const messages: SlackMessage[] = [];
  for (let i = 0; i < count; i++) {
    const isOldest = i === count - 1;
    messages.push({
      ts: `${nowSec - i * 600}.${String(100 + i).padStart(6, '0')}`,
      user: pick(next, SLACK_MESSAGE_AUTHORS),
      text: isOldest ? OLDEST_SLACK_MESSAGE_MARKER : pick(next, SLACK_MESSAGE_POOL),
    });
  }
  return messages;
}

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
      // Empty at every reset (Task 7): populated live as platforms/glean/router.ts
      // receives real indexdocument/indexdocuments calls during the run, the same
      // "empty baseline, live-populated registry" convention as google.issuedTokens.
      indexedDocs: {},
    },
    slack: {
      botToken: ctx.slack.botToken,
      signingSecret: ctx.slack.signingSecret,
      teamId: ctx.slack.teamId,
      botUserId: ctx.slack.botUserId,
      teamName: ctx.company.name,
      channels: ctx.slack.channels.map((channel) => ({ ...channel })),
      // Seeded deterministically from the run's seed (Task 7), not carried on
      // RunContext.slack itself; see buildSlackChannelMessages()'s comment above.
      messages: Object.fromEntries(
        ctx.slack.channels.map((channel) => [channel.id, buildSlackChannelMessages(ctx.seed, channel.id)]),
      ),
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
