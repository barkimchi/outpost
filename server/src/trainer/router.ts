import { join } from 'node:path';
import { Router } from 'express';
import type { Response } from 'express';
import type { Workspace } from '@gym/shared';
import { defaultWorkspace } from '@gym/shared';
import { VERSION, PORT, DATA_DIR } from '../config.js';
import { engine, EngineError } from '../engine/engine.js';
import { JsonStore } from '../engine/persist.js';
import { proxyHandler } from './proxy.js';
import { sseHandler } from './sse.js';
import { getDocHandler, listDocsHandler } from './docs.js';

/**
 * `/_trainer` control plane, spec section 6 step 4 and section 10. Task 1 wired health,
 * proxy, and SSE. Task 3 added the scenarios/activate/drill/reset/state/hint/solution/
 * explain routes (spec section 10). This task (5) adds the docs routes (`docs.ts`, backed
 * by `content/index.ts`) and the workspace routes below. The OAuth callback
 * (`GET /_trainer/oauth/callback`) lands in a later task, as an additional route on this
 * same router, never a rewrite of it.
 *
 * Fix round after Task 3: this file used to also carry a synthetic
 * `POST /api/warmup/content-type` endpoint, added only because `platforms/` was off
 * limits during the original build and no mounted `/github` route accepted a body.
 * Removed once that constraint lifted: `t1-content-type` now targets the real
 * `POST /github/user/repos` endpoint in `platforms/github/router.ts`, per spec section 5
 * ("paths under a platform base are byte-identical to the real product's").
 */

function sendEngineError(res: Response, err: unknown): void {
  if (err instanceof EngineError) {
    res.status(err.status).json({ error: err.name, message: err.message });
    return;
  }
  throw err; // not ours to interpret; let app.ts's error handler produce a real 500
}

/**
 * `data/workspace.json` (docs/SPEC.md section 3: "written atomically via
 * write-temp-then-rename, debounced 250ms", same convention `progress.json` already uses
 * via `engine/persist.ts`'s `JsonStore`). A module-level singleton, same pattern
 * `engine/persist.ts`'s own `progressStore` uses: created once at import time, reading
 * `DATA_DIR` (overridable via `POSTMAN_GYM_DATA_DIR` so `npm test` never touches the real
 * `data/workspace.json`, exactly like `progressStore`'s own header comment explains).
 */
const workspaceStore = new JsonStore<Workspace>(join(DATA_DIR, 'workspace.json'), defaultWorkspace());

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Light structural validation, the same convention `proxy.ts`'s own body checks use: just
 *  enough to reject obviously-wrong input with a clear 400 rather than corrupting the
 *  on-disk workspace or crashing on a `PUT` from a hand-written or buggy client. Not a full
 *  deep schema validator; the one client that calls this (`web/src/state/store.ts`'s
 *  `buildWorkspaceSnapshot`) always sends the complete, correctly-shaped object. */
function isValidWorkspacePayload(body: unknown): body is Workspace {
  if (!isPlainObject(body)) return false;
  if (!Array.isArray(body.collections)) return false;
  if (!Array.isArray(body.environments)) return false;
  if (typeof body.notes !== 'string') return false;
  if (!isPlainObject(body.draft)) return false;
  if (!isPlainObject(body.ui)) return false;
  return true;
}

export function createTrainerRouter(): Router {
  const router = Router();

  router.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: VERSION, port: PORT });
  });

  router.post('/api/proxy', (req, res) => {
    proxyHandler(req, res).catch((err: unknown) => {
      res.status(500).json({
        error: 'Internal Server Error',
        message: err instanceof Error ? err.message : 'proxy handler failed',
      });
    });
  });

  router.get('/events', sseHandler);

  // --- Scenarios API (docs/SPEC.md section 10) ---

  router.get('/api/scenarios', (_req, res) => {
    res.json(engine.listScenarios());
  });

  router.post('/api/scenarios/:id/activate', (req, res) => {
    try {
      res.json(engine.activate(req.params.id ?? ''));
    } catch (err) {
      sendEngineError(res, err);
    }
  });

  router.post('/api/scenarios/drill', (req, res) => {
    try {
      const body = (req.body ?? {}) as { tier?: unknown };
      const tier = typeof body.tier === 'number' ? body.tier : undefined;
      res.json(engine.activateDrill(tier));
    } catch (err) {
      sendEngineError(res, err);
    }
  });

  router.post('/api/scenarios/reset', (_req, res) => {
    try {
      engine.reset();
      res.json({ ok: true });
    } catch (err) {
      sendEngineError(res, err);
    }
  });

  router.get('/api/state', (_req, res) => {
    res.json(engine.getState());
  });

  router.post('/api/hint', (_req, res) => {
    try {
      res.json(engine.hint());
    } catch (err) {
      sendEngineError(res, err);
    }
  });

  router.post('/api/solution', (_req, res) => {
    try {
      res.json(engine.revealSolution());
    } catch (err) {
      sendEngineError(res, err);
    }
  });

  router.post('/api/explain', (req, res) => {
    try {
      const body = (req.body ?? {}) as { rootCause?: unknown; customerReply?: unknown };
      if (typeof body.rootCause !== 'string' || typeof body.customerReply !== 'string') {
        res.status(400).json({ error: 'Bad Request', message: 'rootCause and customerReply must both be strings' });
        return;
      }
      res.json(engine.explain(body.rootCause, body.customerReply));
    } catch (err) {
      sendEngineError(res, err);
    }
  });

  // --- Docs (docs/SPEC.md section 10) ---

  router.get('/api/docs', listDocsHandler);
  router.get('/api/docs/:id', getDocHandler);

  // --- Workspace (docs/SPEC.md section 4/10/13) ---

  router.get('/api/workspace', (_req, res) => {
    res.json(workspaceStore.get());
  });

  router.put('/api/workspace', (req, res) => {
    if (!isValidWorkspacePayload(req.body)) {
      res.status(400).json({ error: 'Bad Request', message: 'invalid workspace payload' });
      return;
    }
    const incoming = req.body;
    // Full replace, expressed as a mutation because JsonStore's API is mutate-in-place
    // (`update(mutate)`, no `set`): the client always sends the complete workspace object
    // (`web/src/state/store.ts`'s `buildWorkspaceSnapshot`), so overwriting every key here
    // is equivalent to a real replace, not a partial merge.
    workspaceStore.update((current) => {
      Object.assign(current, incoming);
    });
    res.json({ ok: true });
  });

  return router;
}
