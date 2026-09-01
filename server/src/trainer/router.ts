import { Router } from 'express';
import { VERSION, PORT } from '../config.js';
import { proxyHandler } from './proxy.js';
import { sseHandler } from './sse.js';

/**
 * `/_trainer` control plane, spec section 6 step 4 and section 10. Task 1 wires health,
 * proxy, and SSE. Later tasks add the scenarios API (Task 3), workspace/docs routes
 * (Task 5), and the OAuth callback (Task 3), as additional routes on this same router,
 * never a rewrite of it.
 */
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

  return router;
}
