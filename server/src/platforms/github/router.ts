import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { GithubTokenRecord } from '@gym/shared';
import { activeWorld } from '../world.js';
import {
  badCredentials,
  methodNotAllowedFixture,
  notFoundFixture,
  rateLimitExceeded,
  resourceNotAccessible,
} from './fixtures.js';

/**
 * `/github` router (docs/SPEC.md section 5). Mounted at `/github` by app.ts; every path
 * below is written relative to that mount point, so it is byte-identical to the real
 * product's path, per spec section 5's transfer-by-swapping-baseUrl requirement.
 *
 * Two deliberate design decisions, made because RunContext and World do not model a
 * fine-grained-vs-classic PAT distinction or a per-repo access-control list:
 *
 * 1. Private-repo visibility (GET /repos/:owner/:repo) is gated on the token's "repo"
 *    scope, matching real classic-PAT behavior: without it, a private repo 404s rather
 *    than 403ing, exactly the "404 can mean no permission" lesson (spec section 12,
 *    scenario t2-private-404). `owner` is accepted but not validated against anything;
 *    RunContext models one org, not a multi-owner graph, and the ticket text always
 *    supplies the run's real org and repo names anyway.
 * 2. The missing-scope 403 lesson (scenario t2-missing-scope) is modeled on
 *    GET /orgs/:org/repos requiring "read:org", a different endpoint than the
 *    private-repo lesson, so the two behaviors (404 vs 403) never contend for the same
 *    request.
 */

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;
const ORG_REPOS_REQUIRED_SCOPE = 'read:org';
const PRIVATE_REPO_REQUIRED_SCOPE = 'repo';

function githubRequestId(): string {
  // Real GitHub's x-github-request-id is groups of hex digits joined by colons, e.g.
  // "C413:11B7B6:2EE667B:994D629:6A9637B0" (verified live 2026-08-31). Purely cosmetic:
  // no scenario asserts on its exact shape, only that it is present.
  const groupLengths = [4, 6, 7, 7, 8];
  return groupLengths
    .map((len) => randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len).toUpperCase())
    .join(':');
}

function extractToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  // docs/SPEC.md hard constraint 11 and this task's brief: both "token X" and
  // "Bearer X" must be accepted.
  const match = header.match(/^(?:token|bearer)\s+(.+)$/i);
  return match ? (match[1] ?? null) : null;
}

interface Authenticated {
  token: string;
  record: GithubTokenRecord;
}

/** On failure, writes the 401 response itself and returns null. */
function authenticateOrRespond(req: Request, res: Response): Authenticated | null {
  const token = extractToken(req);
  const record = token ? activeWorld().github.tokens[token] : undefined;
  if (!token || !record || !record.valid) {
    res.status(401).json(badCredentials());
    return null;
  }
  return { token, record };
}

function applyStandardHeaders(res: Response, record: GithubTokenRecord, requestId: string): void {
  res.set('x-ratelimit-limit', String(record.rateLimit.limit));
  res.set('x-ratelimit-remaining', String(record.rateLimit.remaining));
  res.set('x-ratelimit-reset', String(record.rateLimit.reset));
  res.set('x-ratelimit-used', String(record.rateLimit.used));
  res.set('x-ratelimit-resource', record.rateLimit.resource);
  res.set('x-oauth-scopes', record.scopes.join(', '));
  res.set('x-github-request-id', requestId);
}

/**
 * Charges one request against the token's rate-limit budget. If the budget is already
 * exhausted, writes the 403 rate-limit response itself and returns false; the caller must
 * stop. Otherwise decrements the budget and returns true.
 */
function chargeRateLimitOrRespond(res: Response, record: GithubTokenRecord, userId: number, requestId: string): boolean {
  if (record.rateLimit.remaining <= 0) {
    applyStandardHeaders(res, record, requestId);
    res.set('x-accepted-oauth-scopes', '');
    res.status(403).json(rateLimitExceeded(userId));
    return false;
  }
  record.rateLimit.remaining -= 1;
  record.rateLimit.used += 1;
  return true;
}

function clampPerPage(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PER_PAGE;
  return Math.min(n, MAX_PER_PAGE);
}

function clampPage(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return !Number.isFinite(n) || n < 1 ? 1 : n;
}

/**
 * Matches the real Link header's rel set and ordering, verified live against
 * api.github.com on 2026-08-31 (prev, next, last, first, each present only when it
 * points somewhere other than the current page).
 */
function buildLinkHeader(req: Request, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const base = `${req.protocol}://${req.get('host') ?? ''}${req.baseUrl}${req.path}`;
  const urlFor = (p: number) => `${base}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page < totalPages) parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) parts.push(`<${urlFor(1)}>; rel="first"`);
  return parts.length > 0 ? parts.join(', ') : null;
}

interface RepoRecord {
  name: string;
  private: boolean;
  id: number;
}

// Success bodies are a reasonable approximation of GitHub's real shape, not asserted
// byte-exact by any scenario (only the error fixtures in fixtures.ts carry that
// requirement, per docs/SPEC.md section 7).
function repoBody(repo: RepoRecord, org: string): Record<string, unknown> {
  const fullName = `${org}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: fullName,
    private: repo.private,
    owner: { login: org, type: 'Organization' },
    html_url: `https://github.com/${fullName}`,
    default_branch: 'main',
  };
}

