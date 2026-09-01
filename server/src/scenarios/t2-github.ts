import type { Fault, RunContext, ScenarioDef } from '@gym/shared';
import { escapeRegex } from '../engine/match.js';

/**
 * Tier 2: GitHub (docs/SPEC.md section 12, scenarios 4-7). All four are STATE faults
 * (docs/SPEC.md section 7: "prefer state faults"): each mutates one of two candidate
 * token records in the World at activation, and the already-built `/github` router
 * (Task 2) errors on its own, exactly as spec section 7 intends ("the healthy router
 * errors naturally, and the real fix genuinely resolves it"). None needs an intercept
 * fault, so none of these depends on `faultInjector.ts` being wired in (it now is, as of
 * this fix round, but these four still do not use it).
 *
 * **Fix round, docs/SPEC.md hard constraint 7a.** Every ticket originally handed the
 * learner two tokens, always labeled "wired into the script" (always the broken one,
 * `validPat`) and "spare" (always the fix, `secondPat`), always in that order. Live
 * testing found the answer's SHAPE was memorizable even though the token strings were
 * not: "the second one listed always works," across 8/8 activations. Regenerating values
 * while the position of the correct answer stays fixed just moves the shortcut up one
 * level.
 *
 * Fixed by reading `ctx.vars.brokenCredentialSlot` (set in `generate.ts` from the same
 * seeded rng, so a captured seed still reproduces it): the fault targets `validPat` or
 * `secondPat` depending on that draw, and the ticket lists both under neutral, identity-
 * free labels ("Token 1" / "Token 2", always in `validPat`-then-`secondPat` field order,
 * never reordered by brokenness) so which position holds the fix varies run to run
 * instead of being fixed by the ticket's own narrative framing. The learner has to
 * actually call the endpoint with each token to find out which one works; see
 * `engine.test.ts` for the 6-run distribution check and `task-3-report.md` for the live
 * distribution across real activations.
 */

function brokenAndWorkingPats(ctx: RunContext): { brokenPat: string; workingPat: string } {
  const broken = ctx.vars.brokenCredentialSlot === 'second' ? ctx.github.secondPat : ctx.github.validPat;
  const working = ctx.vars.brokenCredentialSlot === 'second' ? ctx.github.validPat : ctx.github.secondPat;
  return { brokenPat: broken, workingPat: working };
}

const t2RevokedPat: ScenarioDef = {
  id: 't2-revoked-pat',
  tier: 2,
  track: 'troubleshoot',
  title: 'Revoked PAT',
  platform: 'github',
  docsRef: ['github'],
  build(ctx: RunContext) {
    const { brokenPat, workingPat } = brokenAndWorkingPats(ctx);

    const ticketMd = `
## Ticket

${ctx.company.name}'s integration to GitHub is failing. Two personal access tokens are
on file for it:

- Token 1: \`${ctx.github.validPat}\`
- Token 2: \`${ctx.github.secondPat}\`

Exactly one of them currently authenticates. Find out which, and get the integration
working with it.
`.trim();

    const fault: Fault = {
      id: 'revoke-one-token',
      kind: 'state',
      apply(w) {
        const record = w.github.tokens[brokenPat];
        if (record) record.valid = false;
      },
    };

    return {
      ticketMd,
      setup: [],
      faults: [fault],
      steps: [
        {
          id: 'step-1',
          title: 'Authenticate to GET /github/user',
          match: { method: 'GET', pathPattern: '^/github/user$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'login', equals: ctx.user.login },
          ],
          attemptHint: '401 Bad credentials means the credential itself is the problem. Try the other token before assuming anything else is wrong.',
        },
      ],
      hints: [
        'GitHub returns the identical 401 body whether a token is malformed, expired, or explicitly revoked; the message alone does not say which token is which.',
        'One request per token is enough to know for certain which one is dead. Try both against GET /github/user.',
      ],
      solutionMd: `
## Root cause

\`${brokenPat}\` was revoked (or otherwise never valid). GitHub answers every request
from an invalid token with \`401 Bad credentials\`, regardless of what the request
actually asked for. Nothing about the request itself was wrong.

## Fix

Use \`${workingPat}\` instead.
`.trim(),
    };
  },
};

