import type { RunContext, ScenarioDef } from '@gym/shared';
import { escapeRegex } from '../engine/match.js';
import { OLDEST_SLACK_MESSAGE_MARKER } from '../platforms/world.js';
import { BASELINE_GOOGLE_SCOPES, POSTMAN_INTERCEPT_REDIRECT_URI, trainerCallbackRedirectUri } from '../platforms/google/oauth.js';

/**
 * The implementation track (docs/SPEC.md section 12: "Implementation track ... track:
 * 'implementation', no faults"). Four scenarios, one per platform: `impl-github`,
 * `impl-oauth`, `impl-glean`, `impl-slack`. Task 8 brief: "greenfield go-live reps framed
 * in the ticket as new-customer onboarding rather than escalations." Every ticket below
 * describes a company standing up an integration for the first time, never a broken one,
 * and nothing in this file registers a `Fault`: success is simply the right sequence of
 * genuinely successful calls against a healthy World.
 *
 * ## Must be solvable from the Docs tab alone
 *
 * This is the actual test of whether `content/docs/**` is any good (task-8 dispatch).
 * Every step below maps directly onto something `github.md`, `google-oauth.md`, or
 * `glean.md`/`slack.md` states outright: the exact header format for a token, which
 * endpoint needs which kind of credential, the pagination query parameters and the Link
 * header's stop condition, the cursor field name for Slack history. Verified live (see
 * `task-8-report.md`): each scenario solved reading only its own `docsRef` pages, no
 * other file, no source code.
 *
 * ## Hard constraint 7c applies to these tickets too
 *
 * "Describe the goal and the customer situation, not the sequence of calls to make"
 * (task-8 dispatch). None of the four tickets below says "call X then Y then Z"; each
 * states what needs to be TRUE when the work is done (repos visible beyond the first
 * page, access proven via userinfo, documents searchable, a message actually landed and
 * the channel's whole history is readable) and hands over the credentials needed to get
 * there. The Docs tab is where the actual mechanics (headers, query parameters, body
 * shapes) live; the ticket does not duplicate them.
 *
 * ## Hard constraint 7a: no multi-candidate shape exists here, and that is by design
 *
 * There is nothing broken in any of these four scenarios, so there is nothing to guess
 * between: no two candidate tokens, no decoy scope, no ambiguous redirect URI. Every
 * credential handed over is simply the correct one, clearly labeled, because the lesson
 * here is executing a correct sequence from documentation, not diagnosing a fault. This is
 * the same judgment call already made and argued for `t3-revoked-refresh`,
 * `t3-token-expiry`, `t5-hmac-signature`, and this task's own `t6-capstone` (see those
 * files' header comments): manufacturing an artificial guessing puzzle into a scenario
 * with no actual defect would teach the wrong lesson. Per-run regeneration (hard
 * constraint 6) still fully applies and is verified: the company, org, repo set, Glean
 * documents, channel set, and every credential differ on every activation
 * (`impl-track.test.ts`, `DISTRIBUTION_TEST_RUNS >= 14`).
 *
 * ## impl-glean's design (fix round): a NEW document, never a seeded one
 *
 * docs/SPEC.md section 12 describes impl-glean as "index the generated documents, verify
 * they come back from search." A concurrent fix round (out of this task's scope) landed
 * `platforms/glean/router.ts`'s `allSearchableDocs()`, which now genuinely wires indexing
 * into search: both `POST /rest/api/v1/search` and `GET /api/index/v1/getdocumentstatus`
 * read the SAME pool, seeded corpus (`World.glean.docs`) first, live-indexed documents
 * (`World.glean.indexedDocs`) upserted on top. This makes the real round trip possible for
 * the first time, but it also means a SEEDED document (part of the company's existing,
 * pre-run content) reports `"status": "INDEXED"` and turns up in search from the moment
 * the run starts, with nothing indexed. The original version of this scenario graded
 * `ctx.glean.docs[0]`, a seeded id: steps 2 and 3 were both satisfiable with step 1 doing
 * nothing at all (caught live, task-8 fix round finding 2). The fix hands the learner a
 * document this scenario mints itself, `launch-readiness-checklist`, provably absent from
 * the seeded pool: `step-2`'s matcher is pinned to that exact id (`queryIncludes`), so a
 * stray query against a seeded doc's id cannot satisfy it either, and step 3 additionally
 * requires the search RESULT body to contain that id (`bodyMatches`), not merely that
 * something, anything, matched a broad query. Both checks can only pass once step 1's
 * indexing call has genuinely happened this run.
 */

