import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { PORT } from '../../config.js';
import { activeWorld } from '../world.js';
import {
  invalidClientError,
  invalidGrantError,
  invalidTokenError,
  redirectUriMismatchError,
  unsupportedGrantTypeError,
} from './fixtures.js';

/**
 * The OAuth 2.0 grant engine: token minting, the two registered redirect URIs, and the
 * `POST /oauth2/token` / `POST /oauth2/revoke` handlers (docs/SPEC.md section 11).
 * `router.ts` mounts these; `consent.ts` handles the authorize/consent half of the flow
 * (docs/SPEC.md file tree: oauth.ts and consent.ts are separate files on purpose, one per
 * half of the flow).
 *
 * Codes and tokens are minted live, at request time, from `node:crypto.randomBytes`
 * directly rather than the run's seeded RNG (`engine/generate.ts`'s `Rng`): the seeded RNG
 * exists so a captured seed reproduces a RUN's data deterministically, but a code/token
 * minted mid-flow is a per-REQUEST value with no reason to be reproducible from the seed
 * (the same precedent `platforms/github/router.ts`'s `githubRequestId()` already sets).
 */

// --- Scopes --------------------------------------------------------------------------

/** The three scopes every scenario's "healthy" consent request carries, matching
 *  `engine/generate.ts`'s `GOOGLE_SCOPES` baseline minus the calendar scope. Exported here
 *  (rather than duplicated as a literal in both `router.ts` and `scenarios/t3-google.ts`)
 *  so there is exactly one place that knows what "the baseline" is. */
export const BASELINE_GOOGLE_SCOPES = ['openid', 'email', 'profile'];

/** Gates the two Calendar endpoints (docs/SPEC.md section 12, t3-insufficient-scope). */
export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/** A real, distinct Google Calendar scope (event read/write, not calendar-list read) used
 *  as t3-insufficient-scope's "decoy" variant: plausible enough to read as "probably
 *  covers this" without a careful diff, but it does not grant calendarList access. */
export const CALENDAR_EVENTS_DECOY_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// --- Registered redirect URIs (docs/SPEC.md section 11) --------------------------------

/**
 * Real Postman intercepts the navigation to this URL itself; it is never actually
 * fetched. Requires "Authorize using browser" UNCHECKED in real Postman's OAuth 2.0 helper
 * (docs/SPEC.md section 11).
 */
export const POSTMAN_INTERCEPT_REDIRECT_URI = 'https://oauth.pstmn.io/v1/callback';

/**
 * The built-in UI's popup callback. Built from the live `PORT` (server/src/config.ts),
 * never a literal: this task's brief calls this out explicitly ("it has already moved
 * twice and a style guard bans one literal outright") and `scripts/check-style.mjs` greps
 * for the specific banned port string project-wide, so any literal port number here is a
 * real risk, not just a style nit.
 */
export function trainerCallbackRedirectUri(): string {
  return `http://localhost:${PORT}/_trainer/oauth/callback`;
}

export function registeredRedirectUris(): string[] {
  return [POSTMAN_INTERCEPT_REDIRECT_URI, trainerCallbackRedirectUri()];
}

export function isRegisteredRedirectUri(uri: string | undefined): uri is string {
  return uri !== undefined && registeredRedirectUris().includes(uri);
}

// --- t3-redirect-mismatch decoys (docs/SPEC.md hard constraint 7a: "randomize ... which
// redirect URI is wrong") ----------------------------------------------------------------

/**
 * Resolves `generate.ts`'s `vars.wrongRedirectVariant` key to an actual near-miss URI.
 * Lives here, not in generate.ts, because it needs the live `PORT` and generate.ts is
 * deliberately config-free and pure (a function of `seed` alone). Each variant is a
 * plausible copy-paste mistake against one of the two genuinely registered URIs: a
 * trailing slash, http instead of https, a dropped path segment, 127.0.0.1 instead of
 * localhost (a very real gotcha: Google's real redirect_uri check is an exact string
 * match, and 127.0.0.1 and localhost are different strings even though they resolve to
 * the same host).
 */
