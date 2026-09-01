/** Small, dependency-free display formatting helpers shared across the response panel,
 *  the Logs tab, and the ExerciseBar. */

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? '';
}

export type StatusBand = 'info' | 'success' | 'redirect' | 'client-error' | 'server-error' | 'unknown';

export function statusBand(status: number): StatusBand {
  if (status >= 100 && status < 200) return 'info';
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400 && status < 500) return 'client-error';
  if (status >= 500 && status < 600) return 'server-error';
  return 'unknown';
}

/** Fix round: a sub-10ms response used to floor to `0 ms` (`Math.round` on a real
 *  sub-millisecond float), which reads as "instant" or "missing" rather than the genuine
 *  fast number it is. A troubleshooter reads response time explicitly (the learning path
 *  teaches it), so anything under 10ms keeps one decimal instead of flooring to zero. */
export function formatMs(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatClockTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Best-effort JSON pretty-print. Returns the original text, unchanged, if it does not
 *  parse as JSON (a body is not obligated to be JSON). Used verbatim by the Logs tab and
 *  the Raw response tab, both of which are meant to show the literal bytes that crossed
 *  the wire; `prettyJsonForDisplay` below is the annotated variant for the Pretty tab. */
export function tryPrettyJson(text: string): { pretty: string; isJson: boolean } {
  if (text.trim() === '') return { pretty: text, isJson: false };
  try {
    const parsed: unknown = JSON.parse(text);
    return { pretty: JSON.stringify(parsed, null, 2), isJson: true };
  } catch {
    return { pretty: text, isJson: false };
  }
}

/** `YYYY-MM-DD HH:MM:SS` in the viewer's local time, for a raw epoch-millisecond value
 *  like `getdocumentstatus`'s `indexedAt`. Deliberately not `formatClockTime`'s
 *  HH:MM:SS.mmm (that one is for comparing log rows a fraction of a second apart; this one
 *  is for reading a timestamp as a date, where sub-second precision only adds noise). */
export function formatEpochMs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// A conservative key-name pattern for "this number is probably an epoch-millisecond
// timestamp": ends in a capital-letter "At"/"Ts", or is exactly "ts"/"timestamp". Excludes
// plain lowercase endings like "state", "rate", "date" on purpose, favoring missing an
// unusual field name over mislabeling an unrelated number as a date.
const TIMESTAMP_KEY = /(?:^ts$|^timestamp$|[a-z](?:At|Ts|Timestamp)$)/;
const MIN_EPOCH_MS = 978307200000; // 2001-01-01, well before this app existed
const MAX_EPOCH_MS = 4102444800000; // 2100-01-01, generously in the future

function looksLikeEpochMs(key: string, value: unknown): value is number {
  return typeof value === 'number' && TIMESTAMP_KEY.test(key) && value >= MIN_EPOCH_MS && value <= MAX_EPOCH_MS;
}

function annotateTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(annotateTimestamps);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = looksLikeEpochMs(key, v) ? `${v} (${formatEpochMs(v)})` : annotateTimestamps(v);
    }
    return out;
  }
  return value;
}

/**
 * Same as `tryPrettyJson`, but a field shaped like an epoch-millisecond timestamp (spec
 * example: `getdocumentstatus`'s `indexedAt`, e.g. `1735689600123`, unreadable at a
 * glance) gets a human-readable date appended alongside it. Only for the Response panel's
 * Pretty tab: the underlying `response.body` string this reads from, and everywhere else
 * that shows it (Raw tab, the Logs tab's request/response body dumps, the `</> Code`
 * export), keep showing the exact literal bytes untouched, since those are meant to be
 * evidence, not a product surface. The annotation is still valid JSON (a string, not a
 * bare number), so it stays parseable and syntax-highlights cleanly.
 */
export function prettyJsonForDisplay(text: string): { pretty: string; isJson: boolean } {
  if (text.trim() === '') return { pretty: text, isJson: false };
  try {
    const parsed: unknown = JSON.parse(text);
    return { pretty: JSON.stringify(annotateTimestamps(parsed), null, 2), isJson: true };
  } catch {
    return { pretty: text, isJson: false };
  }
}
