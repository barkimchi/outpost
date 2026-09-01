import type { Fault, GoogleRefreshToken, RunContext, ScenarioDef, World } from '@gym/shared';
import {
  BASELINE_GOOGLE_SCOPES,
  POSTMAN_INTERCEPT_REDIRECT_URI,
  trainerCallbackRedirectUri,
} from '../platforms/google/oauth.js';

/**
 * Tier 6: the capstone (docs/SPEC.md section 12, scenario 16). Task 8 brief: "the exercise
 * Bar screen-records for a recruiter, so it has to be the best-made thing in the project."
 * Five graded steps, spanning Google OAuth and Glean:
 *
 *   1. Complete consent and exchange the code for an access/refresh pair, live (this is
 *      the whole reason the capstone exists: unlike every other Google scenario, nothing
 *      is pre-issued via `setup`).
 *   2. Prove access works via userinfo.
 *   3. Discover that the refresh token from step 1 is dead: attempt `grant_type=
 *      refresh_token` and get `invalid_grant`.
 *   4. Re-auth: run consent again for a brand new authorization code, exchange it, and get
 *      a genuinely working pair this time.
 *   5. A successful Glean indexing call.
 *
 * ## The mid-flight revocation mechanism
 *
 * The brief: "Stage the mid-flight breakage with `clearFaults` and a state fault carrying
 * a working `revert`." Every other Google scenario in this project (`t3-revoked-refresh`)
 * revokes a refresh token it minted itself, ahead of time, via `setup`, and hands the
 * value straight to the learner in the ticket. That trick is not available here: step 1 is
 * a genuinely live consent + exchange, so no refresh token string exists yet when a
 * state fault's `apply()` runs at activation. A fault cannot target what has not been
 * minted.
 *
 * Instead, `apply()` installs a trap directly on `World.google.refreshTokens`: a `Proxy`
 * whose `set` handler forces `revoked: true` onto whatever record `platforms/google/
 * oauth.ts` (untouched, out of this task's scope, and it does not need to be) is about to
 * store, the instant it stores it. The learner's own step-1 exchange mints a real refresh
 * token exactly the way it always does; the trap just poisons it the moment it lands. The
 * failure the learner eventually finds in step 3 is produced entirely by oauth.ts's own,
 * already-correct `if (!record || record.revoked)` check (docs/SPEC.md section 7: "the
 * healthy router then errors on its own"), never by short-circuiting the request.
 *
 * `revert()` removes the trap. It has to fire once the diagnosis (step 3) is complete and
 * BEFORE step 4's fresh exchange, not after: if it fired after step 4, the brand new
 * refresh token step 4 mints would ALSO get trapped and poisoned, since it would still be
 * assigned while the trap was active, leaving the "fix" silently still broken. Firing it
 * on step 3's `clearFaults` is exactly the right moment: the diagnosis the learner just
 * performed is what the fault exists to teach, so completing it is what should retire the
 * fault, and the WORLD is left genuinely healthy afterward, not covertly still poisoned
 * (see `t6-capstone.test.ts` for a live re-verification that a THIRD refresh, using step
 * 4's pair, actually works, proving `revert()` is not a no-op).
 *
 * ## Hard constraint 7a: no multi-candidate shape to randomize
 *
 * Every credential here is generated fresh per run (client id/secret, the run's own
 * seed-derived documents, the Glean instance/tokens), satisfying hard constraint 6, but
 * there is no "guess which one is right" shape anywhere in this scenario for hard
 * constraint 7a to apply to: the Google client id/secret and the Glean indexing token are
 * each handed over once, with nothing else on file, and the fix at every step is
 * procedural (send the right grant type, in the right order) rather than a pick between
 * competing candidates. This is the same judgment call already made and argued for
 * `t3-revoked-refresh`, `t3-token-expiry`, and `t5-hmac-signature` (see those files' own
 * header comments): introducing an artificial credential-guessing puzzle into the
 * flagship, screen-recorded scenario would actively work against its purpose (a smooth,
 * confident, reproducible demo of a real OAuth + indexing flow), not reinforce it. Per-run
 * variance is instead verified directly: distinct seeds, company identities, Glean
 * documents, and credentials across repeated activations (`t6-capstone.test.ts`,
 * `DISTRIBUTION_TEST_RUNS >= 14`).
 *
 * ## Hard constraint 9: checked against the wrong-attempt paths, not just the right one
 *
 * Step 1, step 3, and step 4 all match the identical endpoint (`POST /google/oauth2/
 * token`). Step 1 and step 4 need no extra guard: a stray `grant_type=refresh_token`
 * attempt at either point 400s (nothing valid exists yet, or the only refresh token on
 * file is the dead one from step 1), which correctly FAILS the `status: 200` assertion
 * with a real reason. Step 3 is the one place this needed real thought: without checking
 * the REQUEST's own `grant_type`, a learner who simply resent the already-used
 * step-1 code (`grant_type=authorization_code` again) would also get `invalid_grant`
 * (400, the code is used, the byte-identical response `handleRefreshTokenGrant`'s own
 * revoked-token branch produces) and would silently, incorrectly, complete step 3 without
 * ever having tested the refresh grant at all, exactly the class of defect hard
 * constraint 9 exists to catch (a step whose "pass" shape is reachable by an unrelated
 * wrong action). This endpoint is `application/x-www-form-urlencoded`, not JSON, so the
 * declarative `reqJsonPath` kind cannot even read `grant_type` off it (verified live: it
 * fails every request here with "request body is not valid JSON," including the correct
 * one). Step 3 therefore uses one custom assertion (`t6-refresh-grant-diagnosis`,
 * `engine/assert.ts`) that parses the form body directly and checks `grant_type` FIRST,
 * before status or the response body, so that specific false-pass path fails loudly with
 * a real reason instead of silently advancing.
 *
 * ## Hard constraint 7c
 *
 * The ticket never says a refresh token gets revoked, never names `invalid_grant`, and
 * never prescribes re-running consent. It states the situation (a Google + Glean
 * integration needs to be genuinely finished, not just apparently finished on the first
 * green response) and hands over the credentials and documents needed to do the work; the
 * mechanism is discovered, not announced. `hints`/`attemptHint` are exempt, per the same
 * convention as every scenario before this one.
 */

