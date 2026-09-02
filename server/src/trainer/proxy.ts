import type { Request, Response } from 'express';
import { request as undiciRequest } from 'undici';
import { PORT } from '../config.js';

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '0.0.0.0']);

interface ProxyRequestBody {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  body?: unknown;
}

/**
 * The allowed port is the port THIS connection actually arrived on
 * (`req.socket.localPort`), not the statically imported `PORT` config value. Those
 * usually agree, but not always: tests boot the app on an OS-assigned ephemeral port
 * (`listen(0)`) precisely to avoid colliding with a real dev server or with this
 * machine's permanently reserved ports (docs/SPEC.md section 2), and a live process can
 * also be restarted with a different `PORT` env value than whatever this module
 * happened to resolve at import time.
 * Deriving it from the live socket keeps the guarantee ("only this server, whatever
 * port it is actually on") true unconditionally.
 */
function isAllowedTarget(target: URL, serverPort: number): boolean {
  if (target.protocol !== 'http:') return false;
  if (!ALLOWED_HOSTNAMES.has(target.hostname)) return false;
  const port = target.port === '' ? '80' : target.port;
  return Number(port) === serverPort;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: 'Bad Request', message });
}

/**
 * `POST /_trainer/api/proxy`, spec section 10. This is the built-in Postman clone's only
 * way to reach the platform routers, and it is localhost-only by allowlist: a training
 * tool must never become an open SSRF relay. Forwards method/headers/body via
 * `undici.request`, follows no redirects, and returns the response verbatim.
 *
 * The proxied request re-enters the server as a genuine HTTP request (to
 * `http://127.0.0.1:<PORT>/...`), so `requestLog` sees and logs it exactly like it would
 * see a request from real Postman desktop, just tagged `source: 'proxy'` via the marker
 * header added below.
 */
export async function proxyHandler(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as ProxyRequestBody;

  if (typeof body.method !== 'string' || body.method.trim() === '') {
    badRequest(res, 'proxy requires a string "method" field');
    return;
  }
  if (typeof body.url !== 'string' || body.url.trim() === '') {
    badRequest(res, 'proxy requires a string "url" field');
    return;
  }
  if (body.headers !== undefined && (typeof body.headers !== 'object' || body.headers === null)) {
    badRequest(res, '"headers" must be an object of header name to string value');
    return;
  }
  if (body.body !== undefined && typeof body.body !== 'string') {
    badRequest(res, '"body" must be a string if present');
    return;
  }

  let target: URL;
  try {
    target = new URL(body.url);
  } catch {
    badRequest(res, `"url" is not a valid URL: ${body.url}`);
    return;
  }

  const serverPort = req.socket.localPort ?? PORT;
  if (!isAllowedTarget(target, serverPort)) {
    badRequest(
      res,
      `proxy only permits http://127.0.0.1:${serverPort}, http://localhost:${serverPort}, or ` +
        `http://0.0.0.0:${serverPort} as a target. Got: ${body.url}`,
    );
    return;
  }

  const forwardedHeaders: Record<string, string> = {
    ...(body.headers as Record<string, string> | undefined),
    'x-outpost-proxy': '1',
  };

  const start = process.hrtime.bigint();
  try {
    const upstream = await undiciRequest(target, {
      method: body.method.toUpperCase() as never,
      headers: forwardedHeaders,
      body: typeof body.body === 'string' ? body.body : undefined,
      maxRedirections: 0,
    });

    const responseBody = Buffer.from(await upstream.body.arrayBuffer());
    const timeMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (value === undefined) continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }

    res.status(200).json({
      status: upstream.statusCode,
      headers,
      body: responseBody.toString('utf8'),
      timeMs,
      sizeBytes: responseBody.byteLength,
    });
  } catch (err) {
    res.status(502).json({
      error: 'Bad Gateway',
      message: err instanceof Error ? err.message : 'proxy request failed',
    });
  }
}
