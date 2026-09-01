/**
 * GitHub error fixtures (docs/SPEC.md section 7): "the envelope and wording stay
 * verbatim; only interpolated values ... vary." Each function below carries a
 * `// source:` comment with what was checked and when.
 *
 * Bodies below were checked live against https://api.github.com on 2026-08-31 where a
 * genuine unauthenticated or bad-credential request could produce them without needing a
 * real personal access token (this project uses no real credentials, ever, per hard
 * constraint 3, so only responses reachable without a valid token were reproduced live).
 * Where that was not possible, the body is instead sourced from GitHub's own public
 * documentation and cross-checked against independent third-party reports quoting the
 * identical text, and marked accordingly.
 */

export interface GithubErrorBody {
  message: string;
  documentation_url: string;
  status: string;
}

// source: live GET https://api.github.com/user with an invalid Bearer token
// (verified 2026-08-31): returned exactly this body.
export function badCredentials(): GithubErrorBody {
  return {
    message: 'Bad credentials',
    documentation_url: 'https://docs.github.com/rest',
    status: '401',
  };
}

// source: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
// (verified 2026-08-31). The message format ("API rate limit exceeded for user ID <id>.")
// is GitHub's documented wording for an authenticated request; the documentation_url is
// the rate-limiting anchor on that same page.
export function rateLimitExceeded(userId: number): GithubErrorBody {
  return {
    message: `API rate limit exceeded for user ID ${userId}.`,
    documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
    status: '403',
  };
}

// source: https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
// (verified 2026-08-31), cross-checked against multiple independent GitHub Community
// Discussion threads quoting this exact body for personal access tokens missing a
// required scope. Could not be reproduced live here without a genuine PAT lacking that
// scope, since this project never holds real credentials.
export function resourceNotAccessible(): GithubErrorBody {
  return {
    message: 'Resource not accessible by personal access token',
    documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository',
    status: '403',
  };
}

// source: live GET https://api.github.com/repos/octocat/this-repo-does-not-exist-xyz
// (verified 2026-08-31): returned exactly this body.
export function notFoundFixture(): GithubErrorBody {
  return {
    message: 'Not Found',
    documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository',
    status: '404',
  };
}

// UNVERIFIED SHAPE: approximated. A live check against api.github.com (PUT
// /repos/octocat/Hello-World and DELETE /rate_limit, both unauthenticated, 2026-08-31)
// showed real GitHub actually answers an unsupported method on a GET-only path with 404
// "Not Found", not 405: its router has no route registered for that verb at all, so there
// is no real 405 body to source byte-exact. docs/SPEC.md section 12 scenario
// t1-wrong-method and docs/PLAN.md's Task 2 brief both deliberately specify the
// textbook-correct REST behavior (405 with an Allow header) instead, as the lesson for
// that warm-up scenario, so this mock intentionally diverges from live GitHub here.
export function methodNotAllowedFixture(): { message: string; documentation_url: string } {
  return {
    message: 'Method Not Allowed',
    documentation_url: 'https://docs.github.com/rest',
  };
}
