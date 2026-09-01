import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildBaseString, computeSignature, isTimestampFresh, signaturesMatch, verifySlackSignature } from './sign.js';

const SECRET = 'a-fake-signing-secret-never-real';

function referenceSignature(secret: string, ts: string, body: string): string {
  // Hand-rolled independently of computeSignature() itself, so a bug shared by both
  // implementations would not go unnoticed.
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
}

test('buildBaseString joins version:timestamp:body with colons, exactly', () => {
  assert.equal(buildBaseString('12345', 'abc'), 'v0:12345:abc');
  assert.equal(buildBaseString('12345', Buffer.from('abc', 'utf8')), 'v0:12345:abc');
});

test('computeSignature matches an independently computed HMAC-SHA256, hex, v0=-prefixed', () => {
  const ts = '1700000000';
  const body = '{"type":"url_verification","challenge":"abc"}';
  assert.equal(computeSignature(SECRET, ts, body), referenceSignature(SECRET, ts, body));
});

test('computeSignature is sensitive to every input: secret, timestamp, and body bytes', () => {
  const ts = '1700000000';
  const body = '{"a":1}';
  const base = computeSignature(SECRET, ts, body);
  assert.notEqual(computeSignature('a-different-secret', ts, body), base);
  assert.notEqual(computeSignature(SECRET, '1700000001', body), base);
  assert.notEqual(computeSignature(SECRET, ts, '{"a":2}'), base);
  // Constraint 4: the exact raw bytes matter. A re-serialized (but semantically
  // equivalent) body produces a different signature, because a real
  // parse-then-JSON.stringify round trip is free to reorder keys or change whitespace.
  assert.notEqual(computeSignature(SECRET, ts, '{ "a": 1 }'), base);
});

test('isTimestampFresh accepts anything within 5 minutes, rejects anything outside it, in either direction', () => {
  const now = 1_700_000_000;
  assert.equal(isTimestampFresh(String(now), now), true);
  assert.equal(isTimestampFresh(String(now - 300), now), true, 'exactly 300s old: still within the inclusive window');
  assert.equal(isTimestampFresh(String(now + 300), now), true, 'a future timestamp within the window is also fresh');
  assert.equal(isTimestampFresh(String(now - 301), now), false, '301s old: outside the window');
  assert.equal(isTimestampFresh(String(now + 301), now), false, '301s in the future: outside the window');
  assert.equal(isTimestampFresh('not-a-number', now), false);
  assert.equal(isTimestampFresh('', now), false);
});

test('signaturesMatch: equal strings match, any difference (including length) does not, never throws', () => {
  assert.equal(signaturesMatch('v0=abc', 'v0=abc'), true);
  assert.equal(signaturesMatch('v0=abc', 'v0=abd'), false);
  assert.equal(signaturesMatch('v0=abc', 'v0=abcd'), false);
  assert.equal(signaturesMatch('', ''), true);
});

test('verifySlackSignature: a genuinely correct, fresh signature passes', () => {
  const nowSec = 1_700_000_000;
  const timestamp = String(nowSec);
  const rawBody = '{"type":"url_verification","challenge":"abc"}';
  const signature = computeSignature(SECRET, timestamp, rawBody);
  const result = verifySlackSignature({ signingSecret: SECRET, timestamp, signature, rawBody, nowSec });
  assert.equal(result.ok, true);
});

test('verifySlackSignature: missing headers, a stale timestamp, and a wrong signature are all rejected with a reason', () => {
  const nowSec = 1_700_000_000;
  const timestamp = String(nowSec);
  const rawBody = '{"a":1}';
  const goodSig = computeSignature(SECRET, timestamp, rawBody);

  const missing = verifySlackSignature({ signingSecret: SECRET, timestamp: undefined, signature: goodSig, rawBody, nowSec });
  assert.equal(missing.ok, false);
  assert.match(missing.reason ?? '', /header/);

  const stale = verifySlackSignature({
    signingSecret: SECRET,
    timestamp: String(nowSec - 301),
    signature: computeSignature(SECRET, String(nowSec - 301), rawBody),
    rawBody,
    nowSec,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.reason ?? '', /replay window/);

  const wrongSig = verifySlackSignature({ signingSecret: SECRET, timestamp, signature: 'v0=deadbeef', rawBody, nowSec });
  assert.equal(wrongSig.ok, false);
  assert.match(wrongSig.reason ?? '', /match/);

  const wrongSecret = verifySlackSignature({ signingSecret: 'not-the-real-secret', timestamp, signature: goodSig, rawBody, nowSec });
  assert.equal(wrongSecret.ok, false);
});

test('verifySlackSignature: a re-serialized (parse-then-stringify) body fails even with the right secret and timestamp', () => {
  // This is the literal scenario hard constraint 4 exists to prevent: sign the ORIGINAL
  // bytes, then verify against a semantically-identical but byte-different re-encoding.
  const nowSec = 1_700_000_000;
  const timestamp = String(nowSec);
  const originalBody = '{"type":"url_verification","challenge":"abc"}';
  const signature = computeSignature(SECRET, timestamp, originalBody);

  const reserialized = JSON.stringify(JSON.parse(originalBody));
  // In this particular case JSON.stringify happens to reproduce the same bytes; force a
  // genuine divergence the way a pretty-printer or a different key order would.
  const divergent = JSON.stringify(JSON.parse(originalBody), null, 2);
  assert.notEqual(divergent, originalBody, 'sanity: the re-encoded body must genuinely differ in bytes');

  const result = verifySlackSignature({ signingSecret: SECRET, timestamp, signature, rawBody: divergent, nowSec });
  assert.equal(result.ok, false);
  assert.equal(reserialized, originalBody, 'sanity: only pretty-printing changes bytes here, confirming the test is exercising the real hazard');
});
