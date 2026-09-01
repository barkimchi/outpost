import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bus } from './bus.js';
import type { RequestEvent } from '@gym/shared';

function makeEvent(id: string): RequestEvent {
  return {
    id,
    ts: Date.now(),
    method: 'GET',
    path: '/github/user',
    pathLower: '/github/user',
    query: {},
    platform: 'github',
    reqHeaders: {},
    reqBody: null,
    reqBodyTruncated: false,
    status: 200,
    resHeaders: {},
    resBody: null,
    resBodyTruncated: false,
    durationMs: 1,
    source: 'external',
  };
}

test('bus ring buffer caps at 200 entries, dropping the oldest first', () => {
  for (let i = 0; i < 250; i += 1) {
    bus.emit('request', makeEvent(`ev-${i}`));
  }
  const recent = bus.recent();
  assert.equal(recent.length, 200);
  assert.equal(recent[0]?.id, 'ev-50', 'the oldest 50 entries should have been dropped');
  assert.equal(recent[recent.length - 1]?.id, 'ev-249', 'the newest entry should be last');
});

test('bus.recent() returns a snapshot, not a live reference to the internal ring', () => {
  const snapshot = bus.recent();
  const lengthBefore = snapshot.length;
  bus.emit('request', makeEvent('ev-snapshot-check'));
  assert.equal(snapshot.length, lengthBefore, 'a previously taken snapshot must not grow');
  assert.equal(bus.recent().length, lengthBefore, 'length stays capped at 200 once full');
});

test('listeners attached to the "request" channel receive every emitted event', () => {
  const seen: string[] = [];
  const onRequest = (ev: RequestEvent): void => {
    seen.push(ev.id);
  };
  bus.on('request', onRequest);
  try {
    bus.emit('request', makeEvent('ev-listener-check'));
    assert.deepEqual(seen, ['ev-listener-check']);
  } finally {
    bus.off('request', onRequest);
  }
});
