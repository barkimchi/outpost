import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { oauthCallbackHandler } from './oauthCallback.js';

/**
 * `GET /_trainer/oauth/callback` (Task 6 fix round, finding 4). A minimal, standalone
 * pipeline (no rawBody/requestLog needed: this handler reads only the query string), the
 * same convention `platforms/google/router.test.ts` uses for a single router in isolation.
 */

function buildApp() {
  const app = express();
  app.get('/_trainer/oauth/callback', oauthCallbackHandler);
  return app;
}

async function listen() {
  // 127.0.0.1, not a bare listen(0): see docs/SPEC.md section 2a.
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

test('a successful callback (code + state) renders HTML that postMessages the code to the opener and closes', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/oauth/callback?code=4%2Ffake-code-123&state=xyz`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/html'));
    const html = await res.text();
    assert.ok(html.includes('window.opener.postMessage'));
    assert.ok(html.includes('window.close()'));
    assert.ok(html.includes('"code":"4/fake-code-123"'));
    assert.ok(html.includes('"state":"xyz"'));
    assert.ok(html.includes('"error":null'));
    assert.ok(html.includes('window.location.origin'), 'targetOrigin must be scoped, never "*"');
    assert.ok(html.includes('Authorization complete.'));
  } finally {
    server.close();
  }
});

test('an error callback (access_denied) relays the error and does not claim success', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/oauth/callback?error=access_denied&state=xyz`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('"error":"access_denied"'));
    assert.ok(html.includes('"code":null'));
    assert.ok(html.includes('Authorization failed'));
  } finally {
    server.close();
  }
});

test('no query params at all still renders a safe page, code/error/state all null', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/oauth/callback`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('"code":null'));
    assert.ok(html.includes('"error":null'));
    assert.ok(html.includes('"state":null'));
    assert.ok(html.includes('No authorization result was received.'));
  } finally {
    server.close();
  }
});

test('a code containing a literal </script> cannot break out of the inline script block', async () => {
  const { server, port } = await listen();
  try {
    const malicious = '</script><script>alert(1)</script>';
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/oauth/callback?code=${encodeURIComponent(malicious)}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    // The page legitimately contains exactly ONE </script>: the real closing tag for its
    // own inline script block. The attacker-controlled value must not add a second one
    // (which would prematurely close that block and let the rest run as page HTML/a new
    // script): count occurrences rather than asserting zero.
    const closingTagCount = html.split('</script>').length - 1;
    assert.equal(closingTagCount, 1, 'exactly the one legitimate closing </script> tag, none injected from the code value');
    assert.ok(!html.includes('</script><script>alert(1)</script>'));
    // The escaped form (a JSON-safe \u003c, literal backslash-u-0-0-3-c) must be present
    // instead, proving the value still made it into the payload, just safely. Browsers
    // detect the closing tag on the "</script" prefix alone, so escaping only "<" (not
    // also ">") is sufficient and is what the handler actually does.
    assert.ok(html.includes('\\u003c/script>'));
  } finally {
    server.close();
  }
});

test('duplicate query params (an array under Express) resolve to the first value instead of crashing', async () => {
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_trainer/oauth/callback?code=first-code&code=second-code`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('"code":"first-code"'));
  } finally {
    server.close();
  }
});
