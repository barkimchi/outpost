import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { rawBodyMiddlewares } from '../../middleware/rawBody.js';
import { createGoogleRouter } from './router.js';
import { activeWorld, resetState } from '../world.js';
import { buildTestRunContext } from '../../testSupport/runContext.js';
import { trainerCallbackRedirectUri } from './oauth.js';

function buildApp() {
  const app = express();
  app.use(...rawBodyMiddlewares);
  app.use('/google', createGoogleRouter());
  return app;
}

async function listen() {
  // 127.0.0.1, not a bare listen(0): see docs/SPEC.md section 2a.
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

const REDIRECT_URI = trainerCallbackRedirectUri();
const BASELINE_SCOPE = 'openid email profile';
const FULL_SCOPE = 'openid email profile https://www.googleapis.com/auth/calendar.readonly';

interface Ctx {
  clientId: string;
  clientSecret: string;
}

function ctxOf(): Ctx {
  const ctx = buildTestRunContext();
  resetState(ctx);
  return { clientId: ctx.google.clientId, clientSecret: ctx.google.clientSecret };
}

async function approveConsent(
  port: number,
  opts: { redirectUri: string; scope: string; state?: string; approve?: '1' | '0'; clientId: string },
): Promise<Response> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.scope,
    approve: opts.approve ?? '1',
    ...(opts.state !== undefined ? { state: opts.state } : {}),
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

async function exchangeCode(
  port: number,
  opts: { code: string; redirectUri: string; clientId: string; clientSecret: string },
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  return fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

async function getFreshAccessToken(port: number, ctx: Ctx, scope: string = FULL_SCOPE): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await approveConsent(port, { redirectUri: REDIRECT_URI, scope, clientId: ctx.clientId });
  assert.equal(res.status, 302);
  const code = extractCode(res.headers.get('location') ?? '');
  const tokenRes = await exchangeCode(port, { code, redirectUri: REDIRECT_URI, clientId: ctx.clientId, clientSecret: ctx.clientSecret });
  assert.equal(tokenRes.status, 200);
  const body = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

// --- GET /o/oauth2/v2/auth: stateless consent rendering ---------------------------------

test('GET /o/oauth2/v2/auth with a registered redirect_uri renders a cookie-free consent page carrying every param as a hidden field', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const url = new URL(`http://127.0.0.1:${port}/google/o/oauth2/v2/auth`);
    url.searchParams.set('client_id', ctx.clientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', FULL_SCOPE);
    url.searchParams.set('state', 'xyz-state-123');
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/html'));
    assert.equal(res.headers.get('set-cookie'), null, 'the consent page must never set a cookie');
    const html = await res.text();
    assert.ok(html.includes(`name="redirect_uri" value="${REDIRECT_URI}"`));
    assert.ok(html.includes(`name="client_id" value="${ctx.clientId}"`));
    assert.ok(html.includes('name="state" value="xyz-state-123"'));
    assert.ok(html.includes('name="scope"'));
  } finally {
    server.close();
  }
});

test('GET /o/oauth2/v2/auth with an unregistered redirect_uri returns 400 Error 400: redirect_uri_mismatch', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const url = new URL(`http://127.0.0.1:${port}/google/o/oauth2/v2/auth`);
    url.searchParams.set('client_id', ctx.clientId);
    url.searchParams.set('redirect_uri', 'https://evil.example/callback');
    url.searchParams.set('response_type', 'code');
    const res = await fetch(url);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(html.includes('Error 400: redirect_uri_mismatch'));
    assert.ok(html.includes('https://evil.example/callback'));
  } finally {
    server.close();
  }
});

