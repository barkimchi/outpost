import express, { type Express } from 'express';

/**
 * MOUNT ORDER LIVES HERE. This is the load-bearing part of the whole project
 * (PLAN.md section 2, "Middleware spine"). Do not reorder without rereading that section.
 *
 *   1. rawBody          express.json({ verify }) stashing the raw Buffer on req.rawBody.
 *                        ALSO express.urlencoded + express.text where the platform needs it.
 *                        Slack HMAC verifies the RAW bytes. Parse-then-restringify will never
 *                        match, so this must run before any body parsing that discards the
 *                        original bytes.
 *   2. requestLog        wraps res.write/res.end, captures status + body + timing, emits
 *                        RequestEvent onto the bus. Must NOT log /_trainer/sse itself
 *                        (infinite loop) and must cap captured bodies at ~64 KB.
 *   3. faultInjector      consults the active scenario, applies a matching intercept fault.
 *   4. platform routers   /github /google /glean /slack (healthy behaviour only).
 *   5. trainer router     /_trainer (scenarios API, proxy, SSE, OAuth callback).
 *   6. static              web/dist + SPA fallback (prod only, mounted LAST).
 *
 * Phase 0 only registers a bare health check on /_trainer so later phases have a place to
 * plug in steps 1-6 above without re-deriving the order.
 */
export function createApp(): Express {
  const app = express();

  // --- Phase 0 placeholder. Phases 1+ insert the mount order documented above, here. ---

  app.get('/_trainer/health', (_req, res) => {
    res.json({ ok: true, name: 'postman-gym', version: '0.0.0' });
  });

  return app;
}
