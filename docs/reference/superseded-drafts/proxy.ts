/**
 * Request/response shapes for the built-in proxy (PLAN.md section 7). The web UI builds a
 * ProxyRequest from the Postman-clone panes and POSTs it to /_trainer/api/proxy; the server
 * executes it with undici and returns a ProxyResponse.
 */

export interface ProxyRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
  sizeBytes: number;
}
