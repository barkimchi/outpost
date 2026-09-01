import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express, { Router } from 'express';
import { requestLog, emitBodyParserFailureEvent } from './requestLog.js';
import { bus } from '../bus.js';
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

  const nested = Router();
  nested.get('/api/health', (_req, res) => {
    // Responds directly without ever calling next(): the same shape as the real
    // trainer/router.ts health handler, and exactly the shape that exposed the
    // req.path-gets-stripped-by-mounting bug this test guards against.
    res.json({ ok: true });
  });
  app.use('/_trainer', nested);

  app.get('/github/user', (_req, res) => {
    res.status(200).json({ login: 'octocat' });
  });

  app.get('/_trainer/events', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {}\n\n');
    res.end();
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

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('a nested-router request is logged with the full original path, not the router-relative stripped one', async () => {
  const { server, port } = await listen();
  try {
    const eventPromise = waitForNextRequestEvent();
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/api/health`);
    assert.equal(res.status, 200);
    const ev = await eventPromise;
    assert.equal(ev.path, '/_trainer/api/health');
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
      headers: { 'x-postman-gym-proxy': '1' },
    });
    const ev = await eventPromise;
    assert.equal(ev.source, 'proxy');
    assert.equal(
      'x-postman-gym-proxy' in ev.reqHeaders,
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
    let sawSseEvent = false;
    const onRequest = (ev: RequestEvent): void => {
      if (ev.path === '/_trainer/events') sawSseEvent = true;
    };
    bus.on('request', onRequest);
    try {
      await fetch(`http://127.0.0.1:${port}/_trainer/events`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sawSseEvent, false);
    } finally {
      bus.off('request', onRequest);
    }
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

test('root path normalizes to "/" in pathLower, not the empty string', async () => {
  const { server, port } = await listen();
  try {
    const eventPromise = waitForNextRequestEvent();
    await fetch(`http://127.0.0.1:${port}/`);
    const ev = await eventPromise;
    assert.equal(ev.pathLower, '/');
  } finally {
    server.close();
  }
});

test('the SSE skip is case-insensitive and trailing-slash tolerant, not just an exact match', async () => {
  const { server, port } = await listen();
  try {
    const events = await collectRequestEvents(async () => {
      await fetch(`http://127.0.0.1:${port}/_TRAINER/events`);
      await fetch(`http://127.0.0.1:${port}/_trainer/events/`);
    });
    assert.deepEqual(
      events,
      [],
      'neither an uppercased nor a trailing-slashed variant of the SSE path should be logged',
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
