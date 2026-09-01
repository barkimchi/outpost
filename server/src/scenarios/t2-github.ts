import type { Fault, RunContext, ScenarioDef } from '@gym/shared';
import { escapeRegex } from '../engine/match.js';

/**
 * Tier 2: GitHub (docs/SPEC.md section 12, scenarios 4-7). All four are STATE faults
 * (docs/SPEC.md section 7: "prefer state faults"): each mutates one token record in the
 * World at activation, and the already-built `/github` router (Task 2) errors on its own,
 * exactly as spec section 7 intends ("the healthy router errors naturally, and the real
 * fix genuinely resolves it"). None needs an intercept fault, so none of these depends on
 * `faultInjector.ts` being wired in.
 *
 * Every ticket hands the learner BOTH the broken token and a working alternative
 * (`secondPat`, or `validPat` once the fault targets a different token), matching the
 * curriculum's own framing ("fix by using the run's valid PAT", "switch to the second
 * PAT"): the lesson is diagnosing WHICH credential is broken and why, from the response
 * itself, not guessing at a hidden value.
 */

const t2RevokedPat: ScenarioDef = {
  id: 't2-revoked-pat',
  tier: 2,
  track: 'troubleshoot',
  title: 'Revoked PAT',
  platform: 'github',
  docsRef: ['github'],
  build(ctx: RunContext) {
    const ticketMd = `
## Ticket

${ctx.company.name}'s integration script authenticates to GitHub and gets 401 Bad
credentials on every request. Ops handed over the two personal access tokens on file for
this integration:

- Currently wired into the script: \`${ctx.github.revokedPat}\`
- A second token issued the same day, never wired in: \`${ctx.github.validPat}\`

Work out which one is broken and get the script authenticating again.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'Authenticate to GET /github/user',
          match: { method: 'GET', pathPattern: '^/github/user$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'login', equals: ctx.user.login },
          ],
          attemptHint: '401 Bad credentials means the credential itself is invalid, not a header or method problem.',
        },
      ],
      hints: [
        'GitHub returns the identical 401 body whether a token is malformed or was explicitly revoked; the message alone does not say which.',
        'One of the two tokens above is dead on arrival. Try the other one.',
      ],
      solutionMd: `
## Root cause

\`${ctx.github.revokedPat}\` was revoked. GitHub answers every request from a revoked or
otherwise never-valid token with \`401 Bad credentials\`, regardless of what the request
actually asked for.

## Fix

Switch the script to the current token, \`${ctx.github.validPat}\`.
`.trim(),
    };
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
    const ticketMd = `
## Ticket

${ctx.company.name}'s nightly job lists every repo in the \`${ctx.github.org}\` org and
has started failing with 403. Two tokens are on file:

- Wired into the job: \`${ctx.github.validPat}\`
- A spare admin token, provisioned with full org read access: \`${ctx.github.secondPat}\`

Work out why the first token stopped working, and get the listing succeeding again.
`.trim();

    const fault: Fault = {
      id: 'missing-read-org',
      kind: 'state',
      apply(w) {
        const record = w.github.tokens[ctx.github.validPat];
        if (record) record.scopes = record.scopes.filter((s) => s !== 'read:org');
      },
    };

    return {
      ticketMd,
      setup: [],
      faults: [fault],
      steps: [
        {
          id: 'step-1',
          title: `List repos in ${ctx.github.org}`,
          match: { method: 'GET', pathPattern: `^/github/orgs/${escapeRegex(ctx.github.org)}/repos$` },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonArrayLength', path: '', min: 1 },
          ],
          attemptHint: 'A 403 here is about permission, not identity. Compare X-OAuth-Scopes against X-Accepted-OAuth-Scopes on the failing response.',
        },
      ],
      hints: [
        'The response headers on the 403 name exactly which scope was required and which scopes the token actually carries.',
        `X-OAuth-Scopes on the failing token is missing read:org. The spare token, ${ctx.github.secondPat}, still has it.`,
      ],
      solutionMd: `
## Root cause

\`${ctx.github.validPat}\` lost the \`read:org\` scope. \`GET /orgs/:org/repos\` requires
it, and GitHub answers with 403 \`Resource not accessible by personal access token\`
along with \`X-Accepted-OAuth-Scopes: read:org\` to name exactly what was missing.

## Fix

Switch the job to the spare token, \`${ctx.github.secondPat}\`, which still carries
\`read:org\`.
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
    const ticketMd = `
## Ticket

Someone on ${ctx.company.name}'s team swears
\`${ctx.github.org}/${ctx.github.privateRepo}\` was deleted, because
\`GET /repos/${ctx.github.org}/${ctx.github.privateRepo}\` returns 404 for the token
wired into their tooling: \`${ctx.github.validPat}\`

You checked GitHub's web UI yourself: the repo is still there. A spare token is on file
too: \`${ctx.github.secondPat}\`

Figure out what is actually going on and get the request returning the repo.
`.trim();

    const fault: Fault = {
      id: 'strip-repo-scope',
      kind: 'state',
      apply(w) {
        const record = w.github.tokens[ctx.github.validPat];
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
          match: {
            method: 'GET',
            pathPattern: `^/github/repos/${escapeRegex(ctx.github.org)}/${escapeRegex(ctx.github.privateRepo)}$`,
          },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'name', equals: ctx.github.privateRepo },
          ],
          attemptHint: 'GitHub returns 404, not 403, for a private repo a token cannot see. "Not Found" here can mean "not found by you."',
        },
      ],
      hints: [
        'A deleted repo and a private repo you lack access to look identical from the API: both 404.',
        'Try the request with the spare token before concluding the repo is actually gone.',
        `${ctx.github.secondPat} still has the repo scope the wired-in token is missing.`,
      ],
      solutionMd: `
## Root cause

The repo is private, and \`${ctx.github.validPat}\` lost the \`repo\` scope needed to see
private repositories. GitHub's real privacy model answers a private repo a token cannot
see with \`404 Not Found\`, the same body it uses for a repo that genuinely does not
exist. The repo was never deleted.

## Fix

Use the spare token, \`${ctx.github.secondPat}\`, which still carries \`repo\`.
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
    const ticketMd = `
