import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { Router } from 'express';
import { requestLog, emitBodyParserFailureEvent, toPathLower } from './requestLog.js';
import { bus } from '../bus.js';
import { createApp, type CreateAppOptions } from '../app.js';
import { engine } from '../engine/engine.js';
import type { RequestEvent } from '@gym/shared';

function waitForNextRequestEvent(): Promise<RequestEvent> {
  return new Promise((resolve) => {
    bus.once('request', (ev: RequestEvent) => resolve(ev));
  });
}

/** Collects every 'request' event emitted during `fn`, in order. */
async function collectRequestEvents(fn: () => Promise<unknown>): Promise<RequestEvent[]> {
  const seen: RequestEvent[] = [];
  const onRequest = (ev: RequestEvent): void => {
    seen.push(ev);
  };
  bus.on('request', onRequest);
  try {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return seen;
  } finally {
    bus.off('request', onRequest);
  }
}

async function listen() {
  const app = express();
  app.use(requestLog);

  // Mounted at a non-/_trainer prefix deliberately: /_trainer is now always skipped by
  // requestLog (see isTrainerPath in requestLog.ts), so the req.path-gets-stripped-by-
  // mounting regression below needs a path that still gets logged to prove anything.
  const nested = Router();
  nested.get('/api/health', (_req, res) => {
    // Responds directly without ever calling next(): the same shape as the real
    // trainer/router.ts health handler, and exactly the shape that exposed the
    // req.path-gets-stripped-by-mounting bug this test guards against.
    res.json({ ok: true });
  });
  app.use('/mock-platform', nested);

  app.get('/github/user', (_req, res) => {
    res.status(200).json({ login: 'octocat' });
  });

  app.get('/_trainer/events', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {}\n\n');
    res.end();
  });

  // Representative /_trainer control-plane chatter (spec section 6): scenario-state
  // polling, the exact kind of traffic that used to drown the Logs tab.
  app.get('/_trainer/api/state', (_req, res) => {
    res.json({ state: 'idle' });
  });

  // Two writes whose combined size lands exactly on the 8KB cap, followed by more data
  // after the cap is already hit: the exact shape that used to report
  // resBodyTruncated: false on a genuinely truncated body.
  app.get('/big-body', (_req, res) => {
    res.write(Buffer.alloc(8192, 'a'));
    res.write(Buffer.from('more-data-past-the-cap'));
    res.end();
  });

  // Mirrors app.ts's error handler shape: a handler throws an error with status 400 for
  // a reason that has nothing to do with body parsing. requestLog has already installed
  // its res.write/res.end patch by the time this runs (unlike a genuine rawBody
  // failure), so this is the exact race the re-entrancy guard exists to prevent.
  app.get('/throws-400-not-a-parser-failure', (_req, _res, next) => {
    const err = Object.assign(new Error('deliberately not a parser failure'), { status: 400 });
    next(err);
  });
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const body = { error: 'Bad Request', message: err instanceof Error ? err.message : 'error' };
    res.status(400).json(body);
    // Same call app.ts's error handler makes for any status-400 error, parser failure or
    // not: this is what would double-emit without the guard.
    emitBodyParserFailureEvent(req, res, JSON.stringify(body));
  });

  // 127.0.0.1, not a bare listen(0): see docs/SPEC.md section 2a (a bare listen(0)
  // binds the IPv6 wildcard, which macOS's ephemeral-port allocator can hand out even
  // when another process already holds the same port on IPv4, and fetch() dials IPv4).
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

/**
 * Boots the REAL createApp() stack (rawBody -> requestLog -> faultInjector ->
 * /_trainer -> /github), for the one test below that needs the actual proxy and GitHub
 * router, not a hand-built stand-in. `engine` is a per-process singleton (Node isolates
 * each test file into its own process), and this file's other tests never touch it, so
 * booting it here cannot affect them.
 */
