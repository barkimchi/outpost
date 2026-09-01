import type { RunContext, ScenarioDef } from '@gym/shared';

/**
 * Tier 4: Glean (docs/SPEC.md section 12, scenarios 12-13). Both target the `/glean`
 * router built in `platforms/glean/{router.ts,fixtures.ts}`. Neither registers a `Fault`
 * (docs/SPEC.md section 7: "prefer state faults"; every scenario shipped so far in this
 * project is a state fault and none is an intercept): both are narrative, in what
 * credential or request body the ticket hands over, the same structural family
 * `t3-redirect-mismatch` and `t3-insufficient-scope` already established for tier 3.
 *
 * Hard constraint 7a ("the ANSWER must be generated too, not only the values"):
 * `t4-token-type` hands over BOTH of the run's two real Glean tokens under neutral
 * "Token 1"/"Token 2" labels, and which one is listed first is drawn from
 * `ctx.vars.gleanTokenOrder` (`engine/generate.ts`), independent of which one is actually
 * the client token: without that draw, the client token (always the fix) would land in
 * the same list position every run, exactly the memorizable shortcut `t2-github.ts`'s own
 * header comment documents finding live in an earlier round of this project.
 * `t4-malformed-body` randomizes WHICH of this mock's two required search-body fields
 * (`ctx.vars.gleanMalformedField`) is missing from the broken body shown in the ticket.
 *
 * Hard constraint 7c (tickets state the symptom, never the mechanism or the fix): neither
 * ticket below says "wrong token type" or "missing field X"; both state only what the
 * caller observed (a 401, or a 400) and what is currently on file. `hints` are exempt from
 * this (scaffolding shown only after a genuine attempt, not the puzzle's opening
 * statement) and stay as revealing as the tier 2/3 precedent already set.
 */

// --- Scenario 12: t4-token-type ----------------------------------------------------------

const t4TokenType: ScenarioDef = {
  id: 't4-token-type',
  tier: 4,
  track: 'troubleshoot',
  title: 'Wrong kind of Glean token',
  platform: 'glean',
  docsRef: ['glean'],
  build(ctx: RunContext) {
    const clientFirst = ctx.vars.gleanTokenOrder !== 'indexing-first';
    const token1 = clientFirst ? ctx.glean.clientToken : ctx.glean.indexingToken;
    const token2 = clientFirst ? ctx.glean.indexingToken : ctx.glean.clientToken;
    const sampleQuery = ctx.glean.docs[0]?.title ?? 'onboarding';

    const ticketMd = `
## Ticket

${ctx.company.name}'s internal search tool calls Glean's search API and just started
getting 401s on every single request, with nothing in the response saying why. Two tokens
are on file for the integration:

- Token 1: \`${token1}\`
- Token 2: \`${token2}\`

Glean instance: \`${ctx.glean.instance}\`

Exactly one of them authenticates against the search endpoint. Find out which, and get a
search for "${sampleQuery}" succeeding with it.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'Search for a real document',
          match: { method: 'POST', pathPattern: '^/glean/rest/api/v1/search$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonArrayLength', path: 'results', min: 1 },
          ],
          // Fix round (task-7 review, minor 5): this used to say only "A 401 here means
          // ...", which misleads on the OTHER way this step's assertion can fail: the
          // working token, sent with a query that matches nothing indexed, is a genuine
          // 200 with an empty results array, not a credential problem at all. Both
          // failure shapes are covered explicitly now, since this same attemptHint text
          // fires for either one (Step.attemptHint has no way to vary by which assertion
          // failed).
          attemptHint:
            'A 401 here means this specific credential is not valid for this specific endpoint, not that both tokens are dead; try the other one. A 200 with zero results means the credential worked but the search text itself did not match anything indexed, which is a different problem entirely.',
        },
      ],
      hints: [
        "Glean issues two separate kinds of token: one for the Client API (search, chat) and one for the Indexing API. Neither one works on the other API, and the 401 does not say which kind it wanted.",
        'See the Docs tab for the request body the search endpoint requires. Send it with each of the two tokens above, as "Authorization: Bearer <token>", and see which one actually returns results.',
      ],
      solutionMd: `
## Root cause

\`${clientFirst ? token2 : token1}\` is an Indexing API token, not a Client API token.
Glean's search endpoint only accepts a Client API token; an Indexing API token, even a
completely valid and unexpired one, gets a generic 401 there, with nothing in the response
naming which kind of credential it wanted instead.

## Fix

Use \`${clientFirst ? token1 : token2}\` (the Client API token) for search and chat, and
reserve the other one for the indexing endpoints, which reject a Client API token the same
way in reverse.
`.trim(),
    };
  },
};

// --- Scenario 13: t4-malformed-body -------------------------------------------------------

const t4MalformedBody: ScenarioDef = {
  id: 't4-malformed-body',
  tier: 4,
  track: 'troubleshoot',
  title: 'Malformed search request',
  platform: 'glean',
  docsRef: ['glean'],
  build(ctx: RunContext) {
    const missingField = ctx.vars.gleanMalformedField === 'pageSize' ? 'pageSize' : 'query';
    const sampleQuery = ctx.glean.docs[0]?.title ?? 'onboarding policy';
    const brokenBody = missingField === 'query' ? { pageSize: 10 } : { query: sampleQuery };
    const fixedBody = { query: sampleQuery, pageSize: 10 };

    const ticketMd = `
## Ticket

${ctx.company.name}'s search automation against Glean started returning 400 errors this
morning, right after someone touched the request body it sends. Here is exactly what it
currently sends to \`POST /rest/api/v1/search\`:

    ${JSON.stringify(brokenBody)}

- Client API token on file: \`${ctx.glean.clientToken}\`
- Glean instance: \`${ctx.glean.instance}\`

Work out what the request body is missing, and get a search actually succeeding.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'Send a well-formed search request',
          match: { method: 'POST', pathPattern: '^/glean/rest/api/v1/search$' },
          // Deliberately status-only, not a result-count check: the lesson is fixing the
          // MALFORMED BODY (docs/SPEC.md section 12: "solved by reading the Docs tab"),
          // not finding a query string that happens to match this run's randomly-drawn
          // documents. When the missing field is `query`, the ticket never reveals a real
          // doc title (unlike t4-token-type, which hands one over on purpose), so a
          // `jsonArrayLength` floor here would silently gate the scenario's completion on
          // a coin flip the learner cannot control. Caught live (task-7 verification):
          // solving with a plausible-but-unmatched query 200'd but never advanced the step.
          assertions: [{ kind: 'status', equals: 200 }],
          attemptHint:
            'A 400 here means the request BODY is invalid, not the token. Check the Docs tab for exactly which fields the search endpoint requires before guessing.',
        },
      ],
      hints: [
        'The 400 response confirms the request is invalid but does not name which field is missing. The Docs tab lists this endpoint\'s full required-field set.',
        `The body above is missing \`${missingField}\`. Add it back, alongside the field already there, and resend.`,
      ],
      solutionMd: `
## Root cause

The request body sent to \`POST /rest/api/v1/search\` was missing the required
\`${missingField}\` field. This mock's search endpoint validates the request body before
doing anything else, so a missing required field never reaches authentication or search
logic at all: it fails fast with a generic 400 naming no specific field.

## Fix

Send both \`query\` (the search text) and \`pageSize\` (how many results to return) in the
request body, for example:

    ${JSON.stringify(fixedBody)}
`.trim(),
    };
  },
};

export const t4Scenarios: ScenarioDef[] = [t4TokenType, t4MalformedBody];
