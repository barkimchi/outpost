/**
 * Turns a `SavedRequest` plus the active environment's flattened variables into the exact
 * method/url/headers/body that goes over the wire. This is the ONE place that decision is
 * made: `state/store.ts`'s `sendRequest` and `CodeExportModal.tsx`'s code generation both
 * call it, so "what Send actually sends" and "what the `</> Code` export shows" can never
 * silently diverge (this task's dispatch: the export "must produce output that actually
 * runs").
 *
 * Resolution happens here, once, before anything is sent (this task's dispatch: "{{var}}
 * resolution happens before the request is sent, and the resolved value is what must go
 * over the wire and appear in the Logs tab"). `missing` collects every undefined variable
 * referenced anywhere in the request (URL, headers, auth fields, body); a caller MUST check
 * it and refuse to send rather than trust `url`/`headers`/`body` when it is non-empty, since
 * those fields still contain the literal `{{name}}` text for anything undefined rather than
 * a fabricated value.
 */
import type { AuthConfig, BodyMode, KeyValueRow } from '@gym/shared';
import { resolveVars } from './vars.js';
import { buildUrlWithParams, parseUrlParams } from './urlParams.js';

export interface ResolvableRequest {
  method: string;
  url: string;
  headers: KeyValueRow[];
  auth: AuthConfig;
  bodyMode: BodyMode;
  rawBody: string;
  formBody: KeyValueRow[];
}

export interface ResolvedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Every undefined variable name referenced anywhere in this request, first-seen order,
   *  deduplicated. Empty when everything resolved. */
  missing: string[];
}

/** UTF-8-safe base64, for Basic auth (`btoa` alone throws on non-Latin1 input). */
function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

export function buildResolvedRequest(req: ResolvableRequest, vars: Record<string, string>): ResolvedRequest {
  const missing: string[] = [];
  const seenMissing = new Set<string>();
  function resolve(input: string): string {
    const result = resolveVars(input, vars);
    for (const name of result.missing) {
      if (!seenMissing.has(name)) {
        seenMissing.add(name);
        missing.push(name);
      }
    }
    return result.value;
  }

  let url = resolve(req.url);

  const headers: Record<string, string> = {};
  for (const row of req.headers) {
    if (!row.enabled) continue;
    const key = resolve(row.key).trim();
    if (key === '') continue;
    headers[key] = resolve(row.value);
  }

  // Auth tab injections. These override any identically-named header the learner typed by
  // hand in the Headers tab, matching real Postman: the Auth tab is the source of truth
  // for the header it owns, not merely a suggestion layered under whatever is already there.
  if (req.auth.type === 'bearer') {
    headers.Authorization = `Bearer ${resolve(req.auth.bearer.token)}`;
  } else if (req.auth.type === 'basic') {
    const username = resolve(req.auth.basic.username);
    const password = resolve(req.auth.basic.password);
    headers.Authorization = `Basic ${base64Utf8(`${username}:${password}`)}`;
  } else if (req.auth.type === 'apikey') {
    const key = resolve(req.auth.apikey.key);
    const value = resolve(req.auth.apikey.value);
    if (key.trim() !== '') {
      if (req.auth.apikey.addTo === 'header') {
        headers[key] = value;
      } else {
        const parsed = parseUrlParams(url);
        url = buildUrlWithParams(parsed.base, [...parsed.params, { key, value, enabled: true }]);
      }
    }
  } else if (req.auth.type === 'oauth2') {
    headers.Authorization = `Bearer ${resolve(req.auth.oauth2.accessToken)}`;
  }

  let body: string | undefined;
  if (req.bodyMode === 'raw-json') {
    body = resolve(req.rawBody);
    if (!hasHeaderCaseInsensitive(headers, 'content-type')) headers['Content-Type'] = 'application/json';
  } else if (req.bodyMode === 'form-urlencoded') {
    const parts: string[] = [];
    for (const row of req.formBody) {
      if (!row.enabled) continue;
      const key = resolve(row.key);
      if (key.trim() === '') continue;
      const value = resolve(row.value);
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
    body = parts.join('&');
    if (!hasHeaderCaseInsensitive(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  return { method: req.method, url, headers, body, missing };
}