function googleCallbackUrlLines(): string {
  return `Callback URL: \`${trainerCallbackRedirectUri()}\` (built-in UI) or \`${POSTMAN_INTERCEPT_REDIRECT_URI}\` (real Postman desktop, with "Authorize using browser" unchecked)`;
}

// --- impl-github ---------------------------------------------------------------------------

const implGithub: ScenarioDef = {
  id: 'impl-github',
  tier: 2,
  track: 'implementation',
  title: 'GitHub go-live',
  platform: 'github',
  docsRef: ['github', 'auth-methods', 'variables'],
  build(ctx: RunContext) {
    const lastRepo = ctx.github.repos[ctx.github.repos.length - 1];
    if (!lastRepo) throw new Error('impl-github: repo list was unexpectedly empty');

    const ticketMd = `
## Ticket

${ctx.company.name} is going live on the GitHub integration for the first time. Set up
the environment and authentication the way the Docs tab describes, then prove the
integration can actually see everything it needs to in the \`${ctx.github.org}\` org, not
just whatever the first page happens to return.

Personal access token: \`${ctx.github.validPat}\`
Organization: \`${ctx.github.org}\`
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'Authenticate and confirm identity',
          match: { method: 'GET', pathPattern: '^/github/user$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'login', equals: ctx.user.login },
          ],
          attemptHint: 'The Docs tab covers the exact Authorization header format this API accepts.',
        },
        {
          id: 'step-2',
          title: 'Confirm access to the org',
          match: { method: 'GET', pathPattern: `^/github/orgs/${escapeRegex(ctx.github.org)}/repos$` },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonArrayLength', path: '', min: 1 },
          ],
          attemptHint: "List repos for the org named in the ticket, not the authenticated user's own personal repo list.",
        },
        {
          id: 'step-3',
          title: 'Retrieve every repo in the org, not just the first page',
          match: { method: 'GET', pathPattern: `^/github/orgs/${escapeRegex(ctx.github.org)}/repos$` },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonArrayLength', path: '', max: 3 },
            { kind: 'bodyMatches', matches: escapeRegex(lastRepo.name) },
          ],
          attemptHint:
            'A single call at the default page size returns everything at once, which proves nothing about pagination. The Docs tab covers per_page, page, and the Link header that tells you when to stop.',
        },
      ],
      hints: [
        'The Docs tab lists the exact Authorization header formats this API accepts, and which scope the org-repos endpoint needs.',
        'GET /orgs/:org/repos supports per_page and page, same as /user/repos. A response carrying more than a couple of repos at once is not proof you paged through anything.',
        'Follow the Link header\'s rel="next" relation, incrementing page, until it stops appearing. The final page is the one that matters here.',
      ],
      solutionMd: `
## Root cause

Nothing was broken here; this is a straightforward go-live checklist. Authentication,
confirming org access, and proving full pagination are three separate things to verify
before calling an integration done: a token that authenticates does not by itself prove
org access, and a single successful page does not prove every repo is actually reachable.

## Fix

Authenticate with \`Authorization: token ${ctx.github.validPat}\` (or the \`Bearer\` form,
both work), confirm \`GET /orgs/${ctx.github.org}/repos\` returns real data, then page
through it with a small \`per_page\` and an incrementing \`page\` until the \`Link\` header
no longer carries \`rel="next"\`.
`.trim(),
    };
  },
};

// --- impl-oauth ------------------------------------------------------------------------------

