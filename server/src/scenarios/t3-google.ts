import type { RunContext, ScenarioDef } from '@gym/shared';
import {
  BASELINE_GOOGLE_SCOPES,
  CALENDAR_EVENTS_DECOY_SCOPE,
  CALENDAR_READONLY_SCOPE,
  POSTMAN_INTERCEPT_REDIRECT_URI,
  mintAccessToken,
  mintRefreshToken,
  registeredRedirectUris,
  resolveWrongRedirectUri,
  trainerCallbackRedirectUri,
} from '../platforms/google/oauth.js';

/**
 * Tier 3: Google OAuth (docs/SPEC.md section 12, scenarios 8-11). The riskiest module in
 * the project (task-6 brief). All four scenarios target the `/google` router built in
 * `platforms/google/{oauth.ts,consent.ts,router.ts,fixtures.ts}`.
 *
 * None of the four registers a `Fault`. Per docs/SPEC.md section 7, "prefer state faults";
 * every one of scenarios 1-7 is a state fault mutating a pre-existing token record. Tier 3
 * is structurally different: the whole point of this tier is PRACTICING the live OAuth
 * mechanics (consent, exchange, refresh, revoke) rather than picking the right one of two
 * already-issued credentials, so "breakage" here is either (a) narrative, in what
 * configuration value the ticket hands over for the learner to notice is wrong
 * (`t3-redirect-mismatch`, `t3-insufficient-scope`), or (b) a starting World state built
 * directly by `setup` (`t3-token-expiry`'s short TTL, `t3-revoked-refresh`'s pre-dead
 * refresh token) rather than a mutation layered onto an otherwise-healthy baseline. There
 * is nothing for any of the four to `clearFaults`, since none registers a fault to clear.
 *
 * Hard constraint 7a ("the ANSWER must be generated too, not only the values"):
 * `t3-redirect-mismatch` randomizes WHICH of six near-miss decoy URIs is shown as the
 * current (wrong) configuration (`engine/generate.ts`'s `wrongRedirectVariant`);
 * `t3-insufficient-scope` randomizes WHETHER the current scope string is missing the
 * calendar scope entirely or carries a real, distinct, plausible-looking decoy scope
 * instead (`insufficientScopeVariant`); `t3-token-expiry` randomizes WHICH short TTL its
 * `setup` installs (`shortAccessTokenTtlSec`, fix round: was fixed at 15 across every
 * activation). `t3-revoked-refresh` has no analogous multi-candidate "pick the right one"
 * shape to memorize a position from: its two credentials are not interchangeable
 * candidates the learner picks between (unlike, say, t2's two PATs), they are genuinely
 * different halves of one grant with a fixed procedural fix, so per-run variance there is
 * limited to the generated values already required by hard constraint 6 (seed/company/
 * client credentials/pre-existing token strings, all fresh every run); see
 * `t3-google.test.ts` and the task-6 report for the live distribution evidence and the
 * same reasoning precedent set for `t2-private-404` in `task-3-report.md`.
 *
 * Fix round: ticket audit. Every ticket below states the SYMPTOM and whatever EVIDENCE the
 * mock's own real error responses would show a learner who actually tried the flow, but
 * never NAMES the underlying mechanism or PRESCRIBES the fix in so many words (spec review
 * finding: `t3-token-expiry`'s ticket used to state the exact TTL and literally instruct
 * "use the refresh token... do not start the whole consent flow over," leaving nothing to
 * diagnose). `attemptHint` and `hints` are exempt from this: both are scaffolding shown
 * only in response to (or in exchange for) a genuine attempt, not the puzzle's opening
 * statement, and stay as revealing as they already were.
 */

const [REGISTERED_URI_A, REGISTERED_URI_B] = registeredRedirectUris();

function callbackUrlLines(): string {
  return `Callback URL: \`${trainerCallbackRedirectUri()}\` (built-in UI) or \`${POSTMAN_INTERCEPT_REDIRECT_URI}\` (real Postman desktop, with "Authorize using browser" unchecked)`;
}

// --- Scenario 8: t3-redirect-mismatch ---------------------------------------------------