test('GET /o/oauth2/v2/auth with no redirect_uri at all is also a mismatch, not a crash', async () => {
  const ctxLocal = ctxOf();
  const { server, port } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/google/o/oauth2/v2/auth?client_id=${ctxLocal.clientId}`);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(html.includes('(missing)'));
  } finally {
    server.close();
  }
});

// --- POST /o/oauth2/v2/auth: consent submission ------------------------------------------

test('approving consent with a valid redirect_uri issues a single-use code via a 302 redirect', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const res = await approveConsent(port, { redirectUri: REDIRECT_URI, scope: FULL_SCOPE, state: 'abc', clientId: ctx.clientId });
    assert.equal(res.status, 302);
    const location = res.headers.get('location') ?? '';
    assert.ok(location.startsWith(`${REDIRECT_URI}?`));
    const url = new URL(location);
    assert.equal(url.searchParams.get('state'), 'abc');
    const code = url.searchParams.get('code');
    assert.ok(code);
    const record = activeWorld().google.authCodes[code as string];
    assert.ok(record);
    assert.equal(record?.used, false);
    assert.equal(record?.redirectUri, REDIRECT_URI);
    assert.deepEqual(record?.scopes, FULL_SCOPE.split(' '));
  } finally {
    server.close();
  }
});

test('denying consent redirects with error=access_denied, no code', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const res = await approveConsent(port, { redirectUri: REDIRECT_URI, scope: BASELINE_SCOPE, approve: '0', state: 's1', clientId: ctx.clientId });
    assert.equal(res.status, 302);
    const url = new URL(res.headers.get('location') ?? '');
    assert.equal(url.searchParams.get('error'), 'access_denied');
    assert.equal(url.searchParams.get('code'), null);
    assert.equal(url.searchParams.get('state'), 's1');
  } finally {
    server.close();
  }
});

test('POST consent submit re-validates redirect_uri itself (stateless: never trusts a prior GET)', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const res = await approveConsent(port, { redirectUri: 'https://evil.example/callback', scope: BASELINE_SCOPE, clientId: ctx.clientId });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(html.includes('Error 400: redirect_uri_mismatch'));
  } finally {
    server.close();
  }
});

// --- POST /oauth2/token: authorization_code grant ----------------------------------------

test('exchanging a valid code returns access_token, refresh_token, and the granted scope', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const { accessToken, refreshToken } = await getFreshAccessToken(port, ctx);
    assert.ok(accessToken.length > 0);
    assert.ok(refreshToken.length > 0);
    const world = activeWorld();
    assert.deepEqual(world.google.issuedTokens[accessToken]?.scopes, FULL_SCOPE.split(' '));
    assert.equal(world.google.refreshTokens[refreshToken]?.revoked, false);
  } finally {
    server.close();
  }
});

test('a code can only be exchanged once: the second exchange returns invalid_grant', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const approve = await approveConsent(port, { redirectUri: REDIRECT_URI, scope: BASELINE_SCOPE, clientId: ctx.clientId });
    const code = extractCode(approve.headers.get('location') ?? '');
    const first = await exchangeCode(port, { code, redirectUri: REDIRECT_URI, clientId: ctx.clientId, clientSecret: ctx.clientSecret });
    assert.equal(first.status, 200);
    const second = await exchangeCode(port, { code, redirectUri: REDIRECT_URI, clientId: ctx.clientId, clientSecret: ctx.clientSecret });
    assert.equal(second.status, 400);
    assert.deepEqual(await second.json(), { error: 'invalid_grant', error_description: 'Bad Request' });
  } finally {
    server.close();
  }
});

test('exchanging with a redirect_uri that does not match the one the code was issued against returns redirect_uri_mismatch', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const approve = await approveConsent(port, { redirectUri: REDIRECT_URI, scope: BASELINE_SCOPE, clientId: ctx.clientId });
    const code = extractCode(approve.headers.get('location') ?? '');
    const res = await exchangeCode(port, {
      code,
      redirectUri: 'https://oauth.pstmn.io/v1/callback',
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'redirect_uri_mismatch', error_description: 'Bad Request' });
  } finally {
    server.close();
  }
});

test('exchanging with the wrong client_secret returns invalid_client, 401', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const approve = await approveConsent(port, { redirectUri: REDIRECT_URI, scope: BASELINE_SCOPE, clientId: ctx.clientId });
    const code = extractCode(approve.headers.get('location') ?? '');
    const res = await exchangeCode(port, { code, redirectUri: REDIRECT_URI, clientId: ctx.clientId, clientSecret: 'wrong-secret' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'invalid_client', error_description: 'Unauthorized' });
  } finally {
    server.close();
  }
});

test('exchanging an unknown code returns invalid_grant', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const res = await exchangeCode(port, { code: '4/never-issued', redirectUri: REDIRECT_URI, clientId: ctx.clientId, clientSecret: ctx.clientSecret });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_grant', error_description: 'Bad Request' });
  } finally {
    server.close();
  }
});

test('an expired code (past its 60s TTL) returns invalid_grant', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const approve = await approveConsent(port, { redirectUri: REDIRECT_URI, scope: BASELINE_SCOPE, clientId: ctx.clientId });
    const code = extractCode(approve.headers.get('location') ?? '');
    const record = activeWorld().google.authCodes[code];
    if (record) record.expiresAt = Math.floor(Date.now() / 1000) - 1;
    const res = await exchangeCode(port, { code, redirectUri: REDIRECT_URI, clientId: ctx.clientId, clientSecret: ctx.clientSecret });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_grant', error_description: 'Bad Request' });
  } finally {
    server.close();
  }
});

// --- GET /oauth2/v3/userinfo --------------------------------------------------------------

test('userinfo with a valid access token returns 200 with the right identity, scope-gated fields', async () => {
  const ctxLocal = buildTestRunContext();
  resetState(ctxLocal);
  const ctx = { clientId: ctxLocal.google.clientId, clientSecret: ctxLocal.google.clientSecret };
  const { server, port } = await listen();
  try {
    const { accessToken } = await getFreshAccessToken(port, ctx);
    const res = await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { email: string; name: string; sub: string };
    assert.equal(body.email, ctxLocal.user.email);
    assert.equal(body.name, ctxLocal.user.name);
    assert.equal(body.sub, String(ctxLocal.user.id));
  } finally {
    server.close();
  }
});

test('userinfo with no token, a bogus token, or an expired token returns 401 UNAUTHENTICATED', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const noAuth = await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`);
    assert.equal(noAuth.status, 401);
    assert.equal((await noAuth.json() as { error: { status: string } }).error.status, 'UNAUTHENTICATED');

    const bogus = await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, {
      headers: { authorization: 'Bearer this-was-never-issued' },
    });
    assert.equal(bogus.status, 401);

    const { accessToken } = await getFreshAccessToken(port, ctx);
    const record = activeWorld().google.issuedTokens[accessToken];
    if (record) record.expiresAt = Math.floor(Date.now() / 1000) - 1;
    const expired = await fetch(`http://127.0.0.1:${port}/google/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(expired.status, 401);
  } finally {
    server.close();
  }
});

// --- POST /oauth2/token: refresh_token grant ----------------------------------------------

test('refresh_token grant mints a new access token with the same scopes, without rotating the refresh token', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const { accessToken, refreshToken } = await getFreshAccessToken(port, ctx);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
    });
    const res = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    assert.equal(res.status, 200);
    const parsed = (await res.json()) as { access_token: string; scope: string; refresh_token?: string };
    assert.notEqual(parsed.access_token, accessToken, 'a genuinely new access token is minted');
    assert.equal(parsed.scope, FULL_SCOPE);
    assert.equal(parsed.refresh_token, undefined, 'real Google does not rotate the refresh token on use');
  } finally {
    server.close();
  }
});

test('refresh_token grant with an unknown or revoked refresh token returns invalid_grant', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const unknown = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: '1//never-issued',
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
    });
    const res1 = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: unknown.toString(),
    });
    assert.equal(res1.status, 400);
    assert.deepEqual(await res1.json(), { error: 'invalid_grant', error_description: 'Bad Request' });

    const { refreshToken } = await getFreshAccessToken(port, ctx);
    const record = activeWorld().google.refreshTokens[refreshToken];
    if (record) record.revoked = true;
    const revoked = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
    });
    const res2 = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: revoked.toString(),
    });
    assert.equal(res2.status, 400);
    assert.deepEqual(await res2.json(), { error: 'invalid_grant', error_description: 'Bad Request' });
  } finally {
    server.close();
  }
});

// --- POST /oauth2/revoke -------------------------------------------------------------------

test('revoking a refresh token makes the next refresh_token grant against it return invalid_grant', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const { refreshToken } = await getFreshAccessToken(port, ctx);
    const revokeRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    assert.equal(revokeRes.status, 200);

    const refreshBody = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
    });
    const refreshRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: refreshBody.toString(),
    });
    assert.equal(refreshRes.status, 400);
    assert.deepEqual(await refreshRes.json(), { error: 'invalid_grant', error_description: 'Bad Request' });
  } finally {
    server.close();
  }
});

test('revoking an access token cascades to revoke its paired refresh token too', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const { accessToken, refreshToken } = await getFreshAccessToken(port, ctx);
    const revokeRes = await fetch(`http://127.0.0.1:${port}/google/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });
    assert.equal(revokeRes.status, 200);
    assert.equal(activeWorld().google.refreshTokens[refreshToken]?.revoked, true);
  } finally {
    server.close();
  }
});

