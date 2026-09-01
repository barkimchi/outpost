import path from 'node:path';
import fs from 'node:fs';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { WEB_DIST_DIR } from './config.js';
import { rawBodyMiddlewares } from './middleware/rawBody.js';
import { requestLog, emitBodyParserFailureEvent } from './middleware/requestLog.js';
import { faultInjector } from './middleware/faultInjector.js';
import { createTrainerRouter } from './trainer/router.js';
import { createGithubRouter } from './platforms/github/router.js';

/**
 * MOUNT ORDER LIVES HERE. This is the load-bearing part of the whole project
 * (spec section 6, "Middleware spine"). Do not reorder without rereading that section.
 *
 *   1. rawBody          express.json({ verify }) stashing the raw Buffer on req.rawBody.
 *                        Also express.urlencoded + express.text. Slack HMAC verifies the
 *                        exact bytes, so this must run before any parsing that discards them.
 *   2. requestLog        wraps res.write/res.end, captures status + body + timing, emits
 *                        a RequestEvent onto the bus. Skips /_trainer/events and
 *                        /_trainer/api/proxy by exact path.
 *   3. faultInjector     consults the engine for an active intercept fault on this request.
 *                        Stub until Task 3 wires the engine in.
 *   4. /_trainer         trainer router: health, proxy, SSE now; scenarios API, workspace,
 *                        docs, OAuth callback land here in later tasks.
 *   5. platform routers  /github /google /glean /slack (healthy behavior only). /github
 *                        lands in Task 2; /google /glean /slack are not mounted yet.
 *   6. static            web/dist + SPA fallback, PROD ONLY (spec section 6 step 6).
 *                        The platform-prefix guard runs before express.static, not after:
 *                        a request for /github/... etc. must never be answered by a
 *                        static file or the SPA shell, even if web/dist happened to
 *                        contain a colliding path.
 *   7. 404 + error handler
 *
 * Task 0 wired step 4's health check (now moved into trainer/router.ts) and steps 6-7.
 * Task 1 wired steps 1-4 for real and gated step 6 on production. Task 2 mounts /github
 * in step 5.
 */

const PLATFORM_PREFIXES = ['/github', '/google', '/glean', '/slack', '/_trainer'];

function isPlatformPath(requestPath: string): boolean {
  // Express routing (and most real HTTP servers) treats paths case-insensitively at the
  // segment level in practice; compare lowercased so `/GitHub/user` is guarded exactly
  // like `/github/user`, not silently swallowed by the SPA fallback below.
  const lower = requestPath.toLowerCase();
  return PLATFORM_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

export interface CreateAppOptions {
  /** Overrides WEB_DIST_DIR. Tests use this to avoid depending on a real build being present. */
  webDistDir?: string;
  /**
   * Whether to mount the static web/dist + SPA fallback (spec section 6 step 6: "prod
   * only"). Defaults to `NODE_ENV === 'production'` (set by the root `start` script).
   * Tests override this explicitly so results don't depend on ambient NODE_ENV.
   */
  production?: boolean;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const webDistDir = options.webDistDir ?? WEB_DIST_DIR;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const app = express();

  // --- 1. rawBody ---
  app.use(...rawBodyMiddlewares);

  // --- 2. requestLog ---
  app.use(requestLog);

  // --- 3. faultInjector ---
  app.use(faultInjector);

  // --- 4. /_trainer ---
  app.use('/_trainer', createTrainerRouter());

  // --- 5. platform routers (/github now; /google /glean /slack land in later tasks) ---
  app.use('/github', createGithubRouter());
  // /google /glean /slack are not mounted yet: requests to those prefixes fall through
  // to step 6's guard (which never serves them) and then to the 404 handler in step 7.

  // --- 6. static web/dist + SPA fallback (prod only) ---
  if (production) {
    const staticMiddleware = express.static(webDistDir);

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (isPlatformPath(req.path)) {
        next();
        return;
      }
      staticMiddleware(req, res, (err?: unknown) => {
        if (err) {
          next(err);
          return;
        }
        const indexHtml = path.join(webDistDir, 'index.html');
        if (fs.existsSync(indexHtml)) {
          res.sendFile(indexHtml);
          return;
        }
        next();
      });
    });
  }

  // --- 7. 404 + error handler ---
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found', path: req.path });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Malformed JSON (and other body-parser failures) must yield a 400 JSON error, not
    // an HTML stack trace: body-parser marks these with status/statusCode 400 or
    // type 'entity.parse.failed'. Everything else is a genuine 500.
    const isParserFailure = isBodyParserError(err);
    const status = isParserFailure ? 400 : 500;
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    const errorBody = { error: isParserFailure ? 'Bad Request' : 'Internal Server Error', message };
    res.status(status).json(errorBody);

    if (isParserFailure) {
      // rawBody (step 1) mounts above requestLog (step 2), so a body-parser failure
      // jumps straight here without requestLog ever running: without this call, a
      // learner sending malformed JSON got a correct 400 and total engine silence
      // (spec section 6; hard constraint 9). t4-malformed-body is exactly this lesson.
      emitBodyParserFailureEvent(req, res, JSON.stringify(errorBody));
    }
  });

  return app;
}

function isBodyParserError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const withStatus = err as Error & { status?: number; statusCode?: number; type?: string };
  return (
    withStatus.status === 400 || withStatus.statusCode === 400 || withStatus.type === 'entity.parse.failed'
  );
}
