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
 *  parse as JSON (a body is not obligated to be JSON). */
export function tryPrettyJson(text: string): { pretty: string; isJson: boolean } {
  if (text.trim() === '') return { pretty: text, isJson: false };
  try {
    const parsed: unknown = JSON.parse(text);
    return { pretty: JSON.stringify(parsed, null, 2), isJson: true };
  } catch {
    return { pretty: text, isJson: false };
  }
}
