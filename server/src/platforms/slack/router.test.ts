import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createSlackRouter } from './router.js';
import { computeSignature } from './sign.js';
import { activeWorld, resetState } from '../world.js';
import { OLDEST_SLACK_MESSAGE_MARKER } from '../world.js';
import { buildTestRunContext } from '../../testSupport/runContext.js';
import { rawBodyMiddlewares } from '../../middleware/rawBody.js';

function buildApp() {
  const app = express();
  // Real rawBody middleware, not a bare express.json(): the webhook signature tests need
  // req.rawBody exactly like production (hard constraint 4).
  app.use(...rawBodyMiddlewares);
  app.use('/slack', createSlackRouter());
  return app;
}

async function listen() {
  // 127.0.0.1, not a bare listen(0): see docs/SPEC.md section 2a.
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('auth.test: the bot token succeeds; a wrong token gets invalid_auth; no token gets not_authed; both are HTTP 200', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/slack/api/auth.test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.slack.botToken}` },
    });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { ok: boolean; team_id: string; user_id: string };
    assert.equal(okBody.ok, true);
    assert.equal(okBody.team_id, ctx.slack.teamId);
    assert.equal(okBody.user_id, ctx.slack.botUserId);

    const wrong = await fetch(`http://127.0.0.1:${port}/slack/api/auth.test`, {
      method: 'POST',
      headers: { authorization: 'Bearer xoxb-not-the-real-token' },
    });
    assert.equal(wrong.status, 200, 'auth errors are still HTTP 200 (the envelope trap)');
    assert.deepEqual(await wrong.json(), { ok: false, error: 'invalid_auth' });

    const none = await fetch(`http://127.0.0.1:${port}/slack/api/auth.test`, { method: 'POST' });
    assert.equal(none.status, 200);
    assert.deepEqual(await none.json(), { ok: false, error: 'not_authed' });
  } finally {
    server.close();
  }
});

test('chat.postMessage on a channel the bot has not joined returns HTTP 200 with ok:false, error:not_in_channel (the envelope trap)', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();
  const channel = world.slack.channels[0];
  if (!channel) throw new Error('sanity: fixture must have at least one channel');
  channel.isMember = false;
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/slack/api/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.slack.botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: channel.id, text: 'hello' }),
    });
    // The lesson itself: HTTP 200, not 4xx, even though the post genuinely failed.
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, error: 'not_in_channel' });
  } finally {
    server.close();
  }
});

test('chat.postMessage against a nonexistent channel returns channel_not_found; joining first makes the same post succeed', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();
  const channel = world.slack.channels[0];
  if (!channel) throw new Error('sanity: fixture must have at least one channel');
  channel.isMember = false;
  const { server, port } = await listen();
  try {
    const notFound = await fetch(`http://127.0.0.1:${port}/slack/api/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.slack.botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'C_DOES_NOT_EXIST', text: 'hello' }),
    });
    assert.equal(notFound.status, 200);
    assert.deepEqual(await notFound.json(), { ok: false, error: 'channel_not_found' });

    const join = await fetch(`http://127.0.0.1:${port}/slack/api/conversations.join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.slack.botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: channel.id }),
    });
    assert.equal(join.status, 200);
    const joinBody = (await join.json()) as { ok: boolean; warning?: string };
    assert.equal(joinBody.ok, true);
    assert.equal(joinBody.warning, undefined, 'not already a member: no warning expected');

    const rejoin = await fetch(`http://127.0.0.1:${port}/slack/api/conversations.join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.slack.botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: channel.id }),
    });
    assert.equal(((await rejoin.json()) as { warning?: string }).warning, 'already_in_channel');

    const post = await fetch(`http://127.0.0.1:${port}/slack/api/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.slack.botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: channel.id, text: 'hello, now it lands' }),
    });
    assert.equal(post.status, 200);
    assert.equal(((await post.json()) as { ok: boolean }).ok, true);
  } finally {
    server.close();
  }
});

test('conversations.list returns every channel with its real membership state', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/slack/api/conversations.list`, {
      headers: { authorization: `Bearer ${ctx.slack.botToken}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; channels: Array<{ id: string; is_member: boolean }> };
    assert.equal(body.ok, true);
    assert.equal(body.channels.length, ctx.slack.channels.length);
  } finally {
    server.close();
  }
});

test('conversations.history on a channel the bot has not joined returns not_in_channel', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();
  const channel = world.slack.channels[0];
  if (!channel) throw new Error('sanity: fixture must have at least one channel');
  channel.isMember = false;
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/slack/api/conversations.history?channel=${channel.id}`, {
      headers: { authorization: `Bearer ${ctx.slack.botToken}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, error: 'not_in_channel' });
  } finally {
    server.close();
  }
});

// --- Cursor pagination: prove the loop terminates (task-7 brief, verbatim requirement) ---