const t3RedirectMismatch: ScenarioDef = {
  id: 't3-redirect-mismatch',
  tier: 3,
  track: 'troubleshoot',
  title: 'Wrong redirect URI',
  platform: 'google',
  docsRef: ['google-oauth'],
  build(ctx: RunContext) {
    const wrongUri = resolveWrongRedirectUri(ctx.vars.wrongRedirectVariant ?? 'localhost-no-trainer-prefix');

    const ticketMd = `
## Ticket

${ctx.company.name}'s OAuth helper for Google keeps failing at the very first step: the
redirect never lands anywhere useful.

Client ID: \`${ctx.google.clientId}\`
Client secret: \`${ctx.google.clientSecret}\`
Scope: \`${BASELINE_GOOGLE_SCOPES.join(' ')}\`
Callback URL configured in the OAuth helper: \`${wrongUri}\`

For reference, this app has exactly two redirect URIs registered with Google:
\`${REGISTERED_URI_A}\` and \`${REGISTERED_URI_B}\`.

Get this working end to end: complete consent, exchange the resulting code for a token,
and confirm access by calling the userinfo endpoint.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: "Point the OAuth helper at a registered redirect_uri",
          // Fix round, finding 1: the wrong-URI failure is a GET (the consent page never
          // renders at all, 400, so there is nothing to POST). `method: 'POST'` alone left
          // that entire failure path invisible to the engine: three wrong GETs produced
          // zero attempts and never unlocked a hint. Widened to both methods; the
          // 't3-redirect-progress' custom assertion (engine/assert.ts) handles the two
          // different success shapes (GET renders 200 with no Location header at all,
          // POST-approve redirects 302 WITH one) without false-failing a correct GET or
          // false-passing a POST that merely denied consent.
          match: { method: ['GET', 'POST'], pathPattern: '^/google/o/oauth2/v2/auth$' },
          assertions: [{ kind: 'custom', id: 't3-redirect-progress' }],
          attemptHint:
            'A redirect_uri_mismatch page (on either the initial GET or the consent POST) means the callback URL sent to Google does not exactly match one of the two registered ones. Compare it character by character, including the scheme and any trailing slash.',
        },
        {
          id: 'step-2',
          title: 'Exchange the code for a token',
          match: { method: 'POST', pathPattern: '^/google/oauth2/token$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'access_token', exists: true },
          ],
          attemptHint: 'The token exchange must send the exact same redirect_uri the authorize step used, or Google answers redirect_uri_mismatch here too.',
        },
        {
          id: 'step-3',
          title: 'Confirm access via userinfo',
          match: { method: 'GET', pathPattern: '^/google/oauth2/v3/userinfo$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'email', equals: ctx.user.email },
          ],
          attemptHint: 'Send the access token from the previous step as "Authorization: Bearer <token>".',
        },
      ],
      hints: [
        'Google validates redirect_uri as an exact string match, not "close enough": a trailing slash, http vs https, or a wrong port number all count as a completely different URI.',
        `Exactly two URIs are registered: ${REGISTERED_URI_A} and ${REGISTERED_URI_B}. Anything else, including the value currently configured, gets a 400 page.`,
        'Once the callback URL matches exactly, the code Google issues works normally: exchange it, then call userinfo with the resulting access token.',
      ],
      solutionMd: `
## Root cause

The OAuth helper's callback URL, \`${wrongUri}\`, is not one of the two URIs actually
registered for this app. Google validates \`redirect_uri\` as an exact string match at
both the consent step and the token exchange, so a near-miss (wrong scheme, a missing or
extra trailing slash, a dropped path segment, or a wrong port number) fails the same way
a completely unrelated URL would.

## Fix

Set the callback URL to \`${REGISTERED_URI_A}\` (real Postman desktop, "Authorize using
browser" unchecked) or \`${REGISTERED_URI_B}\` (the built-in UI), then complete consent,
exchange the code, and call userinfo with the resulting access token.
`.trim(),
    };
  },
};

// --- Scenario 9: t3-token-expiry ---------------------------------------------------------

