import { Router } from 'express';
import type { Response } from 'express';
import { VERSION, PORT } from '../config.js';
import { engine, EngineError } from '../engine/engine.js';
import { proxyHandler } from './proxy.js';
import { sseHandler } from './sse.js';

/**
 * `/_trainer` control plane, spec section 6 step 4 and section 10. Task 1 wired health,
 * proxy, and SSE. Task 3 added the scenarios/activate/drill/reset/state/hint/solution/
 * explain routes (spec section 10). Workspace/docs routes and the OAuth callback land in
 * later tasks, as additional routes on this same router, never a rewrite of it.
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

  return router;
}
