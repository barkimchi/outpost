import type { RunContext, ScenarioDef } from '@gym/shared';
import { escapeRegex } from '../engine/match.js';

/**
 * Tier 1 warm-ups (docs/SPEC.md section 12, scenarios 1-3): general REST literacy before
 * the platform-specific lessons in tier 2 and up. All three target the already-mounted
 * `/github` router.
 *
 * `t1-content-type` originally targeted a synthetic `/_trainer/api/warmup/content-type`
 * endpoint, added when `platforms/` was off limits for the original Task 3 build. Fix
 * round: moved onto the real `POST /github/user/repos` endpoint (added to
 * `platforms/github/router.ts` in this fix round) once that constraint lifted, per spec
 * section 5 ("paths under a platform base are byte-identical to the real product's, so a
 * Postman collection built here transfers by swapping one baseUrl").
 *
 * Every ticket, step, and assertion below is built from `RunContext`, never a literal
 * (docs/PLAN.md Global Constraint 5).
 */

const t1WrongMethod: ScenarioDef = {
  id: 't1-wrong-method',
  tier: 1,
  track: 'troubleshoot',
  title: 'Wrong HTTP method',
  platform: 'github',
  docsRef: ['github'],
  build(ctx: RunContext) {
    const ticketMd = `
## Ticket

${ctx.user.name} at ${ctx.company.name} says their nightly script that checks the
authenticated GitHub user keeps failing. The last log line reads:

    HTTP 405 Method Not Allowed

A valid personal access token is already configured: \`${ctx.github.validPat}\`

Figure out what the script is doing wrong and make the request succeed.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'Call GET /github/user with a valid PAT',
          match: { method: ['GET', 'POST'], pathPattern: '^/github/user$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'login', equals: ctx.user.login },
          ],
          attemptHint: 'Read the Allow header on the 405 response you already got.',
        },
      ],
      hints: [
        'Every response header is visible in the Logs tab and the response panel, including the ones on the failed request.',
        'The 405 response includes an Allow header. It names the one method this endpoint actually accepts.',
        `Send GET, not POST, to /github/user with Authorization: token ${ctx.github.validPat}.`,
      ],
      solutionMd: `
## Root cause

The script sent \`POST /github/user\`. \`GET /user\` is a read-only endpoint and does not
accept POST, so GitHub answers 405 Method Not Allowed with an \`Allow: GET\` header naming
the one method that works.

## Fix

Change the request method to GET. The token was never the problem.
`.trim(),
    };
  },
};

const t1Pagination: ScenarioDef = {
  id: 't1-pagination',
  tier: 1,
  track: 'troubleshoot',
  title: 'Pagination',
  platform: 'github',
  docsRef: ['github'],
  build(ctx: RunContext) {
    const pageSize = Number(ctx.vars.pageSize ?? '1');
    const targetRepo = ctx.vars.targetRepo ?? ctx.github.repos[0]?.name ?? '';

    const ticketMd = `
## Ticket

${ctx.company.name}'s deploy dashboard only ever shows the first page of repos, so
\`${targetRepo}\` never shows up even though it exists in the \`${ctx.github.org}\` org.

Valid PAT: \`${ctx.github.validPat}\`

\`GET /user/repos\` supports \`per_page\` and \`page\` query parameters (see the Docs tab).
Use them to fetch a page small enough to prove you found \`${targetRepo}\` deliberately,
not by fetching everything at once.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: `Paginate to find ${targetRepo}`,
          match: { method: 'GET', pathPattern: '^/github/user/repos$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonArrayLength', path: '', max: pageSize },
            { kind: 'bodyMatches', matches: escapeRegex(targetRepo) },
          ],
          attemptHint: `The response must contain ${targetRepo} while also staying at or under ${pageSize} item(s). Set both per_page and page.`,
        },
      ],
      hints: [
        'GitHub paginates list endpoints with per_page and page query parameters, both documented in the Docs tab.',
        `A response with more than ${pageSize} repo(s) in it does not count, even if ${targetRepo} is somewhere in there.`,
        `Try per_page=${pageSize} and step page up from 1 until ${targetRepo} is the item you get back.`,
      ],
      solutionMd: `
## Root cause

The dashboard called \`GET /user/repos\` with no pagination parameters, so it only ever
read the first page (GitHub's default \`per_page\` is 30). \`${targetRepo}\` sits at a
different offset in the org's repo list.

## Fix

Add \`per_page=${pageSize}\` and step \`page\` until the response contains
\`${targetRepo}\`. A real client pages through the full \`Link\` header instead of
guessing a page number.
`.trim(),
    };
  },
};

const t1ContentType: ScenarioDef = {
  id: 't1-content-type',
  tier: 1,
  track: 'troubleshoot',
  title: 'Missing Content-Type',
  platform: 'github',
  docsRef: ['github'],
  build(ctx: RunContext) {
    const ticketMd = `
## Ticket

${ctx.company.name}'s onboarding script tries to create a new GitHub repo and keeps
coming back with a 400. The payload looks fine when you read it out loud.

    POST /github/user/repos
    Authorization: token ${ctx.github.validPat}
    { "name": "new-onboarding-repo" }

Find out what the server is actually objecting to.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
      steps: [
        {
          id: 'step-1',
          title: 'POST JSON with the correct Content-Type',
          match: { method: 'POST', pathPattern: '^/github/user/repos$' },
          assertions: [{ kind: 'status', equals: 201 }],
          attemptHint: 'A 400 here means the server does not think this is JSON. Check the Content-Type header, not the body text.',
        },
      ],
      hints: [
        'Postman only sets Content-Type to application/json automatically when the body type dropdown is set to JSON, not just "raw".',
        'If Content-Type is missing or set to something like text/plain, a JSON-looking body still parses as plain text on the server.',
        'Set the Content-Type header to application/json explicitly, then resend.',
      ],
      solutionMd: `
## Root cause

The request body was valid JSON text, but the \`Content-Type\` header was not
\`application/json\` (missing, or left as \`text/plain\`). GitHub only parses a body as
JSON when the header says so; otherwise it treats the request as if it never got a body
at all, and \`POST /user/repos\` rejects it with 400.

## Fix

Set \`Content-Type: application/json\` explicitly on the request.
`.trim(),
    };
  },
};

export const t1Scenarios: ScenarioDef[] = [t1WrongMethod, t1Pagination, t1ContentType];