test('revoking an unrecognized token returns 400 invalid_token', async () => {
  const { server, port } = await listen();
  ctxOf();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/google/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'not-a-real-token' }).toString(),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_token', error_description: 'Invalid Value' });
  } finally {
    server.close();
  }
});

// --- Calendar endpoints: scope gate --------------------------------------------------------

test('calendarList: 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT without the calendar scope, 200 with it', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const { accessToken: narrowToken } = await getFreshAccessToken(port, ctx, BASELINE_SCOPE);
    const denied = await fetch(`http://127.0.0.1:${port}/google/calendar/v3/users/me/calendarList`, {
      headers: { authorization: `Bearer ${narrowToken}` },
    });
    assert.equal(denied.status, 403);
    const deniedBody = (await denied.json()) as { error: { details: Array<{ reason: string }> } };
    assert.equal(deniedBody.error.details[0]?.reason, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');

    const { accessToken: fullToken } = await getFreshAccessToken(port, ctx, FULL_SCOPE);
    const allowed = await fetch(`http://127.0.0.1:${port}/google/calendar/v3/users/me/calendarList`, {
      headers: { authorization: `Bearer ${fullToken}` },
    });
    assert.equal(allowed.status, 200);
    const allowedBody = (await allowed.json()) as { items: unknown[] };
    assert.ok(allowedBody.items.length >= 1);
  } finally {
    server.close();
  }
});

test('calendar events endpoint is scope-gated the same way', async () => {
  const ctx = ctxOf();
  const { server, port } = await listen();
  try {
    const { accessToken } = await getFreshAccessToken(port, ctx, BASELINE_SCOPE);
    const res = await fetch(`http://127.0.0.1:${port}/google/calendar/v3/calendars/primary/events`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});
