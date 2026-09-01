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
import { createGleanRouter } from '../platforms/glean/router.js';
import { scenarioRegistry } from './index.js';
import { Engine } from '../engine/engine.js';
import { createProgressStore } from '../engine/persist.js';

/**
 * Tier 4 scenario tests (docs/SPEC.md section 12, scenarios 12-13). Same two-kind
 * structure `t3-google.test.ts` established: distribution tests (hard constraint 7a) and
 * full live-HTTP solves through the real pipeline (rawBody -> requestLog -> /glean).
 */

function freshEngine(registry: ScenarioDef[] = scenarioRegistry): Engine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-t4-test-'));
  return new Engine(registry, createProgressStore(path.join(dir, 'progress.json')));
}

function buildRealPipelineApp() {
  const app = express();
  app.use(...rawBodyMiddlewares);
  app.use(requestLog);
  app.use('/glean', createGleanRouter());
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

function extractBrokenBody(ticketMd: string): Record<string, unknown> {
  const match = ticketMd.match(/\n {4}(\{.*\})\n/);
  if (!match?.[1]) throw new Error(`could not find the indented broken JSON body in ticket:\n${ticketMd}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function collectTrainerEvents(): { events: TrainerEvent[]; stop: () => void } {
  const events: TrainerEvent[] = [];
  const onTrainerEvent = (ev: TrainerEvent): void => {
    events.push(ev);
  };
  bus.on('trainer-event', onTrainerEvent);
  return { events, stop: () => bus.off('trainer-event', onTrainerEvent) };
}

// --- Distribution tests (hard constraint 7a) ----------------------------------------------

const DISTRIBUTION_TEST_RUNS = 14;

test('t4-token-type: across 14 activations, Token 1 is genuinely the client token sometimes and the indexing token other times', () => {
  const engine = freshEngine();
  try {
    let token1IsClient = 0;
    let token1IsIndexing = 0;
    const seenTickets = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t4-token-type');
      seenTickets.add(activated.ticketMd);
      const token1 = extractLabeled(activated.ticketMd, 'Token 1');
      const token2 = extractLabeled(activated.ticketMd, 'Token 2');
      assert.notEqual(token1, token2, 'the two listed tokens must never be identical');
      // Client tokens are minted with the "glean_client_" prefix, indexing tokens with
      // "glean_index_" (engine/generate.ts). Reading that prefix is the cheapest way to
      // classify which slot Token 1 landed in without depending on internal World state.
      if (token1.startsWith('glean_client_')) token1IsClient += 1;
      else if (token1.startsWith('glean_index_')) token1IsIndexing += 1;
      else throw new Error(`unrecognized token prefix: ${token1}`);
    }
    assert.equal(seenTickets.size, DISTRIBUTION_TEST_RUNS, 'every activation must produce distinct ticket text');
    assert.equal(token1IsClient + token1IsIndexing, DISTRIBUTION_TEST_RUNS);
    assert.ok(
      token1IsClient > 0 && token1IsIndexing > 0,
      `expected Token 1 to be the client token on SOME runs and the indexing token on others (hard constraint 7a); got client=${token1IsClient}, indexing=${token1IsIndexing}`,
    );
  } finally {
    engine.dispose();
  }
});

test('t4-malformed-body: across 14 activations, both "query missing" and "pageSize missing" shapes appear', () => {
  const engine = freshEngine();
  try {
    let missingQuery = 0;
    let missingPageSize = 0;
    const seenTickets = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('t4-malformed-body');
      seenTickets.add(activated.ticketMd);
      const broken = extractBrokenBody(activated.ticketMd);
      const hasQuery = 'query' in broken;
      const hasPageSize = 'pageSize' in broken;
      assert.notEqual(hasQuery, hasPageSize, 'sanity: exactly one of the two fields must be present, never both or neither');
      if (!hasQuery) missingQuery += 1;
      if (!hasPageSize) missingPageSize += 1;
    }
    assert.equal(seenTickets.size, DISTRIBUTION_TEST_RUNS, 'every activation must produce distinct ticket text');
    assert.equal(missingQuery + missingPageSize, DISTRIBUTION_TEST_RUNS, 'each run is missing exactly one of the two fields');
    assert.ok(
      missingQuery > 0 && missingPageSize > 0,
      `expected both missing-field shapes across ${DISTRIBUTION_TEST_RUNS} runs; got missingQuery=${missingQuery}, missingPageSize=${missingPageSize}`,
    );
  } finally {
    engine.dispose();
  }
});

// --- Full live-HTTP solves ------------------------------------------------------------------

test('t4-token-type solved end to end: the wrong token 401s and is recorded as an attempt, the right one succeeds', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t4-token-type');
    const token1 = extractLabeled(activated.ticketMd, 'Token 1');
    const token2 = extractLabeled(activated.ticketMd, 'Token 2');
    const query = /Exactly one of them authenticates.*?"([^"]+)"/s.exec(activated.ticketMd)?.[1] ?? '';
    assert.ok(query.length > 0, 'sanity: the ticket must name a search query to try');

    async function trySearch(token: string): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, pageSize: 10 }),
      });
    }

    const first = await trySearch(token1);
    const second = first.status === 200 ? undefined : await trySearch(token2);
    const workingRes = first.status === 200 ? first : second;
    assert.ok(workingRes);
    assert.equal(workingRes?.status, 200, 'exactly one of the two tokens must work');

    await new Promise((resolve) => setTimeout(resolve, 20));
    if (first.status !== 200) {
      const attemptEvent = events.find((e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> => e.type === 'scenario:attempt');
      assert.ok(attemptEvent, 'the failing token must be recorded as a scenario:attempt with a reason');
      assert.ok((attemptEvent?.reason.length ?? 0) > 0);
    }

    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('One token was the indexing token, not the client token.', 'Switched to the client token.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

test('t4-malformed-body solved end to end: the broken body from the ticket 400s, the fixed body succeeds', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('t4-malformed-body');
    const clientToken = extractLabeled(activated.ticketMd, 'Client API token on file');
    const broken = extractBrokenBody(activated.ticketMd);

    const badRes = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(broken),
    });
    assert.equal(badRes.status, 400);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attemptEvent = events.find((e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> => e.type === 'scenario:attempt');
    assert.ok(attemptEvent, 'the broken body must be recorded as a scenario:attempt with a reason');

    const fixed = { ...broken, query: (broken as { query?: string }).query ?? 'onboarding', pageSize: (broken as { pageSize?: number }).pageSize ?? 10 };
    const goodRes = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixed),
    });
    assert.equal(goodRes.status, 200, `expected the fixed body to succeed: ${JSON.stringify(fixed)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('The request body was missing a required field.', 'Added the missing field and resent.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});
