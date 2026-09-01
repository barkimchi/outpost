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

- `POST /api/index/v1/indexdocument`: body `{ "document": { "id": "...", "datasource": "...", "title": "..." } }`. `id` and `datasource` are required.
- `POST /api/index/v1/indexdocuments`: same shape, bulk: `{ "documents": [ {...}, {...} ] }`.
- `GET /api/index/v1/getdocumentstatus?id=...&datasource=...`: returns `{ "id", "datasource", "status": "INDEXED" | "NOT_FOUND" }`.

A document only shows `"status": "INDEXED"` once it has actually been sent through one of
the two indexing endpoints above with a matching `id` and `datasource`; indexing and
searching are separate systems here, so a document your company already has on file
elsewhere is not automatically indexed just because it exists.

### Errors

Every error response is a small envelope:

    { "code": "...", "title": "...", "status": <n>, "detail": "..." }

- `401 authentication_required`: missing token, unrecognized token, or the right token for
  the wrong API.
- `400 invalid_request`: the request body is missing a required field.