function methodNotAllowed(res: Response): void {
  res.set('Allow', 'GET');
  res.status(405).json(methodNotAllowedFixture());
}

export function createGithubRouter(): Router {
  const router = Router();

  router
    .route('/user')
    .get((req, res) => {
      const requestId = githubRequestId();
      const auth = authenticateOrRespond(req, res);
      if (!auth) return;
      const world = activeWorld();
      if (!chargeRateLimitOrRespond(res, auth.record, world.github.user.id, requestId)) return;
      applyStandardHeaders(res, auth.record, requestId);
      // GET /user needs no scope on real GitHub; the accepted set is empty.
      res.set('x-accepted-oauth-scopes', '');
      res.json({
        login: world.github.user.login,
        id: world.github.user.id,
        name: world.github.user.name,
        email: world.github.user.email,
      });
    })
    .all((_req, res) => methodNotAllowed(res));

  router
    .route('/user/repos')
    .get((req, res) => {
      const requestId = githubRequestId();
      const auth = authenticateOrRespond(req, res);
      if (!auth) return;
      const world = activeWorld();
      if (!chargeRateLimitOrRespond(res, auth.record, world.github.user.id, requestId)) return;

      const perPage = clampPerPage(req.query.per_page);
      const page = clampPage(req.query.page);
      const repos = world.github.repos;
      const start = (page - 1) * perPage;
      const pageItems = repos.slice(start, start + perPage);

      applyStandardHeaders(res, auth.record, requestId);
      res.set('x-accepted-oauth-scopes', '');
      const link = buildLinkHeader(req, page, perPage, repos.length);
      if (link) res.set('Link', link);
      res.json(pageItems.map((repo) => repoBody(repo, world.github.org)));
    })
    .all((_req, res) => methodNotAllowed(res));

  router
    .route('/repos/:owner/:repo')
    .get((req, res) => {
      const requestId = githubRequestId();
      const auth = authenticateOrRespond(req, res);
      if (!auth) return;
      const world = activeWorld();
      if (!chargeRateLimitOrRespond(res, auth.record, world.github.user.id, requestId)) return;

      const repo = world.github.repos.find((r) => r.name === req.params.repo);
      applyStandardHeaders(res, auth.record, requestId);
      res.set('x-accepted-oauth-scopes', PRIVATE_REPO_REQUIRED_SCOPE);

      // GitHub's real privacy behavior (spec section 7, scenario t2-private-404): a
      // private repo the token cannot see returns 404, not 403, and this deliberately
      // does not distinguish "does not exist" from "exists but you lack the repo scope."
      const canSeePrivate = auth.record.scopes.includes(PRIVATE_REPO_REQUIRED_SCOPE);
      if (!repo || (repo.private && !canSeePrivate)) {
        res.status(404).json(notFoundFixture());
        return;
      }

      res.json(repoBody(repo, world.github.org));
    })
    .all((_req, res) => methodNotAllowed(res));

  router
    .route('/orgs/:org/repos')
    .get((req, res) => {
      const requestId = githubRequestId();
      const auth = authenticateOrRespond(req, res);
      if (!auth) return;
      const world = activeWorld();
      if (!chargeRateLimitOrRespond(res, auth.record, world.github.user.id, requestId)) return;

      applyStandardHeaders(res, auth.record, requestId);
      res.set('x-accepted-oauth-scopes', ORG_REPOS_REQUIRED_SCOPE);

      if (req.params.org !== world.github.org) {
        res.status(404).json(notFoundFixture());
        return;
      }

      // Missing-scope lesson (scenario t2-missing-scope): listing an organization's
      // repos needs "read:org" on a classic PAT. Diagnosed by reading X-OAuth-Scopes
      // against X-Accepted-OAuth-Scopes.
      if (!auth.record.scopes.includes(ORG_REPOS_REQUIRED_SCOPE)) {
        res.status(403).json(resourceNotAccessible());
        return;
      }

      const perPage = clampPerPage(req.query.per_page);
      const page = clampPage(req.query.page);
      const repos = world.github.repos;
      const start = (page - 1) * perPage;
      const pageItems = repos.slice(start, start + perPage);
      const link = buildLinkHeader(req, page, perPage, repos.length);
      if (link) res.set('Link', link);
      res.json(pageItems.map((repo) => repoBody(repo, world.github.org)));
    })
    .all((_req, res) => methodNotAllowed(res));

  router
    .route('/rate_limit')
    .get((req, res) => {
      const requestId = githubRequestId();
      const auth = authenticateOrRespond(req, res);
      if (!auth) return;
      // Checking your own rate limit does not itself consume budget on real GitHub
      // (verified live 2026-08-31: two consecutive calls left "remaining" unchanged), so
      // this endpoint reports the current record without charging it.
      applyStandardHeaders(res, auth.record, requestId);
      res.set('x-accepted-oauth-scopes', '');
      res.json({
        resources: { core: { ...auth.record.rateLimit } },
        rate: { ...auth.record.rateLimit },
      });
    })
    .all((_req, res) => methodNotAllowed(res));

  return router;
}
