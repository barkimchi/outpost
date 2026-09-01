import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Slack request-signature verification (docs/SPEC.md hard constraint 4; section 12,
 * scenario t5-hmac-signature). This is the module hard constraint 4 exists for:
 * `req.rawBody` (a `Buffer`, captured by `middleware/rawBody.ts` BEFORE JSON parsing,
 * spec section 2) is signed over exactly as Slack sends it. Parsing the body to a JS
 * object and then `JSON.stringify`-ing it back out does not reliably reproduce the exact
 * bytes Slack (or, here, the learner's own script) signed: key order, whitespace, and
 * number formatting are all free to differ after a parse/reserialize round trip, and any
 * difference at all changes the HMAC. `rawBody` is the only sanctioned mechanism.
 *
 * Algorithm, confirmed live against docs.slack.dev/authentication/verifying-requests-
 * from-slack (2026-08-31, current canonical URL; api.slack.com/authentication/
 * verifying-requests-from-slack 302-redirects there):
 * - Base string: `v0:{timestamp}:{rawBody}`, colon-delimited, version literal `v0`.
 * - HMAC-SHA256 of the base string, keyed by the app's signing secret, hex-encoded.
 * - Final header value: `v0=` prefixed onto that hex digest.
 * - Replay guard: reject if the request's timestamp differs from "now" by more than five
 *   minutes ("we verify that the timestamp does not differ from local time by more than
 *   five minutes"), in EITHER direction (the doc's own reference implementation takes an
 *   absolute value of the difference, not just "not too old": a timestamp minutes in the
 *   FUTURE is exactly as suspicious as one minutes in the past).
 */

export const SIGNATURE_VERSION = 'v0';
export const REPLAY_WINDOW_SEC = 300; // five minutes, per source above

/** Builds the exact base string Slack (and this mock) sign: `v0:{timestamp}:{rawBody}`. */
export function buildBaseString(timestamp: string, rawBody: Buffer | string): string {
  const bodyText = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  return `${SIGNATURE_VERSION}:${timestamp}:${bodyText}`;
}

/** Computes the full `v0=...` signature header value for a given timestamp + raw body. */
export function computeSignature(signingSecret: string, timestamp: string, rawBody: Buffer | string): string {
  const digest = createHmac('sha256', signingSecret).update(buildBaseString(timestamp, rawBody)).digest('hex');
  return `${SIGNATURE_VERSION}=${digest}`;
}

/** Whether `timestamp` (unix seconds, as a string) is within the 5-minute replay window of
 *  `nowSec` (also unix seconds), in either direction. A non-numeric timestamp is never
 *  fresh. */
export function isTimestampFresh(timestamp: string, nowSec: number, windowSec: number = REPLAY_WINDOW_SEC): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowSec - ts) <= windowSec;
}

/**
 * Constant-time comparison of two signature header values. Guards against a timing side
 * channel on the comparison itself (a real, if minor, hardening concern for any signature
 * check): a plain `===` short-circuits on the first mismatched byte, which in principle
 * leaks how many leading characters were correct via response timing. Falls back to
 * `false` (never throws) when the two values are not equal-length hex-prefixed strings,
 * since `timingSafeEqual` itself throws on a length mismatch rather than returning false.
 */
export function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.byteLength !== actualBuf.byteLength) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export interface SlackSignatureVerification {
  ok: boolean;
  /** Present only when `ok` is false; a human-readable reason, never surfaced verbatim to
   *  the caller (the HTTP response stays a generic 401, matching real Slack's own opacity
   *  here), used only for this mock's own logging/tests. */
  reason?: string;
}

/**
 * The single entry point `platforms/slack/router.ts`'s webhook handler calls. Takes the
 * two headers and the raw body directly, rather than an Express `Request`, so it is
 * trivially unit-testable without spinning up a server (see `sign.test.ts`).
 */
export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | string;
  nowSec?: number;
}): SlackSignatureVerification {
  const { signingSecret, timestamp, signature, rawBody } = opts;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  if (!timestamp || !signature) {
    return { ok: false, reason: 'missing X-Slack-Request-Timestamp or X-Slack-Signature header' };
  }
  if (!isTimestampFresh(timestamp, nowSec)) {
    return { ok: false, reason: 'timestamp is outside the 5-minute replay window' };
  }
  const expected = computeSignature(signingSecret, timestamp, rawBody);
  if (!signaturesMatch(expected, signature)) {
    return { ok: false, reason: 'signature does not match' };
  }
  return { ok: true };
}
