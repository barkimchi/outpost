## Glean API (mock)

This mock lives under `/glean` and mirrors Glean's real Client API (search, chat) and
Indexing API closely enough to practice the mechanics that trip people up in production:
which token goes where, and what a validation error actually requires.

### Two separate kinds of token

Glean issues two entirely separate credentials. Neither works on the other API, and a
401 from using the wrong one names no specifics about why.

- **Client API token**: `POST /rest/api/v1/search`, `POST /rest/api/v1/chat`.
- **Indexing API token**: `POST /api/index/v1/indexdocument`, `POST /api/index/v1/indexdocuments`, `GET /api/index/v1/getdocumentstatus`.

Both are sent the same way: `Authorization: Bearer YOUR_TOKEN`. If a search call 401s and
the token looks otherwise valid, it may simply be the wrong kind for this endpoint.

### Searching

`POST /rest/api/v1/search` requires a JSON body with:

- `query` (string, required): the search text.
- `pageSize` (number, required): how many results to return.

Both fields are required by this mock. A request missing either one returns `400` with a
generic validation error naming no specific field; check this list, not the error body,
to know what to add back.

    { "query": "vacation policy", "pageSize": 10 }

A successful response includes a `results` array (possibly empty, if nothing matches the
query) plus `trackingToken` and `requestID`.

### Indexing

- `POST /api/index/v1/indexdocument`: body `{ "document": { "id": "...", "datasource": "...", "title": "...", "body": "..." } }`. `id` and `datasource` are required; `title` and `body` are both optional, but a document with neither has no real text for search to match against. `body` accepts either a plain string, or the `{ "mimeType": "...", "textContent": "..." }` shape real Glean's API documents; either way it becomes searchable text alongside the title.
- `POST /api/index/v1/indexdocuments`: same shape, bulk: `{ "documents": [ {...}, {...} ] }`.
- `GET /api/index/v1/getdocumentstatus?id=...&datasource=...`: returns `{ "id", "datasource", "status": "INDEXED" | "NOT_FOUND" }`, plus `title` and `indexedAt` when indexed.

Indexing a document whose `id` already exists in this instance updates it in place,
rather than creating a duplicate.

Search and `getdocumentstatus` read the exact same pool of documents here, so the two can
never disagree: if one says a document is indexed, the other can find it too. That pool
starts with whatever your company already had on file when this run began (already
searchable, already reporting `"status": "INDEXED"`, with nothing indexed yet this run)
and grows as `indexdocument`/`indexdocuments` add or update entries in it. A document
showing `"status": "INDEXED"` therefore does not by itself prove YOUR most recent
indexing call did anything: check that the `id` you are querying, and the `title` or
snippet a search call returns, are actually the ones you just sent.

### Errors

Every error response is a small envelope:

    { "code": "...", "title": "...", "status": <n>, "detail": "..." }

- `401 authentication_required`: missing token, unrecognized token, or the right token for
  the wrong API.
- `400 invalid_request`: the request body is missing a required field.