async function listenRealApp(options: Omit<CreateAppOptions, 'production'> = {}) {
  const app = createApp({ production: false, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

/**
 * Same as `listenRealApp()`, but in production mode with a real `webDistDir` on disk
 * (`index.html` + `assets/index-<hash>.js`, the exact shape Vite actually builds), for the
 * static-asset skip test below (fix round, finding 6): `createApp()` only mounts
 * `express.static` when `production: true` (spec section 6 step 6, "prod only").
 */
async function listenRealAppProd(webDistDir: string) {
  const app = createApp({ production: true, webDistDir });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('a nested-router request is logged with the full original path, not the router-relative stripped one', async () => {
  const { server, port } = await listen();
  try {
    const eventPromise = waitForNextRequestEvent();
    const res = await fetch(`http://127.0.0.1:${port}/mock-platform/api/health`);
    assert.equal(res.status, 200);
    const ev = await eventPromise;
    assert.equal(ev.path, '/mock-platform/api/health');
  } finally {
    server.close();
  }
});

test('platform is derived from the first path segment', async () => {
  const { server, port } = await listen();
  try {
    const eventPromise = waitForNextRequestEvent();
    await fetch(`http://127.0.0.1:${port}/github/user`);
    const ev = await eventPromise;
    assert.equal(ev.platform, 'github');
  } finally {
    server.close();
  }
});

test('source is "proxy" only when the internal marker header is present, and the header never leaks into logged headers', async () => {
  const { server, port } = await listen();
  try {
    const eventPromise = waitForNextRequestEvent();
    await fetch(`http://127.0.0.1:${port}/github/user`, {
      headers: { 'x-outpost-proxy': '1' },
    });
    const ev = await eventPromise;
    assert.equal(ev.source, 'proxy');
    assert.equal(
      'x-outpost-proxy' in ev.reqHeaders,
      false,
      'the internal marker header must not leak into the logged request headers',
    );
  } finally {
    server.close();
  }
});

test('a request with no marker header is logged as "external"', async () => {
  const { server, port } = await listen();
  try {
    const eventPromise = waitForNextRequestEvent();
    await fetch(`http://127.0.0.1:${port}/github/user`);
    const ev = await eventPromise;
    assert.equal(ev.source, 'external');
  } finally {
    server.close();
  }
});

test('the SSE route is never logged', async () => {
  const { server, port } = await listen();
  try {
    const events = await collectRequestEvents(async () => {
      await fetch(`http://127.0.0.1:${port}/_trainer/events`);
    });
    assert.deepEqual(events, []);
  } finally {
    server.close();
  }
});

test('the whole /_trainer prefix never emits a RequestEvent: GET /_trainer/api/state produces none', async () => {
  const { server, port } = await listen();
  try {
    const events = await collectRequestEvents(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/state`);
      assert.equal(res.status, 200, 'the request itself must still work; only logging is skipped');
    });
    assert.deepEqual(
      events,
      [],
      'trainer control-plane chatter (scenario state polls, health checks, ...) must never ' +
        'enter the bus, or it evicts real evidence from the 200-entry ring buffer replayed to new SSE clients',
    );
  } finally {
    server.close();
  }
});

test('a proxied GitHub call still produces exactly one log event, badged source: "proxy", for the platform path (not the /_trainer envelope)', async () => {
  engine.boot();
  const { server, port } = await listenRealApp();
  try {
    const events = await collectRequestEvents(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/proxy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'GET',
          url: `http://127.0.0.1:${port}/github/user`,
          headers: { authorization: 'Bearer some-token-nobody-generated' },
        }),
      });
      // The proxy envelope itself always 200s (the wrapped platform status lives inside
      // the JSON body); a 401 from the fake bearer token is expected and irrelevant here.
      assert.equal(res.status, 200);
    });
    assert.equal(
      events.length,
      1,
      'only the inner /github/user request should be logged; the /_trainer/api/proxy envelope must not be',
    );
    assert.equal(events[0]?.path, '/github/user');
    assert.equal(events[0]?.pathLower, '/github/user');
    assert.equal(events[0]?.source, 'proxy');
  } finally {
    server.close();
  }
});

test('pathLower is lowercased with a trailing slash stripped, while path stays verbatim', async () => {
  const { server, port } = await listen();
  try {
    const eventPromise = waitForNextRequestEvent();
    await fetch(`http://127.0.0.1:${port}/GitHub/User/`);
    const ev = await eventPromise;
    assert.equal(ev.path, '/GitHub/User/', 'path must stay verbatim for the Logs tab');
    assert.equal(ev.pathLower, '/github/user', 'pathLower must be lowercased and trailing-slash-stripped');
  } finally {
    server.close();
  }
});

