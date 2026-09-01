import { randomBytes } from 'node:crypto';

/**
 * Glean mock fixtures (docs/SPEC.md section 7 and section 12, scenarios 12-13). Same
 * convention as `platforms/github/fixtures.ts` and `platforms/google/fixtures.ts`: the
 * envelope and wording stay verbatim where sourced; only interpolated values vary, and
 * every function carries a `// source:` or `// UNVERIFIED SHAPE:` comment.
 *
 * Hard constraint 3 ("no real credentials, ever ... no network egress to real ...
 * Glean") means none of this was reproduced by an actual authenticated call: Glean has no
 * free-tier sandbox reachable without a paying customer's own instance, so every body here
 * is sourced from Glean's own public developer documentation (developers.glean.com,
 * fetched 2026-08-31) rather than a live response, more so than any other platform in this
 * project. Where the docs did not render a concrete example JSON body (their reference
 * pages are React-rendered and several endpoint detail pages returned empty content to a
 * plain fetch), that is called out explicitly per function rather than guessed at silently.
 *
 * Confirmed from developers.glean.com (2026-08-31):
 * - Client API and Indexing API tokens are separate, Glean-issued credentials; "a Client
 *   API token cannot be used as an Indexing API token" and vice versa
 *   (developers.glean.com/api-info/indexing/authentication/overview). Both use
 *   `Authorization: Bearer <token>` (same page). No example error body for the
 *   cross-token-type failure is shown on that page or any other reachable page; the 401
 *   envelope below is therefore built from Glean's own documented Platform API error
 *   taxonomy, not this specific failure reproduced live.
 * - developers.glean.com/errors/ names the response format "ProblemDetail" (RFC 7807's own
 *   term) and lists `authentication_required -> 401` and `invalid_request -> 400` among 23
 *   stable, machine-readable `ProblemDetail.code` values mapped to HTTP statuses. The page
 *   did not render a full example JSON body (React-rendered, empty on a plain fetch), so
 *   the envelope shape below (code/title/status/detail) is RFC 7807's own standard field
 *   set, approximated, not confirmed byte-exact against Glean's real output.
 * - The search endpoint is `POST /rest/api/v1/search`; a documented working example body is
 *   `{"query": "vacation policy", "pageSize": 10}` (developers.glean.com/client/api/
 *   search/search, corroborated by developers.glean.com/guides/agents/nvidia-example and
 *   the gleanwork Java SDK docs). `query` is real Glean's one confirmed required field.
 */

// --- Error envelope (UNVERIFIED SHAPE throughout; see header) --------------------------

export interface GleanProblemDetail {
  code: string;
  title: string;
  status: number;
  detail: string;
}

// UNVERIFIED SHAPE: approximated. developers.glean.com/errors/ confirms the `code` value
// "authentication_required" maps to HTTP 401 and calls the envelope "ProblemDetail" (RFC
// 7807), but did not render a full example body to this fetch. `detail` below is this
// mock's own reasonable completion of that envelope, worded generically (it deliberately
// does not say WHICH kind of token was wrong, matching hard constraint 7c: the mechanism
// is for the learner to work out, not for the error body to hand over).
export function gleanAuthenticationRequired(detail: string): GleanProblemDetail {
  return {
    code: 'authentication_required',
    title: 'Authentication required',
    status: 401,
    detail,
  };
}

// UNVERIFIED SHAPE: approximated, same reasoning as gleanAuthenticationRequired() above.
// developers.glean.com/errors/ confirms "invalid_request" maps to 400. `detail` is
// deliberately generic (does not name the missing field): docs/SPEC.md section 12 scenario
// t4-malformed-body is "solved by reading the Docs tab," so the error body itself should
// not hand over the exact fix.
export function gleanInvalidRequest(detail: string): GleanProblemDetail {
  return {
    code: 'invalid_request',
    title: 'Invalid request',
    status: 400,
    detail,
  };
}

// UNVERIFIED SHAPE: approximated, same "ProblemDetail" envelope and reasoning as
// gleanAuthenticationRequired()/gleanInvalidRequest() above (developers.glean.com/errors/
// names the response format but did not render a full example body to this fetch). Fix
// round, finding 7: an unmodeled path or method under `/glean` used to fall through to
// the trainer's own generic `{"error":"Not Found","path":"..."}` envelope instead of this
// platform's own idiom, teaching the wrong shape on the commonest real mistake, a path
// typo. `not_found` is not one of the 23 stable `ProblemDetail.code` values the header
// comment's source page confirmed by name, but the envelope shape itself (code/title/
// status/detail) and the general convention of a machine-readable code paired with a
// human title are; this mock's own reasonable completion for a case that page's excerpt
// did not enumerate.
export function gleanNotFound(detail: string): GleanProblemDetail {
  return {
    code: 'not_found',
    title: 'Not Found',
    status: 404,
    detail,
  };
}

// --- Search (docs/SPEC.md section 5: POST /rest/api/v1/search) -------------------------

export interface GleanSearchResult {
  trackingToken: string;
  title: string;
  document: { id: string; datasource: string };
  snippets: Array<{ snippet: string }>;
}