const implOauth: ScenarioDef = {
  id: 'impl-oauth',
  tier: 3,
  track: 'implementation',
  title: 'Google OAuth go-live',
  platform: 'google',
  docsRef: ['google-oauth'],
  build(ctx: RunContext) {
    const ticketMd = `
## Ticket

${ctx.company.name} needs its Google OAuth 2.0 integration configured for the very first
time. Set up the OAuth helper the way the Docs tab describes, run through consent, and
confirm the resulting access actually works.

Client ID: \`${ctx.google.clientId}\`
Client secret: \`${ctx.google.clientSecret}\`
Scope: \`${BASELINE_GOOGLE_SCOPES.join(' ')}\`
${googleCallbackUrlLines()}
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'Complete consent and exchange the code for a token',
          match: { method: 'POST', pathPattern: '^/google/oauth2/token$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'access_token', exists: true },
          ],
          attemptHint:
            'Approve the consent screen (approve=1) to get a code on the redirect, then POST it to /google/oauth2/token with grant_type=authorization_code, the same redirect_uri, and both the client id and secret.',
        },
        {
          id: 'step-2',
          title: 'Confirm access via userinfo',
          match: { method: 'GET', pathPattern: '^/google/oauth2/v3/userinfo$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'email', equals: ctx.user.email },
          ],
          attemptHint: 'Send the access_token from the exchange as "Authorization: Bearer <token>".',
        },
      ],
      hints: [
        "The Docs tab lists both registered redirect URIs, exactly as they must appear: an exact string match, not close enough.",
        'The code exchange needs the SAME redirect_uri the consent step used, plus the client id and secret from the ticket.',
        'userinfo needs the access_token from the exchange response, as a Bearer credential.',
      ],
      solutionMd: `
## Root cause

Nothing was broken here; this is a first-time setup, not a repair. The two things worth
proving separately are that the code exchange itself succeeds, and that the resulting
access token actually works against a real protected endpoint.

## Fix

Run consent, approve it, exchange the resulting code with \`grant_type=authorization_code\`
using the client id and secret above and the exact same \`redirect_uri\`, then call
\`GET /oauth2/v3/userinfo\` with the resulting \`access_token\` as a Bearer credential.
`.trim(),
    };
  },
};

// --- impl-glean ------------------------------------------------------------------------------

const NEW_DOC_ID = 'launch-readiness-checklist';

const implGlean: ScenarioDef = {
  id: 'impl-glean',
  tier: 4,
  track: 'implementation',
  title: 'Glean go-live',
  platform: 'glean',
  docsRef: ['glean'],
  build(ctx: RunContext) {
    const docTitle = `${ctx.company.name} Launch Readiness Checklist`;
    const docBody = `Final launch readiness checklist for ${ctx.company.name}, published today and not yet part of the search index.`;

    const ticketMd = `
## Ticket

${ctx.company.name} just published a new internal document and wants it connected to
Glean for the first time. Index it under the company's own datasource, confirm the index
actually picked it up, and confirm employees can find it through search.

Glean instance: \`${ctx.glean.instance}\`
Indexing token: \`${ctx.glean.indexingToken}\`
Search token: \`${ctx.glean.clientToken}\`
Datasource: \`${ctx.glean.datasource}\`
Document: \`${NEW_DOC_ID}\` ("${docTitle}")
Content: "${docBody}"
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'Index the document',
          match: { method: 'POST', pathPattern: '^/glean/api/index/v1/indexdocuments?$' },
          assertions: [{ kind: 'status', equals: 200 }],
          attemptHint:
            'Use the indexing token, not the search token. The Docs tab covers the request body either indexing endpoint needs, including the optional body/text field.',
        },
        {
          id: 'step-2',
          title: 'Confirm the index picked it up',
          match: {
            method: 'GET',
            pathPattern: '^/glean/api/index/v1/getdocumentstatus$',
            // Pinned to THIS document's id, not any query to this endpoint: a seeded
            // (pre-existing) document already reports "INDEXED" from the moment the run
            // starts (platforms/glean/router.ts's allSearchableDocs(), a concurrent fix
            // round, out of this task's scope), so this step must never be satisfiable by
            // querying one of those instead. See this file's header comment.
            queryIncludes: { id: NEW_DOC_ID },
          },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'status', equals: 'INDEXED' },
          ],
          attemptHint: `Query id=${NEW_DOC_ID} and datasource=${ctx.glean.datasource}, the exact pair you just indexed.`,
        },
        {
          id: 'step-3',
          title: 'Confirm the new document is searchable',
          match: { method: 'POST', pathPattern: '^/glean/rest/api/v1/search$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonArrayLength', path: 'results', min: 1 },
            // Requires the RESULT body to actually contain this document's id, not merely
            // that something, anything, matched a broad query: the seeded corpus is
            // searchable from the start, so "results.length >= 1" alone proves nothing
            // about whether this specific document ever got indexed.
            { kind: 'bodyMatches', matches: escapeRegex(NEW_DOC_ID) },
          ],
          attemptHint: `Search using the search token for a real word from "${docTitle}" (not an unrelated term): a query that already matched something before you indexed anything proves nothing about your own document.`,
        },
      ],
      hints: [
        'The Docs tab lists the exact body shape each indexing endpoint requires, including which fields are optional.',
        `getdocumentstatus reports on exactly the id/datasource pair you query: id=${NEW_DOC_ID}, datasource=${ctx.glean.datasource}.`,
        `The search endpoint only accepts the search token. Query a distinctive word from "${docTitle}" and check the result actually names ${NEW_DOC_ID}, not just that some result came back.`,
      ],
      solutionMd: `
## Root cause

Nothing was broken here; this is a first-time connection, not a repair. Indexing a new
document and confirming it is genuinely searchable are two separate things worth proving
independently, the same way they would be in a real rollout: this mock's own pre-existing
company content was already searchable before anything was indexed, so a generic "did
something match" check would have proven nothing about THIS document specifically.

## Fix

\`POST /api/index/v1/indexdocuments\` (or \`/indexdocument\`) with the indexing token and
\`${NEW_DOC_ID}\`, confirm with \`GET /api/index/v1/getdocumentstatus?id=${NEW_DOC_ID}\`
that the index genuinely has it, and confirm \`POST /rest/api/v1/search\` with the search
token returns it by name.
`.trim(),
    };
  },
};

