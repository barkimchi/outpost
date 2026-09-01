import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createFaultInjector, faultInjector } from './faultInjector.js';
import type { MatchableRequest } from '../engine/match.js';

async function listen(app: express.Express) {
  // 127.0.0.1, not a bare listen(0): see docs/SPEC.md section 2a.
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('when the engine has no matching intercept fault, the request passes through to the next handler', async () => {
  const fakeEngine = {
    activeInterceptFault: (_req: MatchableRequest) => undefined,
  };
  const app = express();
  app.use(createFaultInjector(fakeEngine));
  app.get('/github/user', (_req, res) => res.status(200).json({ passed: true }));

  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/github/user`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { passed: true });
  } finally {
    server.close();
  }
});

test('when the engine has a matching intercept fault, the response is short-circuited with its verbatim status/headers/body', async () => {
  const fakeEngine = {
    activeInterceptFault: (req: MatchableRequest) => {
      if (req.method === 'POST' && req.pathLower === '/slack/api/chat.postmessage') {
        return { status: 500, headers: { 'x-fault': 'yes' }, body: '{"ok":false,"error":"fake_intercept"}' };
      }
      return undefined;
    },
  };
  const app = express();
  app.use(createFaultInjector(fakeEngine));
  // Downstream handler must never run: the fault short-circuits before it.
  app.post('/slack/api/chat.postMessage', (_req, res) => res.status(200).json({ shouldNotReach: true }));

  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/slack/api/chat.postMessage`, { method: 'POST' });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('x-fault'), 'yes');
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.deepEqual(body, { ok: false, error: 'fake_intercept' });
  } finally {
    server.close();
  }
});

test('the request shape passed to the engine uses pathLower (lowercased, trailing slash stripped), not the verbatim path', async () => {
  const seen: MatchableRequest[] = [];
  const fakeEngine = {
    activeInterceptFault: (req: MatchableRequest) => {
      seen.push(req);
      return undefined;
    },
  };
  const app = express();
  app.use(createFaultInjector(fakeEngine));
  app.get('/GitHub/User/', (_req, res) => res.status(200).end());

  const { server, port } = await listen(app);
  try {
    await fetch(`http://127.0.0.1:${port}/GitHub/User/`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.pathLower, '/github/user');
    assert.equal(seen[0]?.method, 'GET');
  } finally {
    server.close();
  }
});

test('the production faultInjector export is bound to the real engine singleton and is a usable middleware function', () => {
  assert.equal(typeof faultInjector, 'function');
  assert.equal(faultInjector.length, 3, 'must be a standard (req, res, next) Express middleware');
});
