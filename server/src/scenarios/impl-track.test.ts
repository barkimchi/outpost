import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { ScenarioDef, TrainerEvent } from '@gym/shared';
import { bus } from '../bus.js';
import { activeWorld } from '../platforms/world.js';
import { rawBodyMiddlewares } from '../middleware/rawBody.js';
import { requestLog } from '../middleware/requestLog.js';
import { createGithubRouter } from '../platforms/github/router.js';
import { createGoogleRouter } from '../platforms/google/router.js';
import { createGleanRouter } from '../platforms/glean/router.js';
import { createSlackRouter } from '../platforms/slack/router.js';
import { trainerCallbackRedirectUri } from '../platforms/google/oauth.js';
import { scenarioRegistry } from './index.js';
import { Engine } from '../engine/engine.js';
import { createProgressStore } from '../engine/persist.js';

/**
 * Implementation-track scenario tests (docs/SPEC.md section 12): `impl-github`,
 * `impl-oauth`, `impl-glean`, `impl-slack`. Same two-kind structure the troubleshoot-track
 * scenario tests already use: a distribution test (hard constraint 7a, argued as N/A per
 * `impl-track.ts`'s own header comment, verified here as per-run regeneration instead) and
 * a full live-HTTP solve per scenario.
 */

function freshEngine(registry: ScenarioDef[] = scenarioRegistry): Engine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-impl-test-'));
  return new Engine(registry, createProgressStore(path.join(dir, 'progress.json')));
}

function buildRealPipelineApp() {
  const app = express();
  app.use(...rawBodyMiddlewares);
  app.use(requestLog);
  app.use('/github', createGithubRouter());
  app.use('/google', createGoogleRouter());
  app.use('/glean', createGleanRouter());
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

function extractDocIds(ticketMd: string): string[] {
  const ids: string[] = [];
  const re = /^- `([^`]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ticketMd)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

function collectTrainerEvents(): { events: TrainerEvent[]; stop: () => void } {
  const events: TrainerEvent[] = [];
  const onTrainerEvent = (ev: TrainerEvent): void => {
    events.push(ev);
  };
  bus.on('trainer-event', onTrainerEvent);
  return { events, stop: () => bus.off('trainer-event', onTrainerEvent) };
}

