import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { ScenarioDef, TrainerEvent } from '@gym/shared';
import { bus } from '../bus.js';
import { rawBodyMiddlewares } from '../middleware/rawBody.js';
import { requestLog } from '../middleware/requestLog.js';
import { createSlackRouter } from '../platforms/slack/router.js';
import { computeSignature } from '../platforms/slack/sign.js';
import { scenarioRegistry } from './index.js';
import { Engine } from '../engine/engine.js';
import { createProgressStore } from '../engine/persist.js';

/**
 * Tier 5 scenario tests (docs/SPEC.md section 12, scenarios 14-15). Same two-kind
 * structure `t3-google.test.ts` and `t4-glean.test.ts` established: distribution tests
 * (hard constraint 7a) and full live-HTTP solves through the real pipeline (rawBody ->
 * requestLog -> /slack).
 */

function freshEngine(registry: ScenarioDef[] = scenarioRegistry): Engine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-t5-test-'));
  return new Engine(registry, createProgressStore(path.join(dir, 'progress.json')));
}

function buildRealPipelineApp() {
  const app = express();
  app.use(...rawBodyMiddlewares);
  app.use(requestLog);
  app.use('/slack', createSlackRouter());
  return app;
}

async function listen(app: express.Express) {
  // 127.0.0.1, not a bare listen(0): see docs/SPEC.md section 2a.
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

function extractLabeled(ticketMd: string, label: string): string {
  const re = new RegExp(`${label}: \`([^\`]+)\``);
  const match = ticketMd.match(re);
  if (!match?.[1]) throw new Error(`could not find "${label}: \`...\`" in ticket:\n${ticketMd}`);
  return match[1];
}

function collectTrainerEvents(): { events: TrainerEvent[]; stop: () => void } {
  const events: TrainerEvent[] = [];
  const onTrainerEvent = (ev: TrainerEvent): void => {
    events.push(ev);
  };
  bus.on('trainer-event', onTrainerEvent);
  return { events, stop: () => bus.off('trainer-event', onTrainerEvent) };
}

async function pageThroughHistory(port: number, botToken: string, channelId: string): Promise<string[]> {
  const collected: string[] = [];
  let cursor = '';
  let hasMore = true;
  let iterations = 0;
  const HARD_CAP = 20;
  while (hasMore) {
    iterations += 1;
    if (iterations > HARD_CAP) throw new Error('pagination did not terminate: looping cursor?');
    const url = new URL(`http://127.0.0.1:${port}/slack/api/conversations.history`);
    url.searchParams.set('channel', channelId);
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
    const body = (await res.json()) as { messages: Array<{ text: string }>; has_more: boolean; response_metadata: { next_cursor: string } };
    for (const m of body.messages) collected.push(m.text);
    hasMore = body.has_more;
    cursor = body.response_metadata.next_cursor;
  }
  return collected;
}

// --- Distribution tests (hard constraint 7a) ----------------------------------------------

const DISTRIBUTION_TEST_RUNS = 14;

test('t5-envelope-trap: across 14 activations, the targeted channel genuinely varies, not always the same one', () => {
  const engine = freshEngine();
  try {
    const seenChannelIds = new Set<string>();
    const seenTickets = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t5-envelope-trap');
      seenTickets.add(activated.ticketMd);
      seenChannelIds.add(extractLabeled(activated.ticketMd, 'Channel'));
    }
    assert.equal(seenTickets.size, DISTRIBUTION_TEST_RUNS, 'every activation must produce distinct ticket text');
    assert.ok(
      seenChannelIds.size >= 2,
      `expected the targeted channel to vary across ${DISTRIBUTION_TEST_RUNS} runs, saw only ${seenChannelIds.size} distinct id(s)`,
    );
  } finally {
    engine.dispose();
  }
});

test('t5-hmac-signature: across 14 activations, seed/company/signing secret all differ (per-run generation, hard constraint 6)', () => {
  // No multi-candidate "pick the right one" shape exists here to position-randomize (see
  // t5-slack.ts's header comment, the same judgment call t3-revoked-refresh already made):
  // the exercise is mechanical (compute the HMAC correctly), and every value involved,
  // down to the timestamp and body of each individual REQUEST, already differs.
  const engine = freshEngine();
  try {
    const seeds = new Set<string>();
    const secrets = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t5-hmac-signature');
      seeds.add(activated.seed);
      secrets.add(extractLabeled(activated.ticketMd, 'Signing secret on file'));
    }
    assert.equal(seeds.size, DISTRIBUTION_TEST_RUNS, 'every activation must mint a distinct seed');
    assert.equal(secrets.size, DISTRIBUTION_TEST_RUNS, 'every activation must mint a distinct signing secret');
  } finally {
    engine.dispose();
  }
});

// --- Full live-HTTP solves ------------------------------------------------------------------

test('t5-envelope-trap solved end to end: not_in_channel attempt, join, successful post, full history pagination', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t5-envelope-trap');
    const botToken = extractLabeled(activated.ticketMd, 'Bot token');
    const channelId = extractLabeled(activated.ticketMd, 'Channel');

    const badPost = await fetch(`http://127.0.0.1:${port}/slack/api/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: channelId, text: 'alert' }),
    });
    assert.equal(badPost.status, 200, 'the envelope trap: this is a real 200 even though it failed');
    assert.deepEqual(await badPost.json(), { ok: false, error: 'not_in_channel' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attemptEvent = events.find((e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> => e.type === 'scenario:attempt');
    assert.ok(attemptEvent, 'a 200-but-ok:false post must still be recorded as a scenario:attempt');

    const join = await fetch(`http://127.0.0.1:${port}/slack/api/conversations.join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: channelId }),
    });
    assert.equal(((await join.json()) as { ok: boolean }).ok, true);

    const goodPost = await fetch(`http://127.0.0.1:${port}/slack/api/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: channelId, text: 'alert, now it lands' }),
    });
    assert.equal(((await goodPost.json()) as { ok: boolean }).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));

    const collected = await pageThroughHistory(port, botToken, channelId);
    assert.ok(collected.length > 4, 'sanity: pagination must have actually spanned more than one page');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-2'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('The bot was never a member of the channel.', 'Joined the channel, then reposted.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

test('t5-hmac-signature solved end to end: a wrong signature is a real attempt, a correctly computed one solves it', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t5-hmac-signature');
    const signingSecret = extractLabeled(activated.ticketMd, 'Signing secret on file');

    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });

    const bad = await fetch(`http://127.0.0.1:${port}/slack/webhook/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=deadbeef' },
      body,
    });
    assert.equal(bad.status, 401);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attemptEvent = events.find((e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> => e.type === 'scenario:attempt');
    assert.ok(attemptEvent, 'a rejected signature must be recorded as a scenario:attempt with a reason');

    const goodSig = computeSignature(signingSecret, ts, body);
    const good = await fetch(`http://127.0.0.1:${port}/slack/webhook/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': goodSig },
      body,
    });
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { challenge: 'abc123' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('No request ever carried a correctly computed signature.', 'Computed v0= correctly and resent.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});
