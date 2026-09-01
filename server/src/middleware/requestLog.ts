import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { bus } from '../bus.js';
import type { Platform, RequestEvent } from '@gym/shared';

const BODY_CAP_BYTES = 8 * 1024; // 8KB, spec section 6

/**
 * These two paths are never logged (spec section 6): logging the SSE route would create
 * a feedback loop (the `log` event the stream itself would then have to deliver), and
 * the outer POST to the proxy endpoint is control-plane noise -- the inner proxied
 * request, which re-enters the server as a genuine HTTP request, is logged on its own
 * way through and is the one that actually matters. Matched against `pathLower`
 * (lowercased, trailing slash stripped), not the verbatim path and not content type:
 * `/_TRAINER/events` and `/_trainer/events/` both route to the same handler Express does
 * (routing is case-insensitive), so a case-sensitive, exact-match skip set only holds by
 * accident.
 */
const SKIP_PATHS = new Set<string>(['/_trainer/events', '/_trainer/api/proxy']);

/** Marker header trainer/proxy.ts adds to its own outbound calls; see shared `source`. */
const PROXY_MARKER_HEADER = 'x-postman-gym-proxy';

const PLATFORM_PREFIXES = new Set<Platform>(['github', 'google', 'glean', 'slack']);

/**
 * Lowercased, trailing slash stripped (root `/` kept as-is). The engine matches on this,
 * never on the verbatim path (spec section 6): Express routes case-insensitively, so a
 * request whose casing or trailing slash differs from a scenario's matcher would
 * otherwise be invisible to the engine while still getting a real response from the
 * platform mock.
 */