export function resolveWrongRedirectUri(variant: string): string {
  const port = PORT;
  switch (variant) {
    case 'pstmn-trailing-slash':
      return `${POSTMAN_INTERCEPT_REDIRECT_URI}/`;
    case 'pstmn-http':
      return POSTMAN_INTERCEPT_REDIRECT_URI.replace('https://', 'http://');
    case 'pstmn-no-v1':
      return 'https://oauth.pstmn.io/callback';
    case 'localhost-127':
      return `http://127.0.0.1:${port}/_trainer/oauth/callback`;
    case 'localhost-trailing-slash':
      return `${trainerCallbackRedirectUri()}/`;
    case 'localhost-no-trainer-prefix':
      return `http://localhost:${port}/oauth/callback`;
    default:
      // Unreachable given generate.ts only ever draws from WRONG_REDIRECT_VARIANTS, but a
      // safe, still-wrong fallback (not one of the two registered URIs) rather than a
      // throw, if this ever drifts out of sync with that pool.
      return `http://localhost:${port}/oauth/callback`;
  }
}

// --- Token minting -----------------------------------------------------------------------

// UNVERIFIED SHAPE: these three prefixes ("4/", "ya29.", "1//") are the widely observed,
// publicly documented conventions for Google authorization codes, access tokens, and
// refresh tokens respectively, not a byte-exact format Google publishes as a spec; no
// scenario asserts on the exact shape of a token string, only that it exists and works.
function mintAuthCode(): string {
  return `4/${randomBytes(24).toString('base64url')}`;
}

// Exported (not just used internally by the live grant handlers below): t3-revoked-refresh
// and t3-insufficient-scope hand the learner an already-issued, pre-existing credential
// directly in the ticket (mirroring the tier-2 GitHub scenarios' "here is a token already
// on file" framing), minted with the exact same format live-issued tokens use.
export function mintAccessToken(): string {
  return `ya29.${randomBytes(32).toString('base64url')}`;
}