async function approveConsent(
  port: number,
  opts: { redirectUri: string; scope: string; clientId: string },
): Promise<Response> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.scope,
    approve: '1',
  });
  return fetch(`http://127.0.0.1:${port}/google/o/oauth2/v2/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
}

function extractCode(location: string): string {
  const url = new URL(location);
  const code = url.searchParams.get('code');
  if (!code) throw new Error(`no code in Location header: ${location}`);
  return code;
}

// --- Distribution tests (hard constraint 7a: argued N/A for this track, verified here as
// per-run regeneration instead; see impl-track.ts's header comment) ------------------------

const DISTRIBUTION_TEST_RUNS = 14;

test('impl-github: across 14 activations, org/repos/token all differ (per-run generation, no fault to memorize a position for)', () => {
  const engine = freshEngine();
  try {
    const tickets = new Set<string>();
    const orgs = new Set<string>();
    const tokens = new Set<string>();
    for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
      const activated = engine.activate('impl-github');
      tickets.add(activated.ticketMd);
      orgs.add(extractLabeled(activated.ticketMd, 'Organization'));
      tokens.add(extractLabeled(activated.ticketMd, 'Personal access token'));
    }
    assert.equal(tickets.size, DISTRIBUTION_TEST_RUNS, 'every activation must produce distinct ticket text');
    // The org is derived from a bounded ~18-company name pool (engine/generate.ts), so
    // exact distinctness across 14 draws is not guaranteed by the birthday problem alone;
    // genuine variation (not always the same org) is the real property worth proving,
    // the same relaxation t3-redirect-mismatch's own decoy-pool distribution test uses.
    assert.ok(orgs.size >= 2, `expected the org to vary across ${DISTRIBUTION_TEST_RUNS} runs, saw only ${orgs.size} distinct value(s)`);
    assert.equal(tokens.size, DISTRIBUTION_TEST_RUNS, 'every activation must mint a distinct token');
  } finally {
    engine.dispose();
  }
});

test('impl-oauth, impl-glean, impl-slack: across 14 activations each, credentials and tickets all differ', () => {
  const engine = freshEngine();
  try {
    for (const id of ['impl-oauth', 'impl-glean', 'impl-slack']) {
      const tickets = new Set<string>();
      for (let i = 0; i < DISTRIBUTION_TEST_RUNS; i++) {
        const activated = engine.activate(id);
        tickets.add(activated.ticketMd);
      }
      assert.equal(tickets.size, DISTRIBUTION_TEST_RUNS, `${id}: every activation must produce distinct ticket text`);
    }
  } finally {
    engine.dispose();
  }
});

// --- impl-github: full live-HTTP solve, including the pagination constraint-9 check -------

test('impl-github solved end to end: auth, org access, then genuine pagination to the true last page', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('impl-github');
    const token = extractLabeled(activated.ticketMd, 'Personal access token');
    const org = extractLabeled(activated.ticketMd, 'Organization');

    const step1 = await fetch(`http://127.0.0.1:${port}/github/user`, { headers: { authorization: `token ${token}` } });
    assert.equal(step1.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));

    const step2 = await fetch(`http://127.0.0.1:${port}/github/orgs/${org}/repos`, { headers: { authorization: `token ${token}` } });
    assert.equal(step2.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-2'));

    // Wrong attempt (constraint 9): the same call again, at the default page size, returns
    // everything at once, which must be rejected with a real reason, not silently ignored.
    const repos = activeWorld().github.repos;
    assert.ok(repos.length > 3, 'sanity: this run must actually need more than one page to make the test meaningful');
    const cheat = await fetch(`http://127.0.0.1:${port}/github/orgs/${org}/repos`, { headers: { authorization: `token ${token}` } });
    assert.equal(cheat.status, 200, 'sanity: fetching everything at once is still a real 200');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cheatAttempt = events.find(
      (e): e is Extract<TrainerEvent, { type: 'scenario:attempt' }> => e.type === 'scenario:attempt' && e.stepId === 'step-3',
    );
    assert.ok(cheatAttempt, 'fetching every repo at once must count as a real attempt at step 3, not silent success');
    assert.match(cheatAttempt?.reason ?? '', /at most/, 'the reason must explain why grabbing everything at once did not count');

    // Real fix: page down to the true last page.
    const perPage = 2;
    const totalPages = Math.ceil(repos.length / perPage);
    const lastRepo = repos[repos.length - 1];
    if (!lastRepo) throw new Error('no repos generated this run');
    const step3 = await fetch(
      `http://127.0.0.1:${port}/github/orgs/${org}/repos?per_page=${perPage}&page=${totalPages}`,
      { headers: { authorization: `token ${token}` } },
    );
    assert.equal(step3.status, 200);
    const step3Body = (await step3.json()) as Array<{ name: string }>;
    assert.ok(step3Body.some((r) => r.name === lastRepo.name), 'the true last page must contain the last repo');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-3'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('Onboarding checklist item, nothing broken.', 'Confirmed auth, org access, and full pagination.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

// --- impl-oauth: full live-HTTP solve -------------------------------------------------------

test('impl-oauth solved end to end: first-time consent, exchange, userinfo', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('impl-oauth');
    const clientId = extractLabeled(activated.ticketMd, 'Client ID');
    const clientSecret = extractLabeled(activated.ticketMd, 'Client secret');
    const redirectUri = trainerCallbackRedirectUri();

    const approve = await approveConsent(port, { redirectUri, scope: 'openid email profile', clientId });
    assert.equal(approve.status, 302);
    const code = extractCode(approve.headers.get('location') ?? '');

    const exchangeBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const exchangeRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: exchangeBody.toString(),
    });
    assert.equal(exchangeRes.status, 200);
    const exchanged = (await exchangeRes.json()) as { access_token: string };
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));

    const userinfoRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${exchanged.access_token}` },
    });
    assert.equal(userinfoRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-2'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('First-time setup, nothing broken.', 'Consented, exchanged, and confirmed userinfo.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

// --- impl-glean: full live-HTTP solve -------------------------------------------------------

test('impl-glean solved end to end: index, confirm the index picked it up, confirm search works', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('impl-glean');
    const indexingToken = extractLabeled(activated.ticketMd, 'Indexing token');
    const clientToken = extractLabeled(activated.ticketMd, 'Search token');
    const datasource = extractLabeled(activated.ticketMd, 'Datasource');
    const docIds = extractDocIds(activated.ticketMd);
    assert.ok(docIds.length >= 1);
    const firstDocId = docIds[0];
    if (!firstDocId) throw new Error('no doc id extracted');

    const indexRes = await fetch(`http://127.0.0.1:${port}/glean/api/index/v1/indexdocuments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ documents: docIds.map((id) => ({ id, datasource, title: id })) }),
    });
    assert.equal(indexRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));

    const statusUrl = new URL(`http://127.0.0.1:${port}/glean/api/index/v1/getdocumentstatus`);
    statusUrl.searchParams.set('id', firstDocId);
    statusUrl.searchParams.set('datasource', datasource);
    const statusRes = await fetch(statusUrl, { headers: { authorization: `Bearer ${indexingToken}` } });
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as { status: string };
    assert.equal(statusBody.status, 'INDEXED');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-2'));

    // Wrong attempt (constraint 9): the indexing token does not work for search.
    const wrongTokenSearch = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${indexingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'anything', pageSize: 10 }),
    });
    assert.equal(wrongTokenSearch.status, 401, 'sanity: the indexing token must not authenticate the search endpoint');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
      events.some((e) => e.type === 'scenario:attempt' && e.stepId === 'step-3'),
      'searching with the wrong token kind must count as a real attempt with a reason',
    );

    const searchRes = await fetch(`http://127.0.0.1:${port}/glean/rest/api/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'a', pageSize: 10 }),
    });
    assert.equal(searchRes.status, 200);
    const searchBody = (await searchRes.json()) as { results: unknown[] };
    assert.ok(searchBody.results.length >= 1, 'the run\'s pre-seeded company content must be discoverable via search');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-3'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('First-time connection, nothing broken.', 'Indexed the docs, confirmed the index, confirmed search.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});

// --- impl-slack: full live-HTTP solve -------------------------------------------------------

test('impl-slack solved end to end: join, post, full history pagination', async () => {
  const engine = freshEngine();
  const { events, stop } = collectTrainerEvents();
  const app = buildRealPipelineApp();
  const { server, port } = await listen(app);
  try {
    const activated = engine.activate('impl-slack');
    const botToken = extractLabeled(activated.ticketMd, 'Bot token');
    const channelId = extractLabeled(activated.ticketMd, 'Channel');

    const joinRes = await fetch(`http://127.0.0.1:${port}/slack/api/conversations.join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: channelId }),
    });
    assert.equal(((await joinRes.json()) as { ok: boolean }).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-1'));

    const postRes = await fetch(`http://127.0.0.1:${port}/slack/api/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: channelId, text: 'we are live' }),
    });
    assert.equal(((await postRes.json()) as { ok: boolean }).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-2'));

    let cursor = '';
    let hasMore = true;
    let iterations = 0;
    const HARD_CAP = 20;
    while (hasMore) {
      iterations += 1;
      if (iterations > HARD_CAP) throw new Error('pagination did not terminate');
      const url = new URL(`http://127.0.0.1:${port}/slack/api/conversations.history`);
      url.searchParams.set('channel', channelId);
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
      const body = (await res.json()) as { has_more: boolean; response_metadata: { next_cursor: string } };
      hasMore = body.has_more;
      cursor = body.response_metadata.next_cursor;
    }
    assert.ok(iterations > 1, 'sanity: this must actually have spanned more than one page');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(events.some((e) => e.type === 'scenario:step' && e.stepId === 'step-3'));
    assert.ok(events.some((e) => e.type === 'scenario:explaining'));

    engine.explain('First-time connection, nothing broken.', 'Joined, posted, and paged the full history.');
    assert.ok(events.some((e) => e.type === 'scenario:solved'));
  } finally {
    stop();
    server.close();
    engine.dispose();
  }
});
