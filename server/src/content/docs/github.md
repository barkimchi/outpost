## GitHub REST API (mock)

This mock mirrors `https://api.github.com` closely enough that a collection you build
against it transfers to the real API by swapping one `baseUrl` variable. Set an environment
variable `baseUrl` to `http://127.0.0.1:4600/github` and every path below works unchanged
against real GitHub if you swap it to `https://api.github.com`.

### Authentication

Send a personal access token in the `Authorization` header. Both forms work:

    Authorization: token YOUR_TOKEN
    Authorization: Bearer YOUR_TOKEN

A missing or invalid token returns `401 Bad credentials` on every endpoint below, regardless of what the request actually asked for. The message alone never tells you whether a token is malformed, expired, or revoked. If you have more than one candidate token, the only way to know which one works is to test each one directly.

### Endpoints

- `GET /user`: the authenticated user's profile. No scope required.
- `GET /user/repos`: repositories the authenticated user can see. Supports pagination.
- `POST /user/repos`: create a repository. Body must be JSON, `{"name": "...", "private": true}`. Requires `Content-Type: application/json`.
- `GET /repos/:owner/:repo`: a single repository. A private repo the token cannot see returns 404, not 403.
- `GET /orgs/:org/repos`: repositories in an organization. Requires the `read:org` scope.
- `GET /notifications`: the authenticated user's notifications. Requires the `notifications` scope.
- `GET /rate_limit`: the current rate-limit budget for the token used. Checking it does not consume budget.

`POST /user/repos` sent without `Content-Type: application/json` returns `400 Problems parsing JSON`; sent with that header but a missing `name` field returns `422 Validation Failed`.

### Pagination

`GET /user/repos` and `GET /orgs/:org/repos` accept two query parameters:

- `per_page`: results per page, default 30, maximum 100.
- `page`: 1-indexed page number, default 1.

The response carries a `Link` header naming the other pages that exist, using the standard `rel="next"`, `rel="prev"`, `rel="first"`, `rel="last"` relations, for example:

    Link: <http://127.0.0.1:4600/github/user/repos?per_page=30&page=2>; rel="next"

A relation is only present when it points somewhere real: page 1 has no `rel="prev"`, and the last page has no `rel="next"`. To page through every result, follow `rel="next"` until it stops appearing, or increment `page` until the response comes back with fewer than `per_page` items.

### Rate limiting

Every authenticated response carries these headers:

- `x-ratelimit-limit`: total budget for this token.
- `x-ratelimit-remaining`: requests left before the budget resets.
- `x-ratelimit-reset`: unix timestamp of when the budget refills.
- `x-ratelimit-used`: requests already spent this window.

When `x-ratelimit-remaining` hits 0, further requests return 403 with the same headers and a body like `"API rate limit exceeded for user ID <id>."`. This is not a permissions problem: the token is fine, it is simply out of requests until the reset time. If you have more than one candidate token on file, check each one's remaining budget before assuming anything else is broken.

### Scopes

Every authenticated response also carries:

- `x-oauth-scopes`: the scopes the token used actually has.
- `x-accepted-oauth-scopes`: the scopes this specific endpoint requires, empty if none.

When a token is missing a required scope, the endpoint returns `403 Resource not accessible by personal access token`. Compare `x-oauth-scopes` against `x-accepted-oauth-scopes` on the failing response to see exactly what is missing; do not guess from the endpoint name alone, since `GET /orgs/:org/repos` and `GET /notifications` require two different, unrelated scopes (`read:org` and `notifications`).

### A private repo is not always what it looks like

`GET /repos/:owner/:repo` on a private repository the token cannot see returns `404 Not Found`, not `403 Forbidden`. Real GitHub does this on purpose, so a token without access cannot even confirm whether a private repo exists. If a repo you know exists suddenly 404s, check whether the token you are using still carries the `repo` scope before assuming the repo itself was deleted or renamed. The same filtering applies to `GET /user/repos` and `GET /orgs/:org/repos`: a token missing `repo` will not see the private repo in either list either.

### Common error bodies

    401  { "message": "Bad credentials", "documentation_url": "...", "status": "401" }
    403  { "message": "API rate limit exceeded for user ID <id>.", ... }
    403  { "message": "Resource not accessible by personal access token", ... }
    404  { "message": "Not Found", "documentation_url": "...", "status": "404" }