test('conversations.history cursor pagination terminates, visits every seeded message exactly once, and reaches the oldest marker', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();
  const channel = world.slack.channels[0];
  if (!channel) throw new Error('sanity: fixture must have at least one channel');
  channel.isMember = true;
  const seeded = world.slack.messages[channel.id] ?? [];
  assert.ok(seeded.length > 4, 'sanity: the seeded history must span more than one page (page size 4)');

  const { server, port } = await listen();
  try {
    const collected: string[] = [];
    let cursor = '';
    let iterations = 0;
    const HARD_CAP = 20; // generous upper bound; a real bug (a repeating cursor) would hit this and fail the test below instead of hanging forever.
    let hasMore = true;
    while (hasMore) {
      iterations += 1;
      if (iterations > HARD_CAP) throw new Error('pagination did not terminate within the hard iteration cap: looping cursor?');
      const url = new URL(`http://127.0.0.1:${port}/slack/api/conversations.history`);
      url.searchParams.set('channel', channel.id);
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url, { headers: { authorization: `Bearer ${ctx.slack.botToken}` } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        messages: Array<{ text: string }>;
        has_more: boolean;
        response_metadata: { next_cursor: string };
      };
      assert.equal(body.ok, true);
      assert.ok(body.messages.length > 0, 'a page must never be empty while has_more/pagination is still in progress');
      for (const m of body.messages) collected.push(m.text);
      hasMore = body.has_more;
      const nextCursor = body.response_metadata.next_cursor;
      if (hasMore) {
        assert.notEqual(nextCursor, '', 'has_more:true must always carry a real next_cursor');
        assert.notEqual(nextCursor, cursor, 'the cursor must genuinely advance, never repeat, or this loop would spin forever');
      } else {
        assert.equal(nextCursor, '', 'the final page must carry an empty next_cursor');
      }
      cursor = nextCursor;
    }

    assert.ok(iterations >= 2, 'sanity: this must have taken more than one request to prove pagination actually happened');
    assert.equal(collected.length, seeded.length, 'every seeded message must be returned exactly once, across all pages');
    assert.equal(collected.at(-1), OLDEST_SLACK_MESSAGE_MARKER, 'the very last message returned must be the oldest one');
  } finally {
    server.close();
  }
});

// --- Webhook signature verification (constraint 4, t5-hmac-signature) -------------------

test('webhook/events: a correctly signed url_verification request is accepted and echoes the challenge', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const ts = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const sig = computeSignature(ctx.slack.signingSecret, ts, rawBody);
    const res = await fetch(`http://127.0.0.1:${port}/slack/webhook/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      body: rawBody,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { challenge: 'abc123' });
  } finally {
    server.close();
  }
});

test('webhook/events: a stale timestamp is rejected by the replay guard even with an otherwise-correct signature', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const staleTs = String(Math.floor(Date.now() / 1000) - 301); // just past the 5-minute window
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const sig = computeSignature(ctx.slack.signingSecret, staleTs, rawBody);
    const res = await fetch(`http://127.0.0.1:${port}/slack/webhook/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': staleTs,
        'x-slack-signature': sig,
      },
      body: rawBody,
    });
    assert.equal(res.status, 401, 'a correctly-computed signature over a stale timestamp must still be rejected');
  } finally {
    server.close();
  }
});

test('webhook/events: a wrong signature, or the right secret over re-serialized bytes, is rejected', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const ts = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });

    const wrongSig = await fetch(`http://127.0.0.1:${port}/slack/webhook/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=deadbeef' },
      body: rawBody,
    });
    assert.equal(wrongSig.status, 401);

    // Signed over a DIFFERENT (pretty-printed) encoding of the same logical body: proves
    // this endpoint verifies the exact raw bytes, not a parsed-and-reserialized body.
    const reserialized = JSON.stringify(JSON.parse(rawBody), null, 2);
    const sigForReserialized = computeSignature(ctx.slack.signingSecret, ts, reserialized);
    const mismatchedBytes = await fetch(`http://127.0.0.1:${port}/slack/webhook/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sigForReserialized },
      body: rawBody, // sent as the ORIGINAL bytes, but signed for the reserialized ones
    });
    assert.equal(mismatchedBytes.status, 401);
  } finally {
    server.close();
  }
});

// --- GET/POST symmetry on every /api/* route (fix round, task-7 review finding 1) --------
//
// Real Slack accepts both verbs on every Web API method. Before this fix, only one verb
// was registered per route, so the OTHER verb 404'd from the generic handler: total
// silence, and the wrong envelope (a 404 where real Slack answers 200) on top.

test('GET works on chat.postMessage (previously POST-only), with the exact same envelope behavior as POST', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();
  const channel = world.slack.channels[0];
  if (!channel) throw new Error('sanity: fixture must have at least one channel');
  channel.isMember = false;
  const { server, port } = await listen();
  try {
    const url = new URL(`http://127.0.0.1:${port}/slack/api/chat.postMessage`);
    url.searchParams.set('channel', channel.id);
    url.searchParams.set('text', 'hello via GET');
    const res = await fetch(url, { headers: { authorization: `Bearer ${ctx.slack.botToken}` } });
    assert.equal(res.status, 200, 'a real Slack method must never 404 for using the other verb');
    assert.deepEqual(await res.json(), { ok: false, error: 'not_in_channel' });
  } finally {
    server.close();
  }
});

