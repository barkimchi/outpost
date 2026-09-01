import type { Request, Response, NextFunction } from 'express';
import { engine } from '../engine/engine.js';
import type { MatchableRequest } from '../engine/match.js';
import { normalizeQuery, toPathLower } from './requestLog.js';

/**
 * Step 3 of the middleware spine (docs/SPEC.md section 6): if the engine has an active
 * intercept fault matching this request, short-circuit with its verbatim
 * `{status, headers, body}` instead of letting the request reach the healthy platform
 * routers. State faults are not handled here; they mutate the World at activation and
 * the healthy router errors on its own (spec section 7).
 *
 * Wired in during the Task 3 fix round: `middleware/` was off limits for the original
 * Task 3 build (a concurrent review was running against it), so `engine.ts` shipped
 * `activeInterceptFault()` fully implemented and unit-tested but uncalled. This is the
 * one-line call site that was always the plan; `toPathLower`/`normalizeQuery` are
 * imported from `requestLog.ts` (exported there for this reason) so `pathLower` is
 * derived identically on both the logging path and this short-circuit path, rather than
 * a second copy of that logic drifting out of sync.
 *
 * Runs at step 3, before any router (step 4/5) has touched the request, so `req.path` is
 * still the full, unrewritten path, same as `requestLog`'s step-2 capture.
 *
 * `createFaultInjector` takes the engine as a parameter, rather than the middleware
 * closing over the singleton directly, so `faultInjector.test.ts` can exercise the
 * intercept-fires branch against a small fake (`{activeInterceptFault: () => ...}`)
 * without needing to smuggle a fake scenario into the production singleton's fixed
 * registry. The plain `faultInjector` export below, bound to the real singleton, is what
 * `app.ts` mounts.
 */
export function createFaultInjector(engineLike: {
  activeInterceptFault(req: MatchableRequest): { status: number; headers: Record<string, string>; body: string } | undefined;
}) {
  return function faultInjector(req: Request, res: Response, next: NextFunction): void {
    const reqLike: MatchableRequest = {
      method: req.method,
      pathLower: toPathLower(req.path),
      query: normalizeQuery(req.query),
      headerNames: Object.keys(req.headers).map((h) => h.toLowerCase()),
    };

    const fault = engineLike.activeInterceptFault(reqLike);
    if (fault) {
      res.status(fault.status);
      for (const [name, value] of Object.entries(fault.headers)) {
        res.set(name, value);
      }
      res.send(fault.body);
      return;
    }

    next();
  };
}

export const faultInjector = createFaultInjector(engine);
