import express from 'express';
import type { Request, Response } from 'express';

/**
 * Module augmentation: every Express Request gains an optional `rawBody: Buffer`. This
 * is a global declaration merge, so any file in this TS program sees `req.rawBody`
 * without importing this file directly, as long as this file is part of the program
 * (it is: `server/tsconfig.json` includes all of `src`).
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * The exact bytes of the request body, captured before any parsing discards them.
       * Slack HMAC verification (a later task) signs over these exact bytes, so this
       * must be a faithful Buffer, not a re-serialization of the parsed body (spec
       * section 2, hard constraint 4). Present only when a body parser below actually
       * matched the request's Content-Type; absent (undefined) for bodyless requests.
       */
      rawBody?: Buffer;
    }
  }
}

const BODY_LIMIT = '2mb';

function stashRawBody(req: Request, _res: Response, buf: Buffer): void {
  req.rawBody = buf;
}

/**
 * The `express.json/urlencoded/text` stack (docs/SPEC.md section 6, step 1). Each parser
 * only acts when the request's Content-Type matches its own `type` predicate; the others
 * pass through untouched via `next()`. Whichever one fires stashes the exact raw bytes
 * onto `req.rawBody` via `verify`, per spec's sanctioned mechanism, before its own
 * parsing (which may reserialize or coerce the body) ever runs.
 *
 * Malformed JSON throws inside `express.json`'s parser; app.ts's error handler turns
 * that into a 400 JSON response rather than Express's default HTML stack trace.
 */
export const jsonBodyParser = express.json({ limit: BODY_LIMIT, verify: stashRawBody });

export const urlencodedBodyParser = express.urlencoded({
  extended: true,
  limit: BODY_LIMIT,
  verify: stashRawBody,
});

export const textBodyParser = express.text({
  type: ['text/*', 'application/xml'],
  limit: BODY_LIMIT,
  verify: stashRawBody,
});

/** Mount all three, in this order, as step 1 of the middleware spine. */
export const rawBodyMiddlewares = [jsonBodyParser, urlencodedBodyParser, textBodyParser];
