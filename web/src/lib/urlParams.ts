/**
 * Two-way binding between the URL bar and the Params tab (real Postman's own UX): editing
 * the URL's query string updates the Params rows, and editing a Params row rewrites the
 * URL. `{{var}}` references inside a query value must survive this round trip unresolved
 * (resolution happens once, right before sending; see `lib/vars.ts`), so this operates on
 * the raw, unresolved URL text and never attempts to parse it with `new URL()`, which would
 * choke on `{{baseUrl}}` (not a valid URL scheme) and on an unresolved `{{var}}` sitting
 * inside the query string.
 *
 * Rows carry no id of their own: params are not persisted separately from `request.url`
 * (there is exactly one source of truth, the URL string), so a row is re-parsed fresh on
 * every read. The store's Params-tab actions address a row by its index in that fresh
 * parse, which is stable for as long as no row is added/removed/reordered mid-edit, the
 * only guarantee needed since this tab has no drag-to-reorder.
 */

export interface UrlParamRow {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ParsedUrl {
  /** Everything before the first `?`, unchanged. */
  base: string;
  params: UrlParamRow[];
}

/** Splits `raw` query string entries by `&`, then `key=value` by the first `=`. A bare
 *  `key` with no `=` gets an empty value, matching how Postman treats a flag-style param. */
export function parseUrlParams(url: string): ParsedUrl {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return { base: url, params: [] };
  const base = url.slice(0, qIndex);
  const query = url.slice(qIndex + 1);
  if (query === '') return { base, params: [] };
  const params = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    return { key: decodeUriComponentSafe(key), value: decodeUriComponentSafe(value), enabled: true };
  });
  return { base, params };
}

function decodeUriComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s; // an unresolved {{var}} or a literal % can make decodeURIComponent throw
  }
}

/** Rebuilds a URL from a base and param rows. Disabled rows are dropped (unchecking a
 *  param removes it from what is actually sent), but a blank key is kept (not dropped):
 *  dropping it would make a freshly added, not-yet-typed-into row vanish the instant it
 *  round-trips back through a re-parse, which is exactly what happens on every keystroke
 *  in a controlled input bound to derived state. A `{{var}}` reference in a value is NOT
 *  URI-encoded here: encoding `{{` would break the variable syntax the resolver looks for,
 *  and Postman's own Params tab has the identical behavior for this reason. */
export function buildUrlWithParams(base: string, params: UrlParamRow[]): string {
  const enabled = params.filter((p) => p.enabled);
  if (enabled.length === 0) return base;
  const query = enabled.map((p) => `${encodeParamPart(p.key)}=${encodeParamPart(p.value)}`).join('&');
  return `${base}?${query}`;
}

function encodeParamPart(value: string): string {
  // Encode everything except the {{ }} delimiters and the variable name inside them, so a
  // param value of "{{token}}" round-trips as "{{token}}", not "%7B%7Btoken%7D%7D".
  const parts = value.split(/(\{\{[^{}]*\}\})/g);
  return parts.map((part) => (part.startsWith('{{') && part.endsWith('}}') ? part : encodeURIComponent(part))).join('');
}