/**
 * Which specific real, distinct scope-gated 403 endpoint this run's `t2-missing-scope`
 * targets (fix round 2, spec hard constraint 7a: "WHICH scope is missing" is its own
 * dimension, not just which token). `GET /orgs/:org/repos` needs `read:org`;
 * `GET /notifications` needs `notifications`, a genuinely different, real GitHub scope
 * requirement, both already implemented in `platforms/github/router.ts`.
 */
interface MissingScopeVariant {
  scope: string;
  pathPattern: (ctx: RunContext) => string;
  ticketAction: (ctx: RunContext) => string;
  stepTitle: (ctx: RunContext) => string;
  assertions: Array<{ kind: 'status'; equals: number } | { kind: 'jsonArrayLength'; path: string; min?: number }>;
}

const MISSING_SCOPE_VARIANTS: Record<'org' | 'notifications', MissingScopeVariant> = {
  org: {
    scope: 'read:org',
    pathPattern: (ctx) => `^/github/orgs/${escapeRegex(ctx.github.org)}/repos$`,
    ticketAction: (ctx) => `lists every repo in the \`${ctx.github.org}\` org`,
    stepTitle: (ctx) => `List repos in ${ctx.github.org}`,
    assertions: [
      { kind: 'status', equals: 200 },
      { kind: 'jsonArrayLength', path: '', min: 1 },
    ],
  },
  notifications: {
    scope: 'notifications',
    pathPattern: () => '^/github/notifications$',
    ticketAction: () => 'checks notifications',
    stepTitle: () => 'List notifications',
    assertions: [{ kind: 'status', equals: 200 }],
  },
};

const t2MissingScope: ScenarioDef = {
  id: 't2-missing-scope',
  tier: 2,
  track: 'troubleshoot',
  title: 'Missing OAuth scope',
  platform: 'github',
  docsRef: ['github'],
  build(ctx: RunContext) {
    const { brokenPat, workingPat } = brokenAndWorkingPats(ctx);
    const variantKey = ctx.vars.missingScopeVariant === 'notifications' ? 'notifications' : 'org';
    const variant = MISSING_SCOPE_VARIANTS[variantKey];

    const ticketMd = `
## Ticket

${ctx.company.name}'s nightly job ${variant.ticketAction(ctx)} and has started failing
with 403. Two tokens are on file for it:

- Token 1: \`${ctx.github.validPat}\`
- Token 2: \`${ctx.github.secondPat}\`

One of them is missing a scope this endpoint requires. Work out which, and get the
request succeeding with the other.
`.trim();

    const fault: Fault = {
      id: 'missing-scope',
      kind: 'state',
      apply(w) {
        const record = w.github.tokens[brokenPat];
        if (record) record.scopes = record.scopes.filter((s) => s !== variant.scope);
      },
    };

    return {
      ticketMd,
      setup: [],
      faults: [fault],
      steps: [
        {
          id: 'step-1',
          title: variant.stepTitle(ctx),
          match: { method: 'GET', pathPattern: variant.pathPattern(ctx) },
          assertions: variant.assertions,
          attemptHint: 'A 403 here is about permission, not identity. Compare X-OAuth-Scopes against X-Accepted-OAuth-Scopes on the failing response before switching tokens.',
        },
      ],
      hints: [
        'The response headers on the 403 name exactly which scope was required and which scopes that specific token actually carries.',
        `Check both tokens' X-OAuth-Scopes. Only one of them is missing ${variant.scope}.`,
      ],
      solutionMd: `
## Root cause

\`${brokenPat}\` is missing the \`${variant.scope}\` scope this endpoint requires.
GitHub answers with 403 \`Resource not accessible by personal access token\` and
\`X-Accepted-OAuth-Scopes: ${variant.scope}\` naming exactly what was missing.

## Fix

Use \`${workingPat}\`, which still carries \`${variant.scope}\`.
`.trim(),
    };
  },
};

