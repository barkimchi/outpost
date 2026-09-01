import { Router } from 'express';
import type { Request, Response } from 'express';
import { activeWorld } from '../world.js';
import { handleAuthorize, handleConsentSubmit } from './consent.js';
import { CALENDAR_READONLY_SCOPE, handleRevoke, handleTokenExchange } from './oauth.js';
import {
  accessTokenScopeInsufficientError,
  calendarEventsBody,
  calendarListBody,
  notFoundError,
  unauthenticatedError,
  userinfoBody,
} from './fixtures.js';
import type { GoogleIssuedToken } from '@gym/shared';

/**
 * `/google` router (docs/SPEC.md section 5). Mounted at `/google` by app.ts; every path
 * below is written relative to that mount point, byte-identical to real Google's paths
 * (the OAuth endpoints and the two Calendar endpoints spec section 5 names), per the same
 * transfer-by-swapping-baseUrl requirement `platforms/github/router.ts` follows.
 *
 * Split three ways, matching docs/SPEC.md's file tree: `consent.ts` (the stateless
 * authorize/consent GET+POST), `oauth.ts` (token exchange + revoke, the actual grant
 * engine), and this file (mounts both plus the resource endpoints token holders call
 * afterward: userinfo and the two Calendar endpoints).
 */

function extractBearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? (match[1] ?? null) : null;
}

interface Authenticated {
  token: string;
  record: GoogleIssuedToken;
}

/** On failure, writes the 401 UNAUTHENTICATED response itself and returns null (docs/SPEC.md
 *  section 11: "Expired/invalid token -> 401 UNAUTHENTICATED"). */
function authenticateOrRespond(req: Request, res: Response): Authenticated | null {
  const token = extractBearerToken(req);
  const world = activeWorld();
  const record = token ? world.google.issuedTokens[token] : undefined;
  const expired = record !== undefined && record.expiresAt < Math.floor(Date.now() / 1000);
  if (!token || !record || expired) {
    res.status(401).json(unauthenticatedError());
    return null;
  }
  return { token, record };
}

export function createGoogleRouter(): Router {
  const router = Router();

  // --- Authorize + consent (consent.ts) -------------------------------------------------
  router.get('/o/oauth2/v2/auth', handleAuthorize);
  router.post('/o/oauth2/v2/auth', handleConsentSubmit);

  // --- Token exchange + revoke (oauth.ts) -----------------------------------------------
  router.post('/oauth2/token', handleTokenExchange);
  router.post('/oauth2/revoke', handleRevoke);

  // --- Resource endpoints ----------------------------------------------------------------

  router.get('/oauth2/v3/userinfo', (req, res) => {
    const auth = authenticateOrRespond(req, res);
    if (!auth) return;
    // Cross-platform identity: RunContext.user (spec section 8) is the same fictional
    // person across every platform this project mocks. platforms/world.ts already
    // populates `world.github.user` straight from `ctx.user`; there is no separate
    // world.google.user, so this reuses that record rather than duplicating identity data
    // that only ever has one source.
    const user = activeWorld().github.user;
    res.json(userinfoBody({ sub: String(user.id), name: user.name, email: user.email, login: user.login, scopes: auth.record.scopes }));
  });

  router
    .route('/calendar/v3/users/me/calendarList')
    .get((req, res) => {
      const auth = authenticateOrRespond(req, res);
      if (!auth) return;
      if (!auth.record.scopes.includes(CALENDAR_READONLY_SCOPE)) {
        res.status(403).json(accessTokenScopeInsufficientError('google.calendar.v3.CalendarList.List', 'calendar.googleapis.com'));
        return;
      }
      const user = activeWorld().github.user;
      res.json(calendarListBody(user.email));
    });

  router
    .route('/calendar/v3/calendars/:calendarId/events')
    .get((req, res) => {
      const auth = authenticateOrRespond(req, res);
      if (!auth) return;
      if (!auth.record.scopes.includes(CALENDAR_READONLY_SCOPE)) {
        res.status(403).json(accessTokenScopeInsufficientError('google.calendar.v3.Events.List', 'calendar.googleapis.com'));
        return;
      }
      res.json(calendarEventsBody(req.params.calendarId ?? 'primary'));
    });

  // Fall-through for any /google path or method this mock has no route registered for at
  // all, registered last so it never shadows a real route above (fix round, finding 7).
  // Google's own real error envelope (code/message/status), not the trainer's generic
  // `{"error":"Not Found","path":"..."}` (app.ts's catch-all): a path typo is the
  // commonest real mistake, and it used to teach the wrong shape.
  router.use((_req, res) => {
    res.status(404).json(notFoundError());
  });

  return router;
}