function toPathLower(rawPath: string): string {
  const lower = rawPath.toLowerCase();
  const stripped = lower.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** `pathLower` is already lowercased; derive the platform from its first segment directly. */
function derivePlatform(pathLower: string): Platform | null {
  const [, first] = pathLower.split('/');
  const candidate = (first ?? '') as Platform;
  return PLATFORM_PREFIXES.has(candidate) ? candidate : null;
}

function normalizeHeaders(
  headers: Record<string, string | number | string[] | undefined>,
  excludeKeys: Set<string> = new Set(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || excludeKeys.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function normalizeQuery(query: Request['query']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}

function capBuffer(buf: Buffer): { text: string; truncated: boolean } {
  const truncated = buf.byteLength > BODY_CAP_BYTES;
  const sliced = truncated ? buf.subarray(0, BODY_CAP_BYTES) : buf;
  return { text: sliced.toString('utf8'), truncated };
}

/**
 * Both requestLog's normal `finish()` and `emitBodyParserFailureEvent` (called from
 * app.ts's error handler for step-1 body-parser failures) can end up racing to emit for
 * the SAME response: `isBodyParserError` in app.ts matches on status/type, which a
 * downstream handler could also produce for an unrelated reason after requestLog has
 * already installed its res.write/res.end patch. Whichever path runs first sets this and
 * the other becomes a no-op, so a single request/response cycle can never produce two
 * RequestEvents (spec section 6: guard against double-counting a learner's attempt).
 */
function alreadyEmitted(res: Response): boolean {
  if (res.locals.pgRequestEventEmitted) return true;
  res.locals.pgRequestEventEmitted = true;
  return false;
}

/**
 * Step 2 of the middleware spine (spec section 6). Wraps res.write/res.end to capture
 * the response body for the eventual RequestEvent, without altering what is actually
 * sent to the client: every captured chunk is passed through to the original
 * write/end function completely unchanged, so binary and chunked responses are never
 * corrupted by this middleware. Also skips capture (but never the pass-through call)
 * once `Content-Type: text/event-stream` is observed, as a second line of defense on
 * top of the path-based skip above.
 *
 * The event is built and emitted on `finish`, i.e. once the response has actually
 * completed, per spec ("requestLog wraps res.write/res.end; on finish builds a
 * RequestEvent").
 */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  // Capture method/path/query and derive pathLower NOW, before next(): once the request
  // enters a mounted router (step 4, /_trainer), Express rewrites req.url (and therefore
  // req.path) relative to that router's mount prefix for the duration of the handler. A
  // terminal handler that responds directly, without ever calling next(), leaves that
  // rewrite in place, since Express only restores the original req.url when advancing
  // past the layer. Reading req.path lazily inside finish() below would then observe the
  // stripped path (e.g. '/api/health' instead of '/_trainer/api/health'), which also
  // breaks platform derivation and the skip check. Capturing here, before any router has
  // touched the request, sidesteps that entirely.
  const capturedMethod = req.method;
  const capturedPath = req.path;
  const capturedPathLower = toPathLower(capturedPath);

  if (SKIP_PATHS.has(capturedPathLower)) {
    next();
    return;
  }

  const capturedQuery = normalizeQuery(req.query);

  const start = process.hrtime.bigint();
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let bodyDropped = false;

  function isEventStream(): boolean {
    const contentType = res.getHeader('content-type');
    return typeof contentType === 'string' && contentType.includes('text/event-stream');
  }

  function capture(chunk: unknown, encoding: unknown): void {
    if (chunk === undefined || chunk === null) return;
    if (isEventStream()) return;
    if (capturedBytes >= BODY_CAP_BYTES) {
      // The cap was already hit by an earlier chunk: this chunk (and its bytes) are
      // real, genuinely dropped data, not merely "at the cap". capBuffer() below only
      // sees what made it into `chunks`, so a body whose captured bytes land on exactly
      // BODY_CAP_BYTES would otherwise report truncated: false even though more data
      // existed and was silently discarded right here.
      bodyDropped = true;
      return;
    }
    const enc: BufferEncoding = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8';
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, enc);
    chunks.push(buf);
    capturedBytes += buf.byteLength;
  }

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  // Monkey-patching res.write/res.end is the sanctioned mechanism the brief calls for;
  // Express/Node's overloaded signatures do not cast cleanly, so this one boundary uses
  // `any` deliberately rather than fighting the overloads. Every argument is forwarded
  // to the original function completely unchanged (see capture() above), so this only
  // ever observes bytes, never alters them.
  (res as unknown as { write: unknown }).write = function patchedWrite(
    this: Response,
    chunk: unknown,
    ...rest: unknown[]
  ) {
    capture(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
    return (originalWrite as (...a: unknown[]) => boolean).apply(this, [chunk, ...rest]);
  };

  (res as unknown as { end: unknown }).end = function patchedEnd(
    this: Response,
    chunk?: unknown,
    ...rest: unknown[]
  ) {
    if (chunk !== undefined && typeof chunk !== 'function') {
      capture(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
    }
    const result = (originalEnd as (...a: unknown[]) => Response).apply(this, [chunk, ...rest]);
    finish();
    return result;
  };

  function finish(): void {
    if (alreadyEmitted(res)) return;

    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const sseSkipped = isEventStream();
    const { text: resBodyText, truncated: resBodySizeTruncated } = sseSkipped
      ? { text: '', truncated: false }
      : capBuffer(Buffer.concat(chunks));
    const resBodyTruncated = !sseSkipped && (resBodySizeTruncated || bodyDropped);
    const hasResBody = !sseSkipped && chunks.length > 0;

    let reqBody: string | null = null;
    let reqBodyTruncated = false;
    if (req.rawBody && req.rawBody.byteLength > 0) {
      const capped = capBuffer(req.rawBody);
      reqBody = capped.text;
      reqBodyTruncated = capped.truncated;
    }

    const ev: RequestEvent = {
      id: randomUUID(),
      ts: Date.now(),
      method: capturedMethod,
      path: capturedPath,
      pathLower: capturedPathLower,
      query: capturedQuery,
      platform: derivePlatform(capturedPathLower),
      reqHeaders: normalizeHeaders(
        req.headers as Record<string, string | string[] | undefined>,
        new Set([PROXY_MARKER_HEADER]),
      ),
      reqBody,
      reqBodyTruncated,
      status: res.statusCode,
      resHeaders: normalizeHeaders(res.getHeaders()),
      resBody: hasResBody ? resBodyText : null,
      resBodyTruncated,
      durationMs,
      source: req.headers[PROXY_MARKER_HEADER] ? 'proxy' : 'external',
    };

    bus.emit('request', ev);
  }

  next();
}

/**
 * Called from app.ts's error handler for body-parser failures (malformed JSON, a 413
 * over the 2mb cap, and similar). `rawBody` (step 1) mounts above `requestLog` (step 2),
 * so these errors jump straight to the error handler without requestLog ever running:
 * without this, a learner sending malformed JSON got a correct 400 and total engine
 * silence, violating hard constraint 9 (spec section 6). `t4-malformed-body` is exactly
 * this lesson, so this path has to be observable too.
 *
 * Because the failure happens during body parsing, before the request has ever been
 * dispatched into a mounted router, req.method/req.path are still in their pristine,
 * un-rewritten state here (see the comment on the same capture in requestLog() above),
 * so reading them directly is safe. res.write/res.end were never patched for this
 * response (requestLog never ran), so resBody is built directly from the JSON error body
 * the caller is about to send, rather than intercepted.
 *
 * durationMs is not meaningfully trackable here: the timer that measures it lives inside
 * requestLog's closure, which never runs for this path. 0 is an honest "not measured"
 * rather than a fabricated number.
 *
 * Guarded by the same alreadyEmitted() check as requestLog's finish(), so a status-400
 * error from somewhere other than an actual body-parser failure (which would mean
 * requestLog DID already run and will emit its own event when the response completes)
 * cannot double-emit for the same request.
 */
export function emitBodyParserFailureEvent(req: Request, res: Response, resBodyJson: string): void {
  if (alreadyEmitted(res)) return;

  const pathLower = toPathLower(req.path);

  let reqBody: string | null = null;
  let reqBodyTruncated = false;
  if (req.rawBody && req.rawBody.byteLength > 0) {
    const capped = capBuffer(req.rawBody);
    reqBody = capped.text;
    reqBodyTruncated = capped.truncated;
  }

  const { text: resBodyText, truncated: resBodyTruncated } = capBuffer(Buffer.from(resBodyJson, 'utf8'));

  const ev: RequestEvent = {
    id: randomUUID(),
    ts: Date.now(),
    method: req.method,
    path: req.path,
    pathLower,
    query: normalizeQuery(req.query),
    platform: derivePlatform(pathLower),
    reqHeaders: normalizeHeaders(
      req.headers as Record<string, string | string[] | undefined>,
      new Set([PROXY_MARKER_HEADER]),
    ),
    reqBody,
    reqBodyTruncated,
    status: res.statusCode,
    resHeaders: normalizeHeaders(res.getHeaders()),
    resBody: resBodyText,
    resBodyTruncated,
    durationMs: 0,
    source: req.headers[PROXY_MARKER_HEADER] ? 'proxy' : 'external',
  };

  bus.emit('request', ev);
}