test('GET with no credential on chat.postMessage returns not_authed (not_authed reachable on the previously-missing verb too)', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/slack/api/chat.postMessage`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, error: 'not_authed' });
  } finally {
    server.close();
  }
});

test('POST works on conversations.history (previously GET-only), form-encoded, with real pagination', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();
  const channel = world.slack.channels[0];
  if (!channel) throw new Error('sanity: fixture must have at least one channel');
  channel.isMember = true;
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/slack/api/conversations.history`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.slack.botToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ channel: channel.id }).toString(),
    });
    assert.equal(res.status, 200, 'a real Slack method must never 404 for using the other verb');
    const body = (await res.json()) as { ok: boolean; messages: unknown[] };
    assert.equal(body.ok, true);
    assert.ok(body.messages.length > 0);
  } finally {
    server.close();
  }
});

test('GET/POST also both work on auth.test, conversations.list, and conversations.join', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();
  const channel = world.slack.channels[0];
  if (!channel) throw new Error('sanity: fixture must have at least one channel');
  const { server, port } = await listen();
  try {
    for (const method of ['GET', 'POST'] as const) {
      const authRes = await fetch(`http://127.0.0.1:${port}/slack/api/auth.test`, {
        method,
        headers: { authorization: `Bearer ${ctx.slack.botToken}` },
      });
      assert.equal(authRes.status, 200, `auth.test must accept ${method}`);
      assert.equal(((await authRes.json()) as { ok: boolean }).ok, true);

      const listRes = await fetch(`http://127.0.0.1:${port}/slack/api/conversations.list`, {
        method,
        headers: { authorization: `Bearer ${ctx.slack.botToken}` },
      });
      assert.equal(listRes.status, 200, `conversations.list must accept ${method}`);

      const joinUrl = new URL(`http://127.0.0.1:${port}/slack/api/conversations.join`);
      const joinRes = await fetch(method === 'GET' ? `${joinUrl}?channel=${channel.id}` : joinUrl, {
        method,
        headers: {
          authorization: `Bearer ${ctx.slack.botToken}`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify({ channel: channel.id }) } : {}),
      });
      assert.equal(joinRes.status, 200, `conversations.join must accept ${method}`);
      assert.equal(((await joinRes.json()) as { ok: boolean }).ok, true);
    }
  } finally {
    server.close();
  }
});

// --- invalid_cursor (fix round, task-7 review finding 6, minor) --------------------------

test('conversations.history: a garbage cursor returns invalid_cursor instead of silently restarting at page 1', async () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();
  const channel = world.slack.channels[0];
  if (!channel) throw new Error('sanity: fixture must have at least one channel');
  channel.isMember = true;
  const { server, port } = await listen();
  try {
    const garbage = await fetch(
      `http://127.0.0.1:${port}/slack/api/conversations.history?channel=${channel.id}&cursor=not-a-real-cursor-!!!`,
      { headers: { authorization: `Bearer ${ctx.slack.botToken}` } },
    );
    assert.equal(garbage.status, 200);
    assert.deepEqual(await garbage.json(), { ok: false, error: 'invalid_cursor' });

    // A negative offset, and non-integer garbage, must also be rejected, not clamped.
    const negative = await fetch(
      `http://127.0.0.1:${port}/slack/api/conversations.history?channel=${channel.id}&cursor=${Buffer.from('-5').toString('base64url')}`,
      { headers: { authorization: `Bearer ${ctx.slack.botToken}` } },
    );
    assert.deepEqual(await negative.json(), { ok: false, error: 'invalid_cursor' });

    // No cursor at all (the legitimate first call) is NOT an error.
    const first = await fetch(`http://127.0.0.1:${port}/slack/api/conversations.history?channel=${channel.id}`, {
      headers: { authorization: `Bearer ${ctx.slack.botToken}` },
    });
    const firstBody = (await first.json()) as { ok: boolean };
    assert.equal(firstBody.ok, true);

    // A genuine, correctly-encoded cursor from a real prior response still works.
    const nextCursor = ((await (
      await fetch(`http://127.0.0.1:${port}/slack/api/conversations.history?channel=${channel.id}`, {
        headers: { authorization: `Bearer ${ctx.slack.botToken}` },
      })
    ).json()) as { response_metadata: { next_cursor: string } }).response_metadata.next_cursor;
    assert.notEqual(nextCursor, '', 'sanity: this channel must have more than one page');
    const secondPage = await fetch(
      `http://127.0.0.1:${port}/slack/api/conversations.history?channel=${channel.id}&cursor=${nextCursor}`,
      { headers: { authorization: `Bearer ${ctx.slack.botToken}` } },
    );
    assert.equal(((await secondPage.json()) as { ok: boolean }).ok, true);
  } finally {
    server.close();
  }
});