function callbackUrlLines(): string {
  return `Callback URL: \`${trainerCallbackRedirectUri()}\` (built-in UI) or \`${POSTMAN_INTERCEPT_REDIRECT_URI}\` (real Postman desktop, with "Authorize using browser" unchecked)`;
}

function createEmptyRefreshTokenTrap(): Record<string, GoogleRefreshToken> {
  const store: Record<string, GoogleRefreshToken> = {};
  return new Proxy(store, {
    set(target, prop, value) {
      target[String(prop)] = { ...(value as GoogleRefreshToken), revoked: true };
      return true;
    },
  });
}

function createMidflightRevokeFault(): Fault {
  return {
    id: 'midflight-refresh-revoke',
    kind: 'state',
    apply(w: World) {
      w.google.refreshTokens = createEmptyRefreshTokenTrap();
    },
    revert(w: World) {
      // Un-trap: copy whatever the trap already collected (including the one entry
      // poisoned during step 1) into a plain object. Nothing is lost; only the
      // interception on FUTURE assignments stops, so step 4's brand new refresh token
      // lands normal (revoked: false).
      w.google.refreshTokens = { ...w.google.refreshTokens };
    },
  };
}

const t6Capstone: ScenarioDef = {
  id: 't6-capstone',
  tier: 6,
  track: 'troubleshoot',
  title: 'Full go-live: Google OAuth into Glean',
  platform: 'mixed',
  docsRef: ['google-oauth', 'glean'],
  build(ctx: RunContext) {
    const fault = createMidflightRevokeFault();
    const docLines = ctx.glean.docs.map((doc) => `- \`${doc.id}\` ("${doc.title}")`).join('\n');

    const ticketMd = `
## Ticket

${ctx.company.name} wants its Google Calendar and Glean integration fully connected,
start to finish, not just "looks fine after the first successful call." Complete consent,
confirm access genuinely works, and finish by getting the company's documentation into
Glean's search index.

Client ID: \`${ctx.google.clientId}\`
Client secret: \`${ctx.google.clientSecret}\`
Scope: \`${BASELINE_GOOGLE_SCOPES.join(' ')}\`
${callbackUrlLines()}

Glean instance: \`${ctx.glean.instance}\`
Glean indexing token: \`${ctx.glean.indexingToken}\`
Datasource: \`${ctx.glean.datasource}\`
Documents to index:
${docLines}

This integration has looked done before and turned out not to be. Confirm every piece of
it actually still works before calling it finished.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [fault],
      steps: [
        {
          id: 'step-1',
          title: 'Complete consent and exchange the code for a token',
          match: { method: 'POST', pathPattern: '^/google/oauth2/token$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'access_token', exists: true },
            { kind: 'jsonPath', path: 'refresh_token', exists: true },
          ],
          attemptHint:
            'Approve the consent screen (approve=1) to get a code on the redirect, then POST it to /google/oauth2/token with grant_type=authorization_code, the same redirect_uri, and both the client id and secret.',
        },
        {
          id: 'step-2',
          title: 'Prove access via userinfo',
          match: { method: 'GET', pathPattern: '^/google/oauth2/v3/userinfo$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'email', equals: ctx.user.email },
          ],
          attemptHint: 'Send the access_token from step 1 as "Authorization: Bearer <token>".',
        },
        {
          id: 'step-3',
          title: 'Confirm the refresh token from step 1 no longer works',
          match: { method: 'POST', pathPattern: '^/google/oauth2/token$' },
          // `t6-refresh-grant-diagnosis` (engine/assert.ts): a custom assertion, not
          // declarative ones. `POST /oauth2/token` is form-encoded, not JSON, so
          // `reqJsonPath` cannot read `grant_type` off it at all (it fails on every
          // request to this endpoint, "request body is not valid JSON"). The custom
          // assertion parses the form body directly and checks grant_type=refresh_token
          // FIRST, before status or response body: without that, a learner who simply
          // resent step 1's already-used code (grant_type=authorization_code again) would
          // ALSO get invalid_grant and silently, wrongly, complete this step without ever
          // testing the refresh grant (hard constraint 9). See engine/assert.ts's own
          // comment on this id for the full reasoning.
          assertions: [{ kind: 'custom', id: 't6-refresh-grant-diagnosis' }],
          clearFaults: ['midflight-refresh-revoke'],
          attemptHint:
            'This step wants to see the refresh grant itself fail: POST /google/oauth2/token with grant_type=refresh_token and the refresh_token from step 1\'s response, then read what actually comes back.',
        },
        {
          id: 'step-4',
          title: 'Get a genuinely fresh access and refresh pair',
          match: { method: 'POST', pathPattern: '^/google/oauth2/token$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'access_token', exists: true },
            { kind: 'jsonPath', path: 'refresh_token', exists: true },
          ],
          attemptHint:
            "The refresh token from step 1 is gone for good, retrying it changes nothing. Run consent again for a brand new authorization code and exchange it with grant_type=authorization_code.",
        },
        {
          id: 'step-5',
          title: "Index the company's documents into Glean",
          match: { method: 'POST', pathPattern: '^/glean/api/index/v1/indexdocuments?$' },
          assertions: [{ kind: 'status', equals: 200 }],
          attemptHint:
            'Use the Glean indexing token, not a search token, on POST /glean/api/index/v1/indexdocument (one document) or /indexdocuments (bulk), with a real document id and the datasource from the ticket.',
        },
      ],
      hints: [
        'Consent, exchange, and a working userinfo call only prove the ACCESS token is good right now. Before calling this connected, actually exercise the refresh grant (POST /google/oauth2/token, grant_type=refresh_token, using the refresh_token from the very first exchange) and see what it actually returns.',
        'invalid_grant on that refresh attempt, using the exact refresh_token from the first exchange, is not a fluke worth retrying. That specific refresh token is gone for good; resending the same request changes nothing.',
        'Run the consent screen again for a brand new authorization code, exchange it with grant_type=authorization_code, and this new pair works normally. Finish by indexing every document listed in the ticket with the Glean indexing token, via POST /api/index/v1/indexdocument or the bulk /indexdocuments.',
      ],
      solutionMd: `
## Root cause

The refresh token minted during the very first consent and exchange was revoked on the
server almost immediately, silently, with nothing about the access token, the userinfo
call, or the Google credentials themselves ever changing. It looked completely fine as
long as nothing needed to refresh; the first real sign of trouble was \`invalid_grant\` on
a \`grant_type=refresh_token\` attempt against that specific refresh token.

## Fix

A revoked refresh token cannot be un-revoked: run the consent flow again for a brand new
authorization code, then exchange it with \`grant_type=authorization_code\` for a
genuinely fresh access and refresh pair. From there, index the company's documents into
Glean with \`POST /api/index/v1/indexdocument\` (or the bulk \`/indexdocuments\`) using the
indexing token, and the integration is actually done, not just apparently done.
`.trim(),
    };
  },
};

export const t6Scenarios: ScenarioDef[] = [t6Capstone];
