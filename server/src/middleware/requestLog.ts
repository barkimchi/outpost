import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { bus } from '../bus.js';
import type { Platform, RequestEvent } from '@gym/shared';

const BODY_CAP_BYTES = 8 * 1024; // 8KB, spec section 6

/**
 * These two exact paths are never logged (spec section 6): logging the SSE route would
 * create a feedback loop (the `log` event the stream itself would then have to deliver),
 * and the outer POST to the proxy endpoint is control-plane noise -- the inner proxied
 * request, which re-enters the server as a genuine HTTP request, is logged on its own
 * way through and is the one that actually matters. Matched by exact path, not content
 * type, per spec.
 */
const SKIP_PATHS = new Set<string>(['/_trainer/events', '/_trainer/api/proxy']);

/** Marker header trainer/proxy.ts adds to its own outbound calls; see shared `source`. */
const PROXY_MARKER_HEADER = 'x-postman-gym-proxy';

const PLATFORM_PREFIXES = new Set<Platform>(['github', 'google', 'glean', 'slack']);

function derivePlatform(reqPath: string): Platform | null {
  const [, first] = reqPath.split('/');
  const candidate = (first ?? '').toLowerCase();
  return PLATFORM_PREFIXES.has(candidate as Platform) ? (candidate as Platform) : null;
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
  if (SKIP_PATHS.has(req.path)) {
    next();
    return;
  }

  // Capture method/path/query NOW, before next(): once the request enters a mounted
  // router (step 4, /_trainer), Express rewrites req.url (and therefore req.path)
  // relative to that router's mount prefix for the duration of the handler. A terminal
  // handler that responds directly, without ever calling next(), leaves that rewrite in
  // place, since Express only restores the original req.url when advancing past the
  // layer. Reading req.path lazily inside finish() below would then observe the
  // stripped path (e.g. '/api/health' instead of '/_trainer/api/health'), which also
  // breaks platform derivation. Capturing here, before any router has touched the
  // request, sidesteps that entirely.
  const capturedMethod = req.method;
  const capturedPath = req.path;
  const capturedQuery = normalizeQuery(req.query);

  const start = process.hrtime.bigint();
  const chunks: Buffer[] = [];
  let capturedBytes = 0;

  function isEventStream(): boolean {
    const contentType = res.getHeader('content-type');
    return typeof contentType === 'string' && contentType.includes('text/event-stream');
  }

  function capture(chunk: unknown, encoding: unknown): void {
    if (chunk === undefined || chunk === null) return;
    if (isEventStream() || capturedBytes >= BODY_CAP_BYTES) return;
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
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const sseSkipped = isEventStream();
    const { text: resBodyText, truncated: resBodyTruncated } = sseSkipped
      ? { text: '', truncated: false }
      : capBuffer(Buffer.concat(chunks));
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
      query: capturedQuery,
      platform: derivePlatform(capturedPath),
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