const t3TokenExpiry: ScenarioDef = {
  id: 't3-token-expiry',
  tier: 3,
  track: 'troubleshoot',
  title: 'Access token expires mid-flow',
  platform: 'google',
  docsRef: ['google-oauth'],
  build(ctx: RunContext) {
    // Fix round, finding 6: drawn per run instead of a fixed literal (was 15 across every
    // activation, and the ticket used to name it outright). Neither the number nor the
    // word "TTL"/"refresh" appears in ticketMd below; only the symptom does.
    const ttlSec = Number(ctx.vars.shortAccessTokenTtlSec ?? '15');

    const ticketMd = `
## Ticket

${ctx.company.name}'s calendar sync integration is being connected for the first time.

Client ID: \`${ctx.google.clientId}\`
Client secret: \`${ctx.google.clientSecret}\`
Scope: \`${BASELINE_GOOGLE_SCOPES.join(' ')}\`
${callbackUrlLines()}

Complete the consent flow and confirm access via userinfo. Access holds for a little
while and then falls over on its own, with nothing else about the request or the
credentials changing in between. Get it reconnecting reliably.
`.trim();

    return {
      ticketMd,
      // Task 6 fix round: overrides World.google.accessTokenTtlSec for THIS scenario
      // only, without touching generate()'s baseline (3600 everywhere else). See
      // engine.ts's activateDef() comment on why `setup` had to be wired in for this to
      // work at all.
      setup: [(w) => { w.google.accessTokenTtlSec = ttlSec; }],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'Confirm the freshly issued access token works',
          match: { method: 'GET', pathPattern: '^/google/oauth2/v3/userinfo$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'email', equals: ctx.user.email },
          ],
          attemptHint: `Use the access token from the token exchange as "Authorization: Bearer <token>", right away: this step must succeed within the token's short (${ttlSec} second) lifetime.`,
        },
        {
          id: 'step-2',
          title: 'Get a new access token once the old one dies',
          match: { method: 'POST', pathPattern: '^/google/oauth2/token$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'access_token', exists: true },
          ],
          attemptHint: 'By now the first access token is almost certainly dead. Send grant_type=refresh_token with the refresh token from the original exchange rather than restarting consent.',
        },
      ],
      hints: [
        `Access tokens for this integration currently live for only ${ttlSec} seconds: complete the consent-to-userinfo path in one continuous pass, without stopping to read documentation in between.`,
        'The original token exchange already returned a refresh_token alongside the access_token. Save it.',
        'POST to the same token endpoint again, this time with grant_type=refresh_token and refresh_token set to the value you saved, to mint a new access token without a new consent screen.',
      ],
      solutionMd: `
## Root cause

Access tokens for this integration carry an unusually short, ${ttlSec} second lifetime
right now. The first access token from the consent flow genuinely works, briefly, then
expires like any other access token; nothing else about the request or the credentials
was ever wrong.

## Fix

Use the \`refresh_token\` grant (\`grant_type=refresh_token\`, with the \`refresh_token\`
returned alongside the original access token) to mint a fresh access token, instead of
repeating the whole consent flow.
`.trim(),
    };
  },
};

// --- Scenario 10: t3-revoked-refresh ------------------------------------------------------

const t3RevokedRefresh: ScenarioDef = {
  id: 't3-revoked-refresh',
  tier: 3,
  track: 'troubleshoot',
  title: 'Refresh token already revoked',
  platform: 'google',
  docsRef: ['google-oauth'],
  build(ctx: RunContext) {
    const existingAccessToken = mintAccessToken();
    const existingRefreshToken = mintRefreshToken();
    const scopes = [...BASELINE_GOOGLE_SCOPES];

    const ticketMd = `
## Ticket

${ctx.company.name}'s nightly calendar sync integration was connected a while back and
its credentials are on file:

- Access token: \`${existingAccessToken}\`
- Refresh token: \`${existingRefreshToken}\`
- Client ID: \`${ctx.google.clientId}\`
- Client secret: \`${ctx.google.clientSecret}\`
${callbackUrlLines()}
Scope: \`${scopes.join(' ')}\`

Ops ran a credential rotation sweep last week and this integration was never reconnected
afterward. Confirm what's actually broken, then get it fully reconnected.
`.trim();

    return {
      ticketMd,
      setup: [
        (w) => {
          w.google.issuedTokens[existingAccessToken] = {
            scopes,
            expiresAt: Math.floor(Date.now() / 1000) + w.google.accessTokenTtlSec,
            pairedRefreshToken: existingRefreshToken,
          };
          // The rotation itself: this refresh token is already dead before the learner
          // ever touches it, mirroring "ops rotated it during the sweep."
          w.google.refreshTokens[existingRefreshToken] = { scopes, clientId: ctx.google.clientId, revoked: true };
        },
      ],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'Confirm the access token still works',
          match: { method: 'GET', pathPattern: '^/google/oauth2/v3/userinfo$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'email', equals: ctx.user.email },
          ],
          attemptHint: 'The access token on file in the ticket is real. Send it as "Authorization: Bearer <token>" before assuming the whole integration is dead.',
        },
        {
          id: 'step-2',
          title: 'Reconnect with a genuinely valid refresh token',
          match: { method: 'POST', pathPattern: '^/google/oauth2/token$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'access_token', exists: true },
          ],
          attemptHint:
            'The refresh token on file is already revoked: a refresh_token grant against it returns invalid_grant no matter how many times you retry it. The fix is a brand new consent (grant_type=authorization_code), not a retry of the same refresh call.',
        },
      ],
      hints: [
        'The access token and the refresh token on file are two separate credentials. One of them still works.',
        'invalid_grant on a refresh_token grant, with the exact refresh token from the ticket, is not a typo to fix. That specific refresh token is gone for good.',
        'Run the full consent flow again (a new authorization code, exchanged with grant_type=authorization_code) to get a brand new access/refresh pair.',
      ],
      solutionMd: `
## Root cause

The refresh token on file, \`${existingRefreshToken}\`, was revoked during ops's
credential rotation sweep. The access token issued alongside it still works until it
naturally expires, which is why the integration looked partially fine; the moment
something needed to refresh, \`POST /google/oauth2/token\` with
\`grant_type=refresh_token\` returned \`invalid_grant\`, and no amount of retrying the
same refresh token changes that.

## Fix

Run the consent flow again to get a brand new authorization code, then exchange it with
\`grant_type=authorization_code\` for a fresh access/refresh pair. A revoked refresh
token cannot be un-revoked; only a new consent produces one that works.
`.trim(),
    };
  },
};

