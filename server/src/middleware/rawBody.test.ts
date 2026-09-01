import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { rawBodyMiddlewares } from './rawBody.js';

function buildApp() {
  const app = express();
  app.use(...rawBodyMiddlewares);
  app.all('/echo-raw', (req, res) => {
    res.json({ rawBodyBase64: req.rawBody ? req.rawBody.toString('base64') : null });
  });
  return app;
}

async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('rawBody preserves exact bytes for a JSON body with unicode and trailing whitespace', async () => {
  const { server, port } = await listen(buildApp());
  try {
    // Multi-byte unicode (accented letters, a snowman) plus escaped control characters
    // and trailing whitespace after the JSON value. JSON.parse tolerates all of this
    // (trailing whitespace is legal JSON), so express.json() parses it successfully
    // while the verify() hook must still capture these exact bytes, unmodified.
    const payload = '{"name":"café ☃","note":"tab\\tnewline\\n"}   \n  ';
    const res = await fetch(`http://127.0.0.1:${port}/echo-raw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rawBodyBase64: string | null };
    assert.ok(body.rawBodyBase64, 'expected rawBody to be captured');
    const captured = Buffer.from(body.rawBodyBase64 as string, 'base64');
    const expected = Buffer.from(payload, 'utf8');
    assert.deepEqual(
      captured,
      expected,
      'captured raw bytes must exactly match the bytes sent, including trailing whitespace and multi-byte unicode',
    );
  } finally {
    server.close();
  }
});

test('rawBody is undefined for a bodyless GET request', async () => {
  const { server, port } = await listen(buildApp());
  try {
    const res = await fetch(`http://127.0.0.1:${port}/echo-raw`, { method: 'GET' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rawBodyBase64: string | null };
    assert.equal(body.rawBodyBase64, null);
  } finally {
    server.close();
  }
});

test('malformed JSON throws from express.json, ready for app.ts to turn into a 400 JSON error', async () => {
  const app = buildApp();
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: 'Bad Request', message: err instanceof Error ? err.message : 'parse error' });
  });
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/echo-raw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    assert.equal(res.status, 400);
    const contentType = res.headers.get('content-type') ?? '';
    assert.ok(
      contentType.includes('application/json'),
      'malformed JSON must yield a JSON error, not an HTML stack trace',
    );
  } finally {
    server.close();
  }
});
