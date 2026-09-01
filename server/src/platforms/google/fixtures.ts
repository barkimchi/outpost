/**
 * Google OAuth mock fixtures (docs/SPEC.md section 7 and section 11). Same convention as
 * `platforms/github/fixtures.ts`: the envelope and wording stay verbatim, only
 * interpolated values vary, and every function carries a `// source:` comment.
 *
 * Hard constraint 3 ("no real credentials, ever. No network egress to real
 * GitHub/Google/Glean/Slack") means none of this was reproduced by an actual
 * authenticated call against a real Google endpoint. The three token-endpoint error
 * bodies are not a problem: docs/SPEC.md section 11 states them verbatim itself, so they
 * are sourced directly from the spec, the same convention `github/fixtures.ts` already
 * uses for the two bodies it took from docs/PLAN.md rather than a live call. Everything
 * else here is marked UNVERIFIED SHAPE and approximated from Google's own public
 * developer documentation plus its well-documented, stable error-envelope conventions
 * (https://cloud.google.com/apis/design/errors), cross-referenced against the extensive,
 * consistent public record of developers hitting these exact errors (Stack Overflow,
 * Google's own issue trackers, and the Google Identity docs), never independently
 * reproduced live.
 */

// --- Token endpoint errors (docs/SPEC.md section 11, given verbatim there) -------------

export interface GoogleTokenError {
  error: string;
  error_description: string;
}

// source: docs/SPEC.md section 11, given verbatim.
export function invalidGrantError(): GoogleTokenError {
  return { error: 'invalid_grant', error_description: 'Bad Request' };
}

// source: docs/SPEC.md section 11, given verbatim.
export function invalidClientError(): GoogleTokenError {
  return { error: 'invalid_client', error_description: 'Unauthorized' };
}

// source: docs/SPEC.md section 11, given verbatim.
export function redirectUriMismatchError(): GoogleTokenError {
  return { error: 'redirect_uri_mismatch', error_description: 'Bad Request' };
}

// UNVERIFIED SHAPE: approximated by pattern-matching the three error bodies docs/SPEC.md
// section 11 gives verbatim (same {error, error_description} envelope). Used only for an
// unrecognized grant_type, which no scenario in this task exercises; kept for a
// realistically complete token endpoint rather than silently 500ing on a bad grant_type.
export function unsupportedGrantTypeError(): GoogleTokenError {
  return { error: 'unsupported_grant_type', error_description: 'Bad Request' };
}

// --- Resource endpoint errors (docs/SPEC.md section 11) --------------------------------

export interface GoogleApiErrorDetail {
  ['@type']: string;
  reason: string;
  domain: string;
  metadata: Record<string, string>;
}

export interface GoogleApiError {
  error: {
    code: number;
    message: string;
    status: string;
    details?: GoogleApiErrorDetail[];
  };
}

// UNVERIFIED SHAPE: approximated. Google's error-envelope conventions are documented at
// https://cloud.google.com/apis/design/errors#error_model (code/message/status). The
// exact `message` text below is the wording widely and consistently reported by
// developers who have hit an expired or invalid OAuth access token against Google APIs
// (Google's own OAuth 2.0 Playground and API Explorer produce it), not independently
// reproduced live here (hard constraint 3).
export function unauthenticatedError(): GoogleApiError {
  return {
    error: {
      code: 401,
      message:
        'Request had invalid authentication credentials. Expected OAuth 2.0 access token, login cookie or other valid authentication credential.',
      status: 'UNAUTHENTICATED',
    },
  };
}

// UNVERIFIED SHAPE: approximated, same reasoning as unauthenticatedError() above. The
// error-envelope shape (code/message/status/details[].reason) and the exact reason string
// ACCESS_TOKEN_SCOPE_INSUFFICIENT are Google's own well-documented, stable convention for
// this exact failure (docs/SPEC.md section 11 names the reason string directly), widely
// corroborated by developer reports; the surrounding message text and metadata fields are
// this mock's own reasonable completion of that envelope, not independently verified
// byte-exact. `method`/`service` are filled in per call site so the detail looks like it
// came from the endpoint that actually rejected the request.
export function accessTokenScopeInsufficientError(method: string, service: string): GoogleApiError {
  return {
    error: {
      code: 403,
      message: 'Request had insufficient authentication scopes.',
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
          domain: 'googleapis.com',
          metadata: { method, service },
        },
      ],
    },
  };
}

// UNVERIFIED SHAPE: approximated, RFC 7009-style, cross-referenced against Google's own
// documented revoke endpoint behavior
// (https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke: "If
// the revocation is successfully processed... the status code of the response is 200. For
// error conditions, a status code 400 is returned along with an error code."). Not
// independently reproduced live (hard constraint 3).
export function invalidTokenError(): GoogleTokenError {
  return { error: 'invalid_token', error_description: 'Invalid Value' };
}