export function mintRefreshToken(): string {
  return `1//${randomBytes(32).toString('base64url')}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Called by `consent.ts`'s POST handler once a consent has been approved with a valid,
 *  registered redirect_uri. Exported so consent.ts (the authorize half of the flow) and
 *  oauth.ts (the token half) share one code-issuance implementation. */
export function issueAuthorizationCode(redirectUri: string, scopes: string[]): string {
  const world = activeWorld();
  const code = mintAuthCode();
  world.google.authCodes[code] = {
    redirectUri,
    scopes,
    expiresAt: nowSec() + 60, // docs/SPEC.md section 11: "Codes are single-use, 60s TTL."
    used: false,
  };
  return code;
}

// --- POST /oauth2/token (docs/SPEC.md section 11) ---------------------------------------

function readBodyField(body: unknown, key: string): string {
  const record = (body ?? {}) as Record<string, unknown>;
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function clientCredentialsMatch(req: Request): boolean {
  const world = activeWorld();
  const clientId = readBodyField(req.body, 'client_id');
  const clientSecret = readBodyField(req.body, 'client_secret');
  return clientId === world.google.clientId && clientSecret === world.google.clientSecret;
}

function handleAuthorizationCodeGrant(req: Request, res: Response): void {
  const world = activeWorld();
  const code = readBodyField(req.body, 'code');
  const redirectUri = readBodyField(req.body, 'redirect_uri');
  const record = code ? world.google.authCodes[code] : undefined;

  if (!record || record.used || record.expiresAt < nowSec()) {
    res.status(400).json(invalidGrantError());
    return;
  }
  if (record.redirectUri !== redirectUri) {
    // docs/SPEC.md section 11 lists redirect_uri_mismatch as its own token-endpoint error,
    // distinct from invalid_grant: the code itself is real and unexpired, but was issued
    // against a DIFFERENT redirect_uri than this exchange is claiming (RFC 6749 section
    // 4.1.3 requires them to match exactly).
    res.status(400).json(redirectUriMismatchError());
    return;
  }
  if (!clientCredentialsMatch(req)) {
    res.status(401).json(invalidClientError());
    return;
  }

  record.used = true;

  const accessToken = mintAccessToken();
  const refreshToken = mintRefreshToken();
  // t3-revoked-refresh's one-shot fault: consumed here, on the FIRST authorization_code
  // grant to reach this point after it was armed, so a second, genuinely new consent
  // later in the same run mints a normal, live refresh token.
  const bornRevoked = world.google.revokeNextRefreshToken;
  if (bornRevoked) world.google.revokeNextRefreshToken = false;

  world.google.issuedTokens[accessToken] = {
    scopes: record.scopes,
    expiresAt: nowSec() + world.google.accessTokenTtlSec,
    pairedRefreshToken: refreshToken,
  };
  world.google.refreshTokens[refreshToken] = { scopes: record.scopes, revoked: bornRevoked };

  res.json({
    access_token: accessToken,
    expires_in: world.google.accessTokenTtlSec,
    refresh_token: refreshToken,
    scope: record.scopes.join(' '),
    token_type: 'Bearer',
  });
}

function handleRefreshTokenGrant(req: Request, res: Response): void {
  const world = activeWorld();
  const refreshToken = readBodyField(req.body, 'refresh_token');
  const record = refreshToken ? world.google.refreshTokens[refreshToken] : undefined;

  if (!record || record.revoked) {
    res.status(400).json(invalidGrantError());
    return;
  }
  if (!clientCredentialsMatch(req)) {
    res.status(401).json(invalidClientError());
    return;
  }

  const accessToken = mintAccessToken();
  world.google.issuedTokens[accessToken] = {
    scopes: record.scopes,
    expiresAt: nowSec() + world.google.accessTokenTtlSec,
    pairedRefreshToken: refreshToken,
  };

  // Real Google does not rotate the refresh token on use (see shared/src/world.ts's
  // GoogleRefreshToken doc comment): the response omits refresh_token entirely, and the
  // caller keeps using the same one it already has.
  res.json({
    access_token: accessToken,
    expires_in: world.google.accessTokenTtlSec,
    scope: record.scopes.join(' '),
    token_type: 'Bearer',
  });
}

export function handleTokenExchange(req: Request, res: Response): void {
  const grantType = readBodyField(req.body, 'grant_type');
  if (grantType === 'authorization_code') {
    handleAuthorizationCodeGrant(req, res);
    return;
  }
  if (grantType === 'refresh_token') {
    handleRefreshTokenGrant(req, res);
    return;
  }
  res.status(400).json(unsupportedGrantTypeError());
}

// --- POST /oauth2/revoke (docs/SPEC.md section 11) ---------------------------------------

export function handleRevoke(req: Request, res: Response): void {
  const world = activeWorld();
  const token = readBodyField(req.body, 'token');

  const refreshRecord = token ? world.google.refreshTokens[token] : undefined;
  if (refreshRecord) {
    refreshRecord.revoked = true;
    res.status(200).json({});
    return;
  }

  // Real Google's revoke endpoint accepts either half of a grant and invalidates the
  // whole thing: handing it the access token must also kill its paired refresh token.
  const accessRecord = token ? world.google.issuedTokens[token] : undefined;
  if (accessRecord) {
    delete world.google.issuedTokens[token];
    if (accessRecord.pairedRefreshToken) {
      const paired = world.google.refreshTokens[accessRecord.pairedRefreshToken];
      if (paired) paired.revoked = true;
    }
    res.status(200).json({});
    return;
  }

  res.status(400).json(invalidTokenError());
}
