import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express, { Router } from 'express';
import { requestLog } from './requestLog.js';
import { bus } from '../bus.js';
import type { RequestEvent } from '@gym/shared';

function waitForNextRequestEvent(): Promise<RequestEvent> {
  return new Promise((resolve) => {
    bus.once('request', (ev: RequestEvent) => resolve(ev));
  });
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
