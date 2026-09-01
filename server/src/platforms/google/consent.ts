import type { Request, Response } from 'express';
import { invalidClientPage, redirectUriMismatchPage } from './fixtures.js';
import { isRegisteredClientId, isRegisteredRedirectUri, issueAuthorizationCode } from './oauth.js';

/**
 * `GET`/`POST /o/oauth2/v2/auth` (docs/SPEC.md section 11): the consent half of the OAuth
 * flow. **Cookie-free and stateless on purpose.** Postman's embedded browser does not
 * reliably keep third-party cookies, so this cannot rely on a session between the GET that
 * renders the form and the POST that submits it: every inbound query parameter is carried
 * forward as a hidden `<input>` instead, and the POST handler re-derives everything it
 * needs from the submitted form fields alone, never from anything stored server-side
 * between the two requests.
 */

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: 'Confirm your identity',
  email: 'See your email address',
  profile: 'See your name and profile picture',
  'https://www.googleapis.com/auth/calendar.readonly': 'See your calendar events',
  'https://www.googleapis.com/auth/calendar.events': 'See, edit, share, and permanently delete events on your calendars',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS[scope] ?? scope;
}

/**
 * Fix round (adversarial testing found `?scope=a&scope=b` minted a scope-less code):
 * Express's `qs` parser turns a repeated query key into an ARRAY, not a string, and the
 * original version here only handled `typeof value === 'string'`, silently DROPPING the
 * key entirely for any duplicate. Every OAuth param this mock cares about is logically a
 * single value (a repeated one is either an accident or an attempt to smuggle a second
 * value past whichever check reads the "first" one), so an array now joins its string
 * entries with a space, matching how a legitimate multi-token value like `scope` is
 * itself space-delimited, rather than vanishing.
 */
function queryToStringMap(query: Request['query']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      const joined = value.filter((v): v is string => typeof v === 'string').join(' ');
      if (joined !== '') out[key] = joined;
    }
    // Anything else (a nested object, from Express's extended query parser) is dropped:
    // no legitimate OAuth param is ever shaped that way, and there is nothing sensible to
    // stringify it into.
  }
  return out;
}

/**
 * Renders the stateless consent page. `params` is every inbound query/form parameter,
 * carried straight through as hidden fields, so the POST handler below sees exactly what
 * the GET request received, no matter how long the embedded browser sat on the page.
 */
function renderConsentPage(params: Record<string, string>): string {
  const clientId = params.client_id ?? '(unknown client)';
  const scopeStr = params.scope ?? '';
  const scopes = scopeStr.split(/\s+/).filter(Boolean);
  const scopeItems = scopes.length > 0
    ? scopes.map((s) => `<li>${escapeHtml(describeScope(s))}</li>`).join('\n      ')
    : '<li>No permissions requested</li>';
  const hiddenFields = Object.entries(params)
    .map(([key, value]) => `      <input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Sign in to continue</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f6f6f6; display: flex; justify-content: center; padding: 48px 16px; }
  .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 420px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.15); }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .subtitle { color: #444; font-size: 14px; margin: 0 0 24px; word-break: break-all; }
  .scopes { margin: 0 0 24px; padding-left: 20px; font-size: 14px; color: #222; }
  .actions { display: flex; justify-content: flex-end; gap: 12px; }
  button { border: none; border-radius: 6px; padding: 10px 20px; font-size: 14px; cursor: pointer; }
  button[value="1"] { background: #1a73e8; color: #fff; }
  button[value="0"] { background: transparent; color: #444; }
</style>
</head>
<body>
  <div class="card">
    <h1>Choose an account</h1>
    <p class="subtitle">to continue to ${escapeHtml(clientId)}</p>
    <p>This app wants to access:</p>
    <ul class="scopes">
      ${scopeItems}
    </ul>
    <form method="POST" action="/google/o/oauth2/v2/auth">
${hiddenFields}
      <div class="actions">
        <button type="submit" name="approve" value="0">Cancel</button>
        <button type="submit" name="approve" value="1">Allow</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

export function handleAuthorize(req: Request, res: Response): void {
  const params = queryToStringMap(req.query);
  const redirectUri = params.redirect_uri;
  if (!isRegisteredRedirectUri(redirectUri)) {
    res.status(400).type('html').send(redirectUriMismatchPage(redirectUri));
    return;
  }
  // Client binding (Task 6 fix round, finding 5): checked BEFORE rendering the consent
  // page, matching real Google (an unrecognized client never gets as far as a consent
  // screen at all). Previously any client_id, including a garbage one, rendered the page
  // and (on approval) got a real code issued.
  if (!isRegisteredClientId(params.client_id)) {
    res.status(401).type('html').send(invalidClientPage(params.client_id));
    return;
  }
  res.type('html').send(renderConsentPage(params));
}

/**
 * Same duplicate-key defense as `queryToStringMap` above, for form fields: an array
 * collapses via the same space-join, not silent loss. Consistent on purpose: this reads
 * the exact hidden fields that page rendered from `queryToStringMap`'s own output, so a
 * duplicate `scope` value that survived the GET step must survive identically through the
 * POST step, not vanish partway (or be treated differently) just because it crossed from
 * query string to form body.
 */
function readField(body: unknown, key: string): string | undefined {
  const record = (body ?? {}) as Record<string, unknown>;
  const value = record[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const joined = value.filter((v): v is string => typeof v === 'string').join(' ');
    return joined === '' ? undefined : joined;
  }
  return undefined;
}

export function handleConsentSubmit(req: Request, res: Response): void {
  const redirectUri = readField(req.body, 'redirect_uri');
  if (!isRegisteredRedirectUri(redirectUri)) {
    // Re-validated here, not trusted from the GET step: this endpoint is stateless, so
    // there is no server-side record of "the GET already checked this." The hidden field
    // is the only carrier, and it must be checked again on its own.
    res.status(400).type('html').send(redirectUriMismatchPage(redirectUri));
    return;
  }
  const clientId = readField(req.body, 'client_id');
  if (!isRegisteredClientId(clientId)) {
    // Also re-validated here, same statelessness reasoning as redirect_uri above: a
    // tampered or forged client_id hidden field must be caught again, not trusted because
    // the GET step (which the POST never proves actually happened) supposedly checked it.
    res.status(401).type('html').send(invalidClientPage(clientId));
    return;
  }

  const state = readField(req.body, 'state');
  const approved = readField(req.body, 'approve') === '1';

  if (!approved) {
    const qs = new URLSearchParams({ error: 'access_denied' });
    if (state !== undefined) qs.set('state', state);
    res.redirect(`${redirectUri}?${qs.toString()}`);
    return;
  }

  const scopeStr = readField(req.body, 'scope') ?? '';
  const scopes = scopeStr.split(/\s+/).filter(Boolean);
  const code = issueAuthorizationCode(redirectUri, scopes, clientId);

  const qs = new URLSearchParams({ code });
  if (state !== undefined) qs.set('state', state);
  res.redirect(`${redirectUri}?${qs.toString()}`);
}
