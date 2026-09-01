import { Router } from 'express';
import type { Request, Response } from 'express';
import { activeWorld } from '../world.js';
import {
  gleanAuthenticationRequired,
  gleanChatResponse,
  gleanDocumentStatus,
  gleanIndexSuccess,
  gleanInvalidRequest,
  gleanSearchResponse,
} from './fixtures.js';

/**
 * `/glean` router (docs/SPEC.md section 5). Mounted at `/glean` by app.ts; every path
 * below is written relative to that mount point, byte-identical to Glean's real REST API
 * paths (`POST /rest/api/v1/search`, `POST /rest/api/v1/chat`, the three `/api/index/v1/*`
 * indexing endpoints), per the same transfer-by-swapping-baseUrl requirement
 * `platforms/github/router.ts` and `platforms/google/router.ts` already follow.
 *
 * The whole platform's central lesson (docs/SPEC.md section 12, scenario t4-token-type):
 * Glean issues two SEPARATE credential types, a Client API token and an Indexing API
 * token, confirmed by developers.glean.com to be mutually exclusive ("a Client API token
 * cannot be used as an Indexing API token" and vice versa). Both use the identical
 * `Authorization: Bearer <token>` header, so nothing about the REQUEST shape distinguishes
 * them; only which endpoint accepts which token does. `authenticateOrRespond()` below is
 * the one place that gate lives: the search/chat endpoints (Client API) accept only
 * `world.glean.clientToken`, the three indexing endpoints accept only
 * `world.glean.indexingToken`, and presenting the OTHER real, validly-issued token to the
 * wrong endpoint is a genuine 401, worded generically (see fixtures.ts's
 * `gleanAuthenticationRequired` comment: nothing in the error body names which kind of
 * token was expected, matching the task-7 brief's framing of this exact lesson).
 */

type TokenKind = 'client' | 'indexing';

function extractBearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? (match[1] ?? null) : null;
}

/** On failure, writes the 401 response itself and returns null. `kind` selects which of
 *  the two real tokens this endpoint accepts; the OTHER real token, or no token at all, or
 *  a token that never existed, all fail identically. */
function authenticateOrRespond(req: Request, res: Response, kind: TokenKind): true | null {
  const token = extractBearerToken(req);
  const world = activeWorld();
  const expected = kind === 'client' ? world.glean.clientToken : world.glean.indexingToken;
  if (!token || token !== expected) {
    res.status(401).json(gleanAuthenticationRequired('Request had invalid or missing authentication credentials.'));
    return null;
  }
  return true;
}

// --- Search request validation (docs/SPEC.md section 12, t4-malformed-body) -------------
//
// `query` is Glean's own confirmed-required field (fixtures.ts header comment). `pageSize`
// is this mock's own additional required field, deliberately, so t4-malformed-body has a
// second genuine candidate to randomize which-field-is-missing between (hard constraint
// 7a); real Glean likely defaults `pageSize` when omitted, and the Docs tab for this
// platform says so explicitly rather than silently claiming byte-exact parity here.

interface SearchValidationResult {
  ok: boolean;
  query?: string;
}

function validateSearchBody(body: unknown): SearchValidationResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const query = record.query;
  const pageSize = record.pageSize;
  if (typeof query !== 'string' || query.trim() === '') return { ok: false };
  if (typeof pageSize !== 'number' || !Number.isFinite(pageSize) || pageSize <= 0) return { ok: false };
  return { ok: true, query };
}

// --- Index document body validation ------------------------------------------------------

interface IndexDocInput {
  id: string;
  datasource: string;
  title?: string;
}

function readIndexDoc(value: unknown): IndexDocInput | null {
  const record = (value ?? {}) as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim() === '') return null;
  if (typeof record.datasource !== 'string' || record.datasource.trim() === '') return null;
  const title = typeof record.title === 'string' ? record.title : undefined;
  return { id: record.id, datasource: record.datasource, title };
}

export function createGleanRouter(): Router {
  const router = Router();

  // --- Client API: search + chat --------------------------------------------------------

  router.post('/rest/api/v1/search', (req, res) => {
    if (!authenticateOrRespond(req, res, 'client')) return;
    const validation = validateSearchBody(req.body);
    if (!validation.ok) {
      res.status(400).json(gleanInvalidRequest('The request body is missing one or more required fields.'));
      return;
    }
    const world = activeWorld();
    res.json(gleanSearchResponse(validation.query ?? '', world.glean.docs));
  });

  router.post('/rest/api/v1/chat', (req, res) => {
    if (!authenticateOrRespond(req, res, 'client')) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json(gleanInvalidRequest('The request body is missing one or more required fields.'));
      return;
    }
    res.json(gleanChatResponse());
  });

  // --- Indexing API: indexdocument / indexdocuments / getdocumentstatus -----------------

  router.post('/api/index/v1/indexdocument', (req, res) => {
    if (!authenticateOrRespond(req, res, 'indexing')) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const doc = readIndexDoc(body.document);
    if (!doc) {
      res.status(400).json(gleanInvalidRequest('The request body is missing one or more required fields.'));
      return;
    }
    const world = activeWorld();
    world.glean.indexedDocs[doc.id] = { id: doc.id, datasource: doc.datasource, title: doc.title, indexedAt: Date.now() };
    res.json(gleanIndexSuccess());
  });

  router.post('/api/index/v1/indexdocuments', (req, res) => {
    if (!authenticateOrRespond(req, res, 'indexing')) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawDocs = body.documents;
    if (!Array.isArray(rawDocs) || rawDocs.length === 0) {
      res.status(400).json(gleanInvalidRequest('The request body is missing one or more required fields.'));
      return;
    }
    const docs = rawDocs.map(readIndexDoc);
    if (docs.some((d) => d === null)) {
      res.status(400).json(gleanInvalidRequest('The request body is missing one or more required fields.'));
      return;
    }
    const world = activeWorld();
    for (const doc of docs) {
      if (!doc) continue; // unreachable given the .some() guard above; narrows the type
      world.glean.indexedDocs[doc.id] = { id: doc.id, datasource: doc.datasource, title: doc.title, indexedAt: Date.now() };
    }
    res.json(gleanIndexSuccess());
  });

  router.get('/api/index/v1/getdocumentstatus', (req, res) => {
    if (!authenticateOrRespond(req, res, 'indexing')) return;
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const datasource = typeof req.query.datasource === 'string' ? req.query.datasource : '';
    if (id === '' || datasource === '') {
      res.status(400).json(gleanInvalidRequest('The request is missing one or more required query parameters.'));
      return;
    }
    const world = activeWorld();
    const indexed = world.glean.indexedDocs[id]?.datasource === datasource;
    res.json(gleanDocumentStatus(id, datasource, indexed));
  });

  return router;
}
