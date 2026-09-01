import { Router } from 'express';
import type { Request, Response } from 'express';
import type { World } from '@gym/shared';
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
 *
 * Second fix round (product-coherence, not a bug report): `POST /rest/api/v1/search` and
 * the indexing endpoints used to read two entirely separate World registries
 * (`world.glean.docs`, the pre-seeded corpus, versus `world.glean.indexedDocs`, live
 * indexing state), so indexing a document had zero observable effect on search. "Index a
 * document, then find it" is the core loop the real Glean product sells, and
 * `impl-glean`'s third step ("verify they come back from search") cannot be taught
 * without it. `allSearchableDocs()` below is now the SINGLE source of truth both the
 * search handler and `getdocumentstatus` read from: the seeded corpus works before
 * anything is indexed, and a live-indexed document (upserted by id, so re-indexing an
 * existing id updates rather than duplicates it) joins the same pool. This is also why
 * `getdocumentstatus` can never disagree with what search can see: both derive from this
 * one function, not two independently-maintained views of "what's indexed."
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
  body?: string;
}

/** Real Glean's documented indexing payload nests body text as `document.body.textContent`
 *  (a `{mimeType, textContent}` object); a plain string is also accepted here as a
 *  reasonable, lower-friction alternative for a training mock, not a claim that real Glean
 *  accepts it too. Either shape is optional: a document indexed with only a title is still
 *  a genuine, findable document, matched on title alone (see `gleanSearchResponse`). */
function readBodyText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'textContent' in value) {
    const textContent = (value as Record<string, unknown>).textContent;
    return typeof textContent === 'string' ? textContent : undefined;
  }
  return undefined;
}

function readIndexDoc(value: unknown): IndexDocInput | null {
  const record = (value ?? {}) as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim() === '') return null;
  if (typeof record.datasource !== 'string' || record.datasource.trim() === '') return null;
  const title = typeof record.title === 'string' ? record.title : undefined;
  const body = readBodyText(record.body);
  return { id: record.id, datasource: record.datasource, title, body };
}

// --- The single searchable pool (search + getdocumentstatus both read this) -------------

interface SearchableDoc {
  id: string;
  datasource: string;
  title: string;
  body: string;
  /** Present only for a document actually indexed live during this run; absent for a
   *  seeded (pre-existing) document, so getdocumentstatus never fabricates a timestamp for
   *  something that was never really indexed this run (see fixtures.ts's
   *  `gleanDocumentStatus` doc comment). */
  indexedAt?: number;
}

/**
 * Seeded docs (`world.glean.docs`) first, keyed by id, then live-indexed docs
 * (`world.glean.indexedDocs`) layered on top: indexing a document whose id matches a
 * seeded one is an upsert (updates it in place), matching real Glean's actual indexing
 * behavior, rather than producing a duplicate search result for the same id. A seeded
 * doc's `datasource` is `world.glean.datasource` (the company's one KB datasource;
 * `RunContext.glean.docs` carries no per-doc datasource of its own, see shared/src/
 * scenario.ts's frozen contract), which is also what `getdocumentstatus` must be asked
 * for to resolve a seeded id, exactly mirroring how a live-indexed doc is only resolved
 * under the SAME datasource it was indexed with.
 */
function allSearchableDocs(world: World): SearchableDoc[] {
  const byId = new Map<string, SearchableDoc>();
  for (const doc of world.glean.docs) {
    byId.set(doc.id, { id: doc.id, datasource: world.glean.datasource, title: doc.title, body: doc.body });
  }
  for (const doc of Object.values(world.glean.indexedDocs)) {
    byId.set(doc.id, {
      id: doc.id,
      datasource: doc.datasource,
      title: doc.title ?? '',
      body: doc.body ?? '',
      indexedAt: doc.indexedAt,
    });
  }
  return [...byId.values()];
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
    res.json(gleanSearchResponse(validation.query ?? '', allSearchableDocs(world)));
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
    world.glean.indexedDocs[doc.id] = { id: doc.id, datasource: doc.datasource, title: doc.title, body: doc.body, indexedAt: Date.now() };
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
      world.glean.indexedDocs[doc.id] = { id: doc.id, datasource: doc.datasource, title: doc.title, body: doc.body, indexedAt: Date.now() };
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
    // Resolved from the exact same pool search reads (allSearchableDocs()), so this can
    // never report NOT_FOUND for an id search would actually return, or vice versa
    // (product-coherence fix round: "an inconsistency between two endpoints in a mock
    // designed to teach diagnosis is a cruel joke").
    const found = allSearchableDocs(world).find((d) => d.id === id && d.datasource === datasource);
    res.json(gleanDocumentStatus(id, datasource, found ? { title: found.title, indexedAt: found.indexedAt } : undefined));
  });

  return router;
}
