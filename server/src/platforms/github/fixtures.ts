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

// This body matches docs/PLAN.md's Task 2 brief verbatim (message format, documentation_url,
// and status). Not independently reproduced live: doing so needs a real personal access
// token that has actually exhausted its budget, and this project never holds real
// credentials. The rate-limiting anchor at
// https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting documents
// the "API rate limit exceeded for user ID <id>." wording as GitHub's own, which is
// corroborating evidence, not the origin of this exact fixture body.
export function rateLimitExceeded(userId: number): GithubErrorBody {
  return {
    message: `API rate limit exceeded for user ID ${userId}.`,
    documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
    status: '403',
  };
}

// This body matches docs/PLAN.md's Task 2 brief verbatim. Not independently reproduced
// live: doing so needs a genuine personal access token missing a required scope, and this
// project never holds real credentials. Cross-checked instead against GitHub's own
// troubleshooting docs (https://docs.github.com/rest/using-the-rest-api/troubleshooting-the-rest-api)
// and multiple independent GitHub Community Discussion threads quoting this exact
// message, which corroborate the wording without being its origin.
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

// source: live GET https://api.github.com/orgs/this-org-does-not-exist-xyz123/repos
// (verified 2026-08-31): returned exactly this body. Added in the Task 2 fix round: the
// original build reused notFoundFixture() (the get-a-repository anchor) here, which is
// the wrong endpoint's documentation_url for a nonexistent org.
export function orgReposNotFound(): GithubErrorBody {
  return {
    message: 'Not Found',
    documentation_url: 'https://docs.github.com/rest/repos/repos#list-organization-repositories',
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
