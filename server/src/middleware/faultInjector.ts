import type { Request, Response, NextFunction } from 'express';

/**
 * Step 3 of the middleware spine (docs/SPEC.md section 6): if the engine has an active
 * intercept fault matching this request, short-circuit with its verbatim
 * `{status, headers, body}` instead of letting the request reach the healthy platform
 * routers. State faults are not handled here; they mutate the World at activation and
 * the healthy router errors on its own (spec section 7).
 *
 * Stub until Task 3 wires the engine in. The mount point (this file, called from app.ts
 * immediately after requestLog) and the call site both need to exist now so app.ts's
 * mount order is final and Task 3 only fills in the lookup, without touching app.ts.
 */
export function faultInjector(_req: Request, _res: Response, next: NextFunction): void {
  // TODO(Task 3): const fault = engine.activeInterceptFault(_req);
  //               if (fault) { respond verbatim with fault.respond and return; }
  next();
}
