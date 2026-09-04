import type { Fault, RunContext, ScenarioDef, World } from '@gym/shared';
import {
  BASELINE_GOOGLE_SCOPES,
  POSTMAN_INTERCEPT_REDIRECT_URI,
  trainerCallbackRedirectUri,
} from '../platforms/google/oauth.js';

/**
 * Tier 6: the capstone (docs/SPEC.md section 12, scenario 16). Task 8 brief: "the exercise
 * built to be screen-recorded as a demo, so it has to be the best-made thing in the project."
 * Six graded steps, spanning Google OAuth and Glean:
 *
 *   1. Complete consent and exchange the code for an access/refresh pair, live (unlike
 *      every other Google scenario, nothing is pre-issued via `setup`).
 *   2. Prove access works via userinfo.
 *   3. Refresh the access token, and watch it genuinely work.
 *   4. Refresh again, the identical request: it is dead now. Diagnose invalid_grant.
 *   5. Re-auth: run consent again for a brand new authorization code, exchange it, and get
 *      a genuinely working pair this time.
 *   6. Confirm one real document is genuinely indexed in Glean, with a body worth showing.
 *
 * ## Fix round (this is now a redesign, not a patch): making the break OBSERVABLE
 *
 * The original 5-step version staged the revocation with a `Proxy` trap that poisoned the
 * refresh token the instant it was minted, in step 1, before the learner ever touched it.
 * Reviewed live and correctly called out: "the mid-flight revocation is not mid-flight in
 * any observable way. The token is dead from birth; nothing happens between steps 2 and 3."
 * A credential that never worked is not a turn, it is a trivia fact, and this is the
 * exercise built to be screen-recorded.
 *
 * The fix is a genuine before/after over the SAME action: step 3 refreshes successfully
 * (a real 200, a real new access token, visible in the Logs tab); step 4 sends the
 * IDENTICAL request again and gets `invalid_grant`. Nothing else about the request or
 * credentials changes between the two; the only difference is that something happened to
 * the refresh token in between, discoverable purely by comparing two adjacent log entries.
 *
 * Mechanically, this still uses `clearFaults` and a state fault carrying a working
 * `revert`, exactly per the original brief, but the two functions swap roles from every
 * other scenario's convention: `apply()` (at activation, step 1 has not even run yet) is a
 * genuine no-op, since there is nothing to poison before the credential exists and the
 * whole point is that it must work at least once. `revert()` is where the actual
 * revocation happens, triggered by `clearFaults` on STEP 3's completion, not step 1's: the
 * instant the first, genuinely successful refresh is graded, every refresh token minted so
 * far (in the ordinary flow, exactly the one from step 1; the SAME string, since real
 * Google does not rotate refresh tokens on use, `shared/src/world.ts`'s
 * `GoogleRefreshToken` doc comment) gets marked revoked. By the time the learner's next
 * refresh attempt (step 4) reaches the server, the token that answered 200 seconds earlier
 * answers 400. This inverted apply/revert naming is documented here explicitly so a future
 * reader does not mistake it for a mistake: `revert()` is genuinely still "the function
 * `clearFaults` calls when the named step completes," it is just doing the breaking this
 * time, because the break has to be tied to a LATER step's completion, and `clearFaults` is
 * the only step-completion hook this engine exposes to a scenario author (see
 * `engine/engine.ts`'s `completeStep()`; adding a second, `apply`-triggering hook was out
 * of this task's scope, `engine.ts` was not named in it, and was not needed once this
 * approach was found).
 *
 * ## The finale: a real body, not `200 {}`
 *
 * Fix round finding 4's second half: "the finale needs a body worth showing." The original
 * step 5 graded the raw `POST /indexdocument(s)` call, whose success body is a bare `{}`
 * (`platforms/glean/fixtures.ts`'s `gleanIndexSuccess`, out of this task's scope). Step 6
 * now grades `GET /api/index/v1/getdocumentstatus` instead: a real, visible payload
 * (`id`, `datasource`, `status: "INDEXED"`, the title, a real `indexedAt` timestamp) that a
 * viewer can actually read and understand as "yes, this is genuinely in the index now,"
 * which is also the capstone's own stated theme (confirm it actually works, not just that
 * a call returned 200). The indexing call itself stays an ungraded prerequisite, the same
 * pattern the consent screen already uses ahead of step 1's graded exchange.
 *
 * The document indexed here is a NEW one this scenario mints itself
 * (`connection-health-report`, `<TICKET_DOC_ID>`), never one of the run's seeded
 * `ctx.glean.docs`: `platforms/glean/router.ts`'s `allSearchableDocs()` (a concurrent fix
 * round, out of this task's scope) now reports a SEEDED document as already `"INDEXED"`
 * from the moment the run starts, with nothing indexed. Grading `getdocumentstatus` on a
 * seeded id would false-pass step 6 with zero real work done; using an id that provably
 * does not exist anywhere until the learner's own indexing call creates it is what keeps
 * this step honest (`step-2`'s `queryIncludes: { id: ... }` below pins the match to
 * exactly that id, so a stray query against a seeded doc's id cannot satisfy it either).
 *
 * ## Hard constraint 7a: no multi-candidate shape to randomize
 *
 * Every credential here is generated fresh per run (client id/secret, the Glean
 * instance/tokens, the indexed document's title/body text), satisfying hard constraint 6,
 * but there is still no "guess which one is right" shape anywhere in this scenario for
 * hard constraint 7a to apply to: the Google client id/secret and the Glean indexing token
 * are each handed over once, with nothing else on file, and the fix at every step is
 * procedural (send the right grant type, in the right order, watch what changes) rather
 * than a pick between competing candidates. This is the same judgment call already made
 * and argued for `t3-revoked-refresh`, `t3-token-expiry`, and `t5-hmac-signature` (see
 * those files' own header comments): introducing an artificial credential-guessing puzzle
 * into the flagship, screen-recorded scenario would actively work against its purpose (a
 * smooth, confident, reproducible demo of a real OAuth + indexing flow), not reinforce it.
 * Per-run variance is instead verified directly: distinct seeds, company identities, and
 * credentials across repeated activations (`t6-capstone.test.ts`,
 * `DISTRIBUTION_TEST_RUNS >= 14`).
 *
 * ## Hard constraint 9: checked against the wrong-attempt paths, not just the right one
 *
 * Steps 1, 3, 4, and 5 all match the identical endpoint (`POST /google/oauth2/token`).
 * Step 1 and step 5 need no extra guard: a stray `grant_type=refresh_token` attempt at
 * either point 400s (nothing valid exists yet, or the only refresh token on file is the
 * dead one), which correctly FAILS the declarative `status: 200` assertion with a real
 * reason. Steps 3 and 4 needed real thought, in both directions:
 *
 * - Step 3 (the refresh must genuinely SUCCEED): without checking the request's own
 *   `grant_type`, a learner who instead ran a whole fresh consent + `authorization_code`
 *   exchange would ALSO get `{status: 200, access_token: "..."}` and silently, wrongly,
 *   complete this step without ever exercising the refresh grant it exists to prove
 *   healthy.
 * - Step 4 (the refresh must genuinely FAIL the right way): without checking `grant_type`,
 *   a learner who simply resent step 1's already-used code (`grant_type=authorization_code`
 *   again) would also get `invalid_grant` (400, the code is used, the byte-identical
 *   response `handleRefreshTokenGrant`'s own revoked-token branch produces) and would
 *   silently, incorrectly, complete this step without ever having tested the refresh grant
 *   at all. Fix round finding 1 (CRITICAL): checking `grant_type` alone was still not
 *   enough. A completely made-up `refresh_token` value (never issued this run at all) ALSO
 *   400s `invalid_grant`, through oauth.ts's `!record` branch rather than its
 *   `record.revoked` branch, and a learner who sent one would false-pass this step having
 *   diagnosed nothing real. Proven live before the fix: `refresh_token=1//totally-made-up`
 *   completed step 4 with zero recorded attempts. The assertion now additionally confirms
 *   the sent token exists in `activeWorld().google.refreshTokens` at all, so only a token
 *   this run genuinely issued (and this fault genuinely revoked) can satisfy the diagnosis.
 *
 * Both endpoints are `application/x-www-form-urlencoded`, not JSON, so the declarative
 * `reqJsonPath` kind cannot even read `grant_type` off either one (verified live: it fails
 * every request here with "request body is not valid JSON," including the correct one).
 * Steps 3 and 4 therefore use one custom assertion each (`t6-refresh-grant-success` /
 * `t6-refresh-grant-diagnosis`, `engine/assert.ts`) that parse the form body directly.
 *
 * ## Hard constraint 7c
 *
 * The ticket never says a refresh token gets revoked, never names `invalid_grant`, and
 * never prescribes re-running consent or refreshing twice. It states the situation (a
 * Google + Glean integration needs to be genuinely finished, not just apparently finished
 * on the first green response) and hands over the credentials and document needed to do
 * the work; the mechanism is discovered, not announced. Making the failure OBSERVABLE
 * (this fix round's whole point) is a mechanics change, not a narrative one: the ticket
 * still only ever describes the goal. `hints`/`attemptHint` are exempt, per the same
 * convention as every scenario before this one.
 */