// --- impl-slack ------------------------------------------------------------------------------

const implSlack: ScenarioDef = {
  id: 'impl-slack',
  tier: 5,
  track: 'implementation',
  title: 'Slack go-live',
  platform: 'slack',
  docsRef: ['slack'],
  build(ctx: RunContext) {
    const channel = ctx.slack.channels[0];
    if (!channel) throw new Error('impl-slack: channel list was unexpectedly empty');

    const ticketMd = `
## Ticket

${ctx.company.name} is going live on its Slack integration. Get the bot posting into
#${channel.name} for the first time, and pull back that channel's complete message
history.

Bot token: \`${ctx.slack.botToken}\`
Channel: \`${channel.id}\` (#${channel.name})
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'Join the channel',
          match: { method: 'POST', pathPattern: '^/slack/api/conversations\\.join$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'ok', equals: true },
          ],
          attemptHint: 'Send { "channel": "..." } with the channel id from the ticket.',
        },
        {
          id: 'step-2',
          title: 'Post the first message',
          match: { method: 'POST', pathPattern: '^/slack/api/chat\\.postmessage$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'ok', equals: true },
          ],
          attemptHint: 'Slack answers every outcome with HTTP 200. Check the "ok" field, not only the status code, to confirm the post actually landed.',
        },
        {
          id: 'step-3',
          title: 'Pull the complete channel history',
          match: { method: 'GET', pathPattern: '^/slack/api/conversations\\.history$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'ok', equals: true },
            { kind: 'jsonPath', path: 'has_more', equals: false },
            { kind: 'bodyMatches', matches: escapeRegex(OLDEST_SLACK_MESSAGE_MARKER) },
          ],
          attemptHint:
            'This endpoint only returns a handful of messages per call. Follow response_metadata.next_cursor as the next "cursor" query parameter, repeatedly, until has_more is false.',
        },
      ],
      hints: [
        'conversations.join is safe to call even if the bot already belongs to the channel; it just reports a warning instead of failing.',
        'A 200 status from any of these endpoints never means the call succeeded on its own. Check the "ok" field of the body first.',
        'Follow response_metadata.next_cursor as the cursor parameter, repeatedly, until has_more comes back false, to see the entire history.',
      ],
      solutionMd: `
## Root cause

Nothing was broken here; this is a first-time connection. Joining, posting, and reading
back the full history are three separate things worth proving independently: a
successful post does not by itself prove the history is fully readable, since this
endpoint only ever returns a handful of messages per call.

## Fix

\`POST /api/conversations.join\` with \`channel: "${channel.id}"\`, then
\`POST /api/chat.postMessage\` with the same channel id, then page
\`GET /api/conversations.history\` with the \`cursor\` query parameter, following
\`response_metadata.next_cursor\` from each response until \`has_more\` is \`false\`.
`.trim(),
    };
  },
};

export const implScenarios: ScenarioDef[] = [implGithub, implOauth, implGlean, implSlack];