export interface GleanSearchResponse {
  trackingToken: string;
  requestID: string;
  results: GleanSearchResult[];
  hasMoreResults: boolean;
}

// UNVERIFIED SHAPE: approximated from the documented request-side field names
// (developers.glean.com/client/api/search/search: "Successful responses include a
// trackingToken, results array, and requestId"), which is as far as the reachable
// documentation went; the RESULT object's own internal shape (document/snippets nesting)
// is this mock's own reasonable completion, not confirmed against a real response. Not
// asserted byte-exact by any scenario, same convention as every other platform's success
// bodies in this project: only the error fixtures carry that requirement (spec section 7).
export function gleanSearchResponse(
  query: string,
  docs: Array<{ id: string; title: string; body: string; datasource?: string }>,
): GleanSearchResponse {
  const needle = query.trim().toLowerCase();
  const matches = needle === '' ? docs : docs.filter((d) => `${d.title} ${d.body}`.toLowerCase().includes(needle));
  return {
    // node:crypto.randomBytes, not Math.random: matches this project's convention for
    // per-request mint values (platforms/google/oauth.ts's own header comment sets this
    // precedent), since these have no reason to be reproducible from the run's seed.
    trackingToken: `track_${randomBytes(6).toString('hex')}`,
    requestID: `req_${randomBytes(6).toString('hex')}`,
    results: matches.map((d) => ({
      trackingToken: `res_${d.id}`,
      title: d.title,
      // Product-coherence fix round: `d.datasource` is now the caller's REAL datasource
      // (platforms/glean/router.ts's `allSearchableDocs()` always supplies one, for both
      // seeded and live-indexed documents), not a hardcoded placeholder; falls back to
      // 'company-kb' only for a caller that genuinely omits it.
      document: { id: d.id, datasource: d.datasource ?? 'company-kb' },
      snippets: [{ snippet: d.body.slice(0, 160) }],
    })),
    hasMoreResults: false,
  };
}

// --- Chat (docs/SPEC.md section 5: POST /rest/api/v1/chat) ------------------------------

// UNVERIFIED SHAPE: approximated. No scenario in this task exercises this endpoint's
// content; built only so the platform's full URL layout (spec section 5) has SOME healthy
// response rather than a 404, matching the same completeness precedent
// `platforms/google/router.ts` set for the two Calendar endpoints tier 3 does not directly
// exercise either.
export function gleanChatResponse(): Record<string, unknown> {
  return {
    messages: [
      {
        author: 'GLEAN_AI',
        messageType: 'CONTENT',
        fragments: [{ text: 'This mock does not generate real answers; see the Docs tab for the search endpoint instead.' }],
      },
    ],
  };
}

// --- Indexing (docs/SPEC.md section 5: /api/index/v1/*) ---------------------------------

// UNVERIFIED SHAPE: approximated. developers.glean.com/api-info/indexing/authentication/
// overview confirms Indexing API tokens exist and are Bearer-authenticated but the
// specific success/error body shapes for indexdocument/indexdocuments/getdocumentstatus
// were not reachable (404 on the specific reference pages fetched). Real Glean's
// indexdocument is widely reported (Glean's own quickstart guides and third-party
// connector implementations) to return an empty JSON object on success; modeled that way
// here.
export function gleanIndexSuccess(): Record<string, never> {
  return {};
}

export interface GleanDocumentStatus {
  id: string;
  datasource: string;
  status: 'INDEXED' | 'NOT_FOUND';
  title?: string;
  indexedAt?: number;
}

// UNVERIFIED SHAPE: approximated, same reasoning as gleanIndexSuccess() above.
//
// Fix round (task-7 review, finding 2, constraint 7b): `title` and `indexedAt` are real
// fields on `World.glean.indexedDocs`'s records (written by `platforms/glean/router.ts`'s
// indexdocument/indexdocuments handlers) that had zero consumers: nothing ever read them
// back out over HTTP. Wired in here rather than deleted, since a getDocumentStatus-style
// endpoint plausibly reporting when and under what title a document was indexed is a
// reasonable, low-risk completion of this envelope (an indexing status check that could
// not tell you WHEN something was indexed would be a strange lesser cousin of the real
// thing), and it is genuinely reachable: see `platforms/glean/router.test.ts`.
//
// Second fix round (product-coherence: search and indexing status must agree on what is
// "indexed"): `indexedAt` is now OPTIONAL on the input, not required, because
// `platforms/glean/router.ts`'s `allSearchableDocs()` also resolves a SEEDED document
// (part of `World.glean.docs`, never live-indexed this run, so it has no real
// `indexedAt`) to `status: 'INDEXED'` here: a learner who can already find a seeded
// document via search must never see `getdocumentstatus` disagree and call it
// `NOT_FOUND`. A seeded-only match reports `INDEXED` with `indexedAt` simply absent,
// rather than a fabricated timestamp for something that was never actually indexed
// during this run.
export function gleanDocumentStatus(id: string, datasource: string, doc: { title?: string; indexedAt?: number } | undefined): GleanDocumentStatus {
  if (!doc) return { id, datasource, status: 'NOT_FOUND' };
  return { id, datasource, status: 'INDEXED', title: doc.title, indexedAt: doc.indexedAt };
}