const t2Private404: ScenarioDef = {
  id: 't2-private-404',
  tier: 2,
  track: 'troubleshoot',
  title: 'A 404 that is not really a 404',
  platform: 'github',
  docsRef: ['github'],
  build(ctx: RunContext) {
    const { brokenPat, workingPat } = brokenAndWorkingPats(ctx);
    const escapedOrg = escapeRegex(ctx.github.org);
    const escapedRepo = escapeRegex(ctx.github.privateRepo);

    const ticketMd = `
## Ticket

Someone on ${ctx.company.name}'s team swears
\`${ctx.github.org}/${ctx.github.privateRepo}\` was deleted, because
\`GET /repos/${ctx.github.org}/${ctx.github.privateRepo}\` returns 404. You checked
GitHub's web UI yourself: the repo is still there. Two tokens are on file for the
tooling that hits this endpoint:

- Token 1: \`${ctx.github.validPat}\`
- Token 2: \`${ctx.github.secondPat}\`

Figure out what is actually going on, and get the request returning the repo.
`.trim();

    const fault: Fault = {
      id: 'strip-repo-scope',
      kind: 'state',
      apply(w) {
        const record = w.github.tokens[brokenPat];
        if (record) record.scopes = record.scopes.filter((s) => s !== 'repo');
      },
    };

    return {
      ticketMd,
      setup: [],
      faults: [fault],
      steps: [
        {
          id: 'step-1',
          title: `GET the private repo ${ctx.github.privateRepo}`,
          match: { method: 'GET', pathPattern: `^/github/repos/${escapedOrg}/${escapedRepo}$` },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'name', equals: ctx.github.privateRepo },
          ],
          attemptHint: 'GitHub returns 404, not 403, for a private repo a token cannot see. "Not Found" here can mean "not found by you." Try the other token before concluding anything was deleted.',
        },
      ],
      hints: [
        'A deleted repo and a private repo you lack access to look identical from the API: both 404.',
        'One of the two tokens above still has the repo scope needed to see private repos. The other does not.',
      ],
      solutionMd: `
## Root cause

The repo is private, and \`${brokenPat}\` is missing the \`repo\` scope needed to see
private repositories. GitHub's real privacy model answers a private repo a token cannot
see with \`404 Not Found\`, the same body it uses for a repo that genuinely does not
exist. The repo was never deleted.

## Fix

Use \`${workingPat}\`, which still carries \`repo\`.
`.trim(),
    };
  },
};

const t2RateLimit: ScenarioDef = {
  id: 't2-rate-limit',
  tier: 2,
  track: 'troubleshoot',
  title: 'Rate limit exhausted',
  platform: 'github',
  docsRef: ['github'],
  build(ctx: RunContext) {
    const { brokenPat, workingPat } = brokenAndWorkingPats(ctx);

    const ticketMd = `
## Ticket

${ctx.company.name}'s sync job hammers the GitHub API all day and just started failing
with 403 on every call. Two tokens are on file for it:

- Token 1: \`${ctx.github.validPat}\`
- Token 2: \`${ctx.github.secondPat}\`

Confirm what is actually wrong before you touch anything, then get the job running
again with whichever token still has budget.
`.trim();

    const fault: Fault = {
      id: 'exhaust-rate-limit',
      kind: 'state',
      apply(w) {
        const record = w.github.tokens[brokenPat];
        if (record) {
          record.rateLimit.remaining = 0;
          record.rateLimit.used = record.rateLimit.limit;
        }
      },
    };

    return {
      ticketMd,
      setup: [],
      faults: [fault],
      steps: [
        {
          id: 'step-1',
          title: 'Authenticate to GET /github/user',
          match: { method: 'GET', pathPattern: '^/github/user$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'login', equals: ctx.user.login },
          ],
          attemptHint: "A 403 with x-ratelimit-remaining: 0 is not a permissions problem. Read x-ratelimit-reset on the failing response, then check the other token's budget before switching.",
        },
      ],
      hints: [
        'This 403 has a different message than a scope problem: read the response body, not just the status code.',
        'Only one of the two tokens above has an exhausted budget. Check x-ratelimit-remaining on each.',
      ],
      solutionMd: `
## Root cause

\`${brokenPat}\` used its entire rate-limit budget. GitHub answers with 403 and
\`x-ratelimit-remaining: 0\`, plus an \`x-ratelimit-reset\` unix timestamp for when the
budget refills. The token itself is fine; it is simply out of requests for this window.

## Fix

Use \`${workingPat}\`, which has its own separate, untouched budget, while the first
token's window resets.
`.trim(),
    };
  },
};

export const t2Scenarios: ScenarioDef[] = [t2RevokedPat, t2MissingScope, t2Private404, t2RateLimit];