// Exported for t6-capstone.test.ts (a unit-level check of step 6's matcher against a
// seeded doc id, not just narrative text), not consumed anywhere else in production code.
export const CONNECTION_HEALTH_DOC_ID = 'connection-health-report';

function callbackUrlLines(): string {
  return `Callback URL: \`${trainerCallbackRedirectUri()}\` (built-in UI) or \`${POSTMAN_INTERCEPT_REDIRECT_URI}\` (real Postman desktop, with "Authorize using browser" unchecked)`;
}

function createDelayedRefreshRevokeFault(): Fault {
  return {
    id: 'delayed-refresh-revoke',
    kind: 'state',
    apply(_w: World) {
      // Genuinely does nothing at activation. Step 1 has not run yet, so no refresh token
      // exists to poison, and the whole point of this design is that the credential must
      // work at least once, visibly, before anything breaks (see this file's header
      // comment: "Fix round"). The break is staged for later, tied to step 3's own
      // completion below, not to activation.
    },
    revert(w: World) {
      // Fires the instant step 3 (the first, genuinely successful refresh) completes. This
      // IS the mid-flight moment now, not a label on something already dead: marks every
      // refresh token minted so far (in the ordinary flow, exactly the one from step 1)
      // revoked, so the IDENTICAL next refresh attempt (step 4) fails where the previous
      // one, seconds earlier, just succeeded. A real before/after over the same action,
      // discoverable by comparing two adjacent Logs tab entries.
      for (const record of Object.values(w.google.refreshTokens)) {
        record.revoked = true;
      }
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
    const fault = createDelayedRefreshRevokeFault();
    const docTitle = `${ctx.company.name} Connection Health Report`;

    const ticketMd = `
## Ticket

${ctx.company.name} wants its Google and Glean integration fully connected, start to
finish, not just "looks fine after the first successful call." Complete consent, confirm
access genuinely works, and finish by getting one new company document indexed into
Glean, confirmed and visible in the index status, not just attempted.

- Client ID: \`${ctx.google.clientId}\`
- Client secret: \`${ctx.google.clientSecret}\`
- Scope: \`${BASELINE_GOOGLE_SCOPES.join(' ')}\`
- ${callbackUrlLines()}

- Glean instance: \`${ctx.glean.instance}\`
- Glean indexing token: \`${ctx.glean.indexingToken}\`
- Datasource: \`${ctx.glean.datasource}\`
- Document to index: \`${CONNECTION_HEALTH_DOC_ID}\` ("${docTitle}")

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
          title: 'Refresh the access token, and watch it work',
          match: { method: 'POST', pathPattern: '^/google/oauth2/token$' },
          // `t6-refresh-grant-success` (engine/assert.ts): a custom assertion, not
          // declarative ones. Form-encoded body, same as step 4's reasoning below; also
          // guards against a fresh authorization_code exchange false-passing this step
          // without ever touching the refresh grant.
          assertions: [{ kind: 'custom', id: 't6-refresh-grant-success' }],
          clearFaults: ['delayed-refresh-revoke'],
          attemptHint:
            "Send grant_type=refresh_token with the refresh_token from step 1's response. This has to be a genuine refresh grant, not a repeat of the authorization_code exchange.",
        },
        {
          id: 'step-4',
          title: 'Send the identical refresh again, and see what changed',
          match: { method: 'POST', pathPattern: '^/google/oauth2/token$' },
          // `t6-refresh-grant-diagnosis` (engine/assert.ts): checks grant_type=refresh_token
          // FIRST (rules out an unrelated authorization_code resend also 400ing the same
          // way), THEN that the sent refresh_token was genuinely issued this run (fix round
          // finding 1: rules out a made-up token also 400ing invalid_grant through a
          // different branch of the SAME handler), THEN status and the error body. See
          // engine/assert.ts's own comment on this id for the full reasoning.
          assertions: [{ kind: 'custom', id: 't6-refresh-grant-diagnosis' }],
          attemptHint:
            "Send the exact same grant_type=refresh_token request again, with the exact same refresh_token from step 1 that just worked in step 3. Read what actually comes back this time.",
        },
        {
          id: 'step-5',
          title: 'Get a genuinely fresh access and refresh pair',
          match: { method: 'POST', pathPattern: '^/google/oauth2/token$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'access_token', exists: true },
            { kind: 'jsonPath', path: 'refresh_token', exists: true },
          ],
          attemptHint:
            'The refresh token from step 1 is gone for good now, retrying it changes nothing. Run consent again for a brand new authorization code and exchange it with grant_type=authorization_code.',
        },
        {
          id: 'step-6',
          title: 'Confirm the document is genuinely indexed',
          match: {
            method: 'GET',
            pathPattern: '^/glean/api/index/v1/getdocumentstatus$',
            // Pinned to this scenario's own document id, not any query to this endpoint:
            // a seeded (pre-existing) document already reports "INDEXED" from the moment
            // the run starts (platforms/glean/router.ts's allSearchableDocs(), a concurrent
            // fix round, out of this task's scope), so this step must never be satisfiable
            // by querying one of those. See this file's header comment, "The finale."
            queryIncludes: { id: CONNECTION_HEALTH_DOC_ID },
          },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'status', equals: 'INDEXED' },
          ],
          attemptHint:
            `First index the document (POST /glean/api/index/v1/indexdocument with the indexing token, id "${CONNECTION_HEALTH_DOC_ID}", the datasource from the ticket, and a title/body), then query getdocumentstatus for that exact id and datasource.`,
        },
      ],
      hints: [
        'A refresh that works once does not prove it will keep working. After the first successful refresh (step 3), immediately send the exact same refresh again and see what changed.',
        'invalid_grant on that SECOND refresh attempt, using the exact refresh_token that just worked seconds earlier, is not a fluke worth retrying. That refresh token is now gone for good.',
        `Run consent again for a brand new authorization code, exchange it with grant_type=authorization_code, and this new pair works normally. Finish by indexing "${CONNECTION_HEALTH_DOC_ID}" with the Glean indexing token, then confirm it with getdocumentstatus: a real "status": "INDEXED" response, not just a 200.`,
      ],
      solutionMd: `
## Root cause

The refresh token from the very first exchange worked once, genuinely: the first refresh
(step 3) minted a real new access token, visible as a clean 200 in the logs. It was
revoked immediately afterward, silently, with nothing about the request or credentials
ever changing. The only way to see it was to use that exact same refresh token a second
time: the identical action that just succeeded came back \`invalid_grant\`.

## Fix

A revoked refresh token cannot be un-revoked: run the consent flow again for a brand new
authorization code, then exchange it with \`grant_type=authorization_code\` for a
genuinely fresh access and refresh pair. From there, index \`${CONNECTION_HEALTH_DOC_ID}\`
into Glean with the indexing token and confirm it with \`getdocumentstatus\`: a real
\`"status": "INDEXED"\` response is the actual proof the integration works end to end, not
just an empty \`200\`.
`.trim(),
    };
  },
};

export const t6Scenarios: ScenarioDef[] = [t6Capstone];

