import path from 'node:path';
import fs from 'node:fs';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { PORT, VERSION, WEB_DIST_DIR } from './config.js';

/**
 * MOUNT ORDER LIVES HERE. This is the load-bearing part of the whole project
 * (spec section 6, "Middleware spine"). Do not reorder without rereading that section.
 *
 *   1. rawBody          express.json({ verify }) stashing the raw Buffer on req.rawBody.
 *                        Also express.urlencoded + express.text. Slack HMAC verifies the
 *                        exact bytes, so this must run before any parsing that discards them.
 *   2. requestLog        wraps res.write/res.end, captures status + body + timing, emits
 *                        a RequestEvent onto the bus.
 *   3. faultInjector     consults the engine for an active intercept fault on this request.
 *   4. /_trainer         trainer router: health, scenarios API, proxy, SSE, OAuth callback.
 *   5. platform routers  /github /google /glean /slack (healthy behavior only).
 *   6. static            web/dist + SPA fallback (prod only), mounted last, and must never
 *                        swallow /github, /google, /glean, /slack, or /_trainer.
 *   7. 404 + error handler
 *
 * Task 0 only wires the health check (step 4) and the static/SPA fallback plus the 404
 * and error handler (steps 6-7). Steps 1-3 and 5 land in Task 1 and Task 2.
 */

const PLATFORM_PREFIXES = ['/github', '/google', '/glean', '/slack', '/_trainer'];

function isPlatformPath(requestPath: string): boolean {
  return PLATFORM_PREFIXES.some((prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`));
}

export interface CreateAppOptions {
  /** Overrides WEB_DIST_DIR. Tests use this to avoid depending on a real build being present. */
  webDistDir?: string;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const webDistDir = options.webDistDir ?? WEB_DIST_DIR;
  const app = express();

  // --- 4. /_trainer (health only for now; scenarios/proxy/SSE land in Task 1 and 3) ---
  app.get('/_trainer/api/health', (_req, res) => {
    res.json({ ok: true, version: VERSION, port: PORT });
  });

  // --- 6. static web/dist + SPA fallback ---
  app.use(express.static(webDistDir));

  app.get('*', (req, res, next) => {
    if (isPlatformPath(req.path)) {
      next();
      return;
    }
    const indexHtml = path.join(webDistDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
      return;
    }
    next();
  });

  // --- 7. 404 + error handler ---
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found', path: req.path });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: 'Internal Server Error', message });
  });

  return app;
}