// --- Scenario 11: t3-insufficient-scope ---------------------------------------------------

const t3InsufficientScope: ScenarioDef = {
  id: 't3-insufficient-scope',
  tier: 3,
  track: 'troubleshoot',
  title: 'Insufficient OAuth scope',
  platform: 'google',
  docsRef: ['google-oauth'],
  build(ctx: RunContext) {
    const variant = ctx.vars.insufficientScopeVariant === 'decoy' ? 'decoy' : 'missing';
    const currentScopes =
      variant === 'decoy' ? [...BASELINE_GOOGLE_SCOPES, CALENDAR_EVENTS_DECOY_SCOPE] : [...BASELINE_GOOGLE_SCOPES];
    const currentScopeStr = currentScopes.join(' ');
    const existingAccessToken = mintAccessToken();

    const ticketMd = `
## Ticket

${ctx.company.name}'s calendar sync integration calls Google's calendar list endpoint
and gets back a 403 with \`ACCESS_TOKEN_SCOPE_INSUFFICIENT\`.

Client ID: \`${ctx.google.clientId}\`
Client secret: \`${ctx.google.clientSecret}\`
${callbackUrlLines()}
Currently issued access token: \`${existingAccessToken}\`
Scope string the OAuth helper is currently configured to request: \`${currentScopeStr}\`

Work out what's missing and get the calendar list call succeeding.
`.trim();

    return {
      ticketMd,
      setup: [
        (w) => {
          w.google.issuedTokens[existingAccessToken] = {
            scopes: currentScopes,
            expiresAt: Math.floor(Date.now() / 1000) + w.google.accessTokenTtlSec,
          };
        },
      ],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: "List the user's calendars",
          // Lowercase, matching pathLower (docs/SPEC.md section 6): the real path segment
          // is "calendarList" but the engine matches on the lowercased path, never the
          // verbatim one (match.ts's own header comment warns about exactly this trap).
          match: { method: 'GET', pathPattern: '^/google/calendar/v3/users/me/calendarlist$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonArrayLength', path: 'items', min: 1 },
          ],
          attemptHint:
            variant === 'decoy'
              ? "The configured scope string does include a calendar-related scope, but not the right one. Read error.details[0].reason on the 403 and compare it against the exact scope string, don't just check whether a calendar scope is present."
              : 'The configured scope string has no calendar scope in it at all. An access token can only carry scopes it was actually granted at consent time.',
        },
      ],
      hints: [
        'A 403 with ACCESS_TOKEN_SCOPE_INSUFFICIENT names exactly which scope was required, in error.details[0].reason on the response body.',
        `The calendar list endpoint specifically needs ${CALENDAR_READONLY_SCOPE}. Compare that exact string against the scope configuration above.`,
        "Add the missing scope to the OAuth helper's scope field, then run consent again for a brand new token: the existing access token cannot gain a scope after the fact.",
      ],
      solutionMd: `
## Root cause

${
  variant === 'decoy'
    ? `The configured scope string includes \`${CALENDAR_EVENTS_DECOY_SCOPE}\`, a real Google Calendar scope, but it covers reading and writing events, not listing calendars. It does not grant access to the calendar list endpoint.`
    : 'The configured scope string never requested a calendar scope at all.'
} \`${existingAccessToken}\` was issued with exactly the scopes shown above, so it can
never see the calendar list, however many times the call is retried.

## Fix

Add \`${CALENDAR_READONLY_SCOPE}\` to the OAuth helper's scope configuration and run
consent again. The new access token, not the old one, carries the scope the calendar
list endpoint needs.
`.trim(),
    };
  },
};

export const t3Scenarios: ScenarioDef[] = [t3RedirectMismatch, t3TokenExpiry, t3RevokedRefresh, t3InsufficientScope];