// Fix round (finding 6): GET / is now a skipped static-asset path (see the test group
// below), so this can no longer be observed through a live HTTP round trip the way it
// used to be; toPathLower is exported specifically so this normalization stays directly
// testable on its own.
test('toPathLower normalizes the root path to "/", not the empty string', () => {
  assert.equal(toPathLower('/'), '/');
});

// --- Static asset requests (web/dist + the SPA shell) are never logged (fix round, ------
// finding 6) --------------------------------------------------------------------------

test('GET / and GET /assets/* are never logged, even in production with a real build present', async () => {
  const webDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-static-log-test-'));
  fs.mkdirSync(path.join(webDistDir, 'assets'));
  fs.writeFileSync(path.join(webDistDir, 'index.html'), '<!doctype html><title>gym</title>');
  fs.writeFileSync(path.join(webDistDir, 'assets', 'index-abc123.js'), 'console.log("gym");');
  const { server, port } = await listenRealAppProd(webDistDir);
  try {
    const events = await collectRequestEvents(async () => {
      const root = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(root.status, 200, 'sanity: the SPA shell must still actually be served');
      const asset = await fetch(`http://127.0.0.1:${port}/assets/index-abc123.js`);
      assert.equal(asset.status, 200, 'sanity: the built bundle must still actually be served');
    });
    assert.deepEqual(
      events,
      [],
      'GET / and GET /assets/* must never produce a RequestEvent: this is the app serving its own shell to ' +
        'itself, not a learner\'s platform call, and used to badge every page load/refresh EXTERNAL in the Logs tab',
    );
  } finally {
    server.close();
    fs.rmSync(webDistDir, { recursive: true, force: true });
  }
});

test('a genuine platform request is still logged normally alongside a static asset skip', async () => {
  // Regression guard: the static-asset skip must not accidentally swallow real platform
  // traffic served by the SAME production app.
  const webDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-static-log-test-'));
  fs.writeFileSync(path.join(webDistDir, 'index.html'), '<!doctype html><title>gym</title>');
  engine.boot();
  const { server, port } = await listenRealAppProd(webDistDir);
  try {
    const events = await collectRequestEvents(async () => {
      await fetch(`http://127.0.0.1:${port}/`);
      await fetch(`http://127.0.0.1:${port}/github/user`);
    });
    assert.equal(events.length, 1, 'only the platform request should be logged');
    assert.equal(events[0]?.path, '/github/user');
  } finally {
    server.close();
    fs.rmSync(webDistDir, { recursive: true, force: true });
  }
});

test('the /_trainer skip is case-insensitive and trailing-slash tolerant, not just an exact match', async () => {
  const { server, port } = await listen();
  try {
    const events = await collectRequestEvents(async () => {
      await fetch(`http://127.0.0.1:${port}/_TRAINER/events`);
      await fetch(`http://127.0.0.1:${port}/_trainer/events/`);
      await fetch(`http://127.0.0.1:${port}/_Trainer/Api/State`);
    });
    assert.deepEqual(
      events,
      [],
      'uppercased, trailing-slashed, and mixed-case variants of /_trainer paths must all be skipped',
    );
  } finally {
    server.close();
  }
});

test('a response whose captured bytes land exactly on the 8KB cap, with more data dropped after it, reports resBodyTruncated: true', async () => {
  const { server, port } = await listen();
  try {
    const eventPromise = waitForNextRequestEvent();
    await fetch(`http://127.0.0.1:${port}/big-body`);
    const ev = await eventPromise;
    assert.equal(ev.resBody?.length, 8192);
    assert.equal(
      ev.resBodyTruncated,
      true,
      'more data existed past the cap and was dropped; this must not read as an untruncated 8192-byte body',
    );
  } finally {
    server.close();
  }
});

test('a re-entrancy guard prevents a double emit when a non-parser 400 error also calls emitBodyParserFailureEvent', async () => {
  const { server, port } = await listen();
  try {
    const events = await collectRequestEvents(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/throws-400-not-a-parser-failure`);
      assert.equal(res.status, 400);
    });
    assert.equal(
      events.length,
      1,
      'requestLog\'s own finish() (triggered by res.json() inside the error handler) and the explicit ' +
        'emitBodyParserFailureEvent() call both fire for this response; only one RequestEvent may result',
    );
    assert.equal(events[0]?.status, 400);
  } finally {
    server.close();
  }
});
