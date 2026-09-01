import { Router } from 'express';
import type { Request, Response } from 'express';
import { VERSION, PORT } from '../config.js';
import { engine, EngineError } from '../engine/engine.js';
import { proxyHandler } from './proxy.js';
import { sseHandler } from './sse.js';

/**
 * `/_trainer` control plane, spec section 6 step 4 and section 10. Task 1 wired health,
 * proxy, and SSE. This task (3) adds the scenarios/activate/drill/reset/state/hint/
 * solution/explain routes (spec section 10) plus one synthetic warm-up endpoint (see
 * below). Workspace/docs routes and the OAuth callback land in later tasks, as additional
 * routes on this same router, never a rewrite of it.
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

  // --- Synthetic warm-up target for t1-content-type (docs/SPEC.md section 12, scenario
  // 3). This task's dispatch placed platforms/ off limits while a concurrent review runs
  // against it, and no currently mounted /github endpoint accepts a body, so this
  // scenario needs a POST-with-JSON-body target that does not require touching
  // platforms/github/router.ts. /_trainer is the control plane, not a "platform base"
  // mirroring a real product (spec section 5), so a synthetic, clearly-labeled endpoint
  // here is not a byte-identical-path violation. It validates nothing but Content-Type,
  // on purpose: the lesson is entirely about that one header.
  router.post('/api/warmup/content-type', (req: Request, res: Response) => {
    if (!req.is('application/json')) {
      res.status(400).json({
        error: 'Bad Request',
        message: `Content-Type must be application/json. Got: ${req.get('content-type') ?? '(none)'}`,
      });
      return;
    }
    res.status(201).json({ ok: true, received: typeof req.body === 'object' ? req.body : null });
  });

  return router;
}
