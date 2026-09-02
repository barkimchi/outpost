import type { Request, Response } from 'express';

/**
 * `GET /_trainer/oauth/callback` (docs/SPEC.md section 10: "HTML that postMessages to the
 * opener"; section 11: this is the built-in UI's registered redirect URI). Task 6 fix
 * round: this endpoint was the coordinator's own scoping gap in the original dispatch, not
 * something the original round skipped by choice. `http://localhost:<PORT>/_trainer/oauth/
 * callback` was already a genuinely REGISTERED redirect URI (`platforms/google/oauth.ts`'s
 * `trainerCallbackRedirectUri()`) minting real authorization codes to it, but nothing
 * served the path at all: a 404 there, silently.
 *
 * Deliberately minimal: only the server HALF of the built-in-UI OAuth helper is in scope
 * this round (the UI modal that opens the popup and listens for this page's `postMessage`
 * is explicitly NOT built here, per the dispatch). This handler's job is narrow and
 * complete on its own: read whatever the redirect carried (`code`, `error`, `state`),
 * relay it to `window.opener` via `postMessage`, and close. A future task's modal listens
 * on the other end.
 *
 * Same statelessness discipline as `platforms/google/consent.ts`: no cookie, no session,
 * everything read straight from this one request's own query string.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

export function oauthCallbackHandler(req: Request, res: Response): void {
  const code = readQueryParam(req, 'code');
  const error = readQueryParam(req, 'error');
  const state = readQueryParam(req, 'state');

  const payload = { source: 'outpost-oauth-callback', code: code ?? null, error: error ?? null, state: state ?? null };
  // A postMessage payload embedded inside a <script> tag needs its own escaping pass on
  // top of JSON.stringify: JSON.stringify does not escape "<", so a code/error/state value
  // containing the literal text "</script>" would otherwise break out of the script block.
  // Every value here is attacker-controllable (it is a query string from a redirect), so
  // this is not a theoretical concern.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');

  const statusLine = error
    ? `Authorization failed: ${escapeHtml(error)}`
    : code
      ? 'Authorization complete.'
      : 'No authorization result was received.';

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Outpost OAuth callback</title></head>
<body>
<p>${statusLine} You can close this window.</p>
<script>
  if (window.opener) {
    window.opener.postMessage(${json}, window.location.origin);
  }
  window.close();
</script>
</body>
</html>`;

  res.type('html').send(html);
}