## Ticket

${ctx.company.name}'s sync job hammers the GitHub API all day with
\`${ctx.github.validPat}\` and just started failing with 403 on every call. A second
token exists for exactly this situation: \`${ctx.github.secondPat}\`

Confirm what is actually wrong before you touch anything, then get the job running
again.
`.trim();

    const fault: Fault = {
      id: 'exhaust-rate-limit',
      kind: 'state',
      apply(w) {
        const record = w.github.tokens[ctx.github.validPat];
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
          attemptHint: 'A 403 with x-ratelimit-remaining: 0 is not a permissions problem. Read x-ratelimit-reset on the failing response before doing anything else.',
        },
      ],
      hints: [
        'This 403 has a different message than a scope problem: read the response body, not just the status code.',
        'x-ratelimit-remaining: 0 means the budget is gone until x-ratelimit-reset, not that the token is broken.',
        `Switch to the second token, ${ctx.github.secondPat}, which has its own independent budget.`,
      ],
      solutionMd: `
## Root cause

\`${ctx.github.validPat}\` used its entire rate-limit budget. GitHub answers with 403
and \`x-ratelimit-remaining: 0\`, plus an \`x-ratelimit-reset\` unix timestamp for when the
budget refills. The token itself is fine; it is simply out of requests for this window.

## Fix

Switch the job to \`${ctx.github.secondPat}\`, which has its own separate budget, while
the first token's window resets.
`.trim(),
    };
  },
};

export const t2Scenarios: ScenarioDef[] = [t2RevokedPat, t2MissingScope, t2Private404, t2RateLimit];