// --- redirect_uri_mismatch HTML page (docs/SPEC.md section 11: "400 HTML page reading
// Error 400: redirect_uri_mismatch") ------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// UNVERIFIED SHAPE: approximated. The title "Error 400: redirect_uri_mismatch" is given
// verbatim by docs/SPEC.md section 11. The body copy below approximates real Google's
// well-known developer-facing error page for this exact condition (widely and
// consistently reported by developers across public bug reports and Stack Overflow
// threads: "does not comply with Google's OAuth 2.0 policy," a "Request details" block
// naming the offending redirect_uri), not independently reproduced live (hard
// constraint 3). No em-dashes, matching the project-wide style rule.
export function redirectUriMismatchPage(requestedUri: string | undefined): string {
  const shown = requestedUri === undefined ? '(missing)' : escapeHtml(requestedUri);
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Error 400: redirect_uri_mismatch</title></head>
<body>
<h1>Error 400: redirect_uri_mismatch</h1>
<p>You can't sign in to this app because it doesn't comply with Google's OAuth 2.0 policy for keeping apps secure.</p>
<p>You can let the app developer know that this app doesn't comply with one or more Google validation rules.</p>
<p>Request details: redirect_uri=${shown}</p>
</body>
</html>`;
}

// --- invalid_client HTML page (Task 6 fix round, finding 5: client binding) ------------

// UNVERIFIED SHAPE: approximated, mirroring redirectUriMismatchPage()'s own
// "Error <code>: <reason>" pattern. docs/SPEC.md section 11 gives "Error 400:
// redirect_uri_mismatch" verbatim but does not separately name an authorize-time
// invalid_client page (only the token endpoint's JSON invalid_client error, already
// sourced above); this HTML page's exact copy is this mock's own reasonable extension of
// that sibling error's format, not independently verified against a real Google page.
export function invalidClientPage(clientId: string | undefined): string {
  const shown = clientId === undefined ? '(missing)' : escapeHtml(clientId);
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Error 401: invalid_client</title></head>
<body>
<h1>Error 401: invalid_client</h1>
<p>The OAuth client in this request is not recognized.</p>
<p>You can let the app developer know that this client_id is not registered.</p>
<p>Request details: client_id=${shown}</p>
</body>
</html>`;
}

// --- Success bodies (not asserted byte-exact by any scenario, same convention as
// github/router.ts's own success bodies) -------------------------------------------

export interface GoogleUserinfoOptions {
  sub: string;
  name: string;
  email: string;
  login: string;
  scopes: string[];
}

// UNVERIFIED SHAPE: approximated from Google's documented OpenID Connect userinfo fields
// (https://developers.google.com/identity/openid-connect/openid-connect#obtaininguserprofileinformation),
// not independently reproduced live. Fields are gated by scope the same way real Google's
// endpoint is: `email`/`email_verified` need the `email` scope, `name`/`given_name`/
// `family_name`/`picture` need `profile`; `sub` is always present with just `openid`.
export function userinfoBody(opts: GoogleUserinfoOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { sub: opts.sub };
  if (opts.scopes.includes('email')) {
    body.email = opts.email;
    body.email_verified = true;
  }
  if (opts.scopes.includes('profile')) {
    const [given, ...rest] = opts.name.split(' ');
    body.name = opts.name;
    body.given_name = given;
    body.family_name = rest.join(' ');
    body.picture = `https://example.com/avatar/${opts.login}.png`;
  }
  return body;
}

// UNVERIFIED SHAPE: approximated from the documented Calendar API v3 CalendarList
// resource shape (https://developers.google.com/calendar/api/v3/reference/calendarList),
// not independently reproduced live.
export function calendarListBody(userEmail: string): Record<string, unknown> {
  return {
    kind: 'calendar#calendarList',
    etag: '"trainer-fake-etag"',
    items: [
      {
        kind: 'calendar#calendarListEntry',
        id: userEmail,
        summary: userEmail,
        primary: true,
        accessRole: 'owner',
      },
    ],
  };
}

// UNVERIFIED SHAPE: approximated from the documented Calendar API v3 Events resource
// shape (https://developers.google.com/calendar/api/v3/reference/events), not
// independently reproduced live. Returns an empty list: no scenario in this task
// exercises event content, only the auth/scope gate in front of the endpoint.
export function calendarEventsBody(calendarId: string): Record<string, unknown> {
  return {
    kind: 'calendar#events',
    etag: '"trainer-fake-etag"',
    summary: calendarId,
    items: [],
  };
}
