import type { RequestEvent, RequestMatcher } from '@gym/shared';

/**
 * `RequestMatcher` evaluation (docs/SPEC.md section 8, section 9). Matching happens
 * against a small normalized shape, `MatchableRequest`, rather than a full
 * `RequestEvent` directly: `engine.activeInterceptFault()` (docs/SPEC.md section 7) needs
 * to match a fault BEFORE a response exists, from the middleware layer, so the same
 * matching logic has to work from either a completed `RequestEvent` (via `toMatchable`)
 * or an in-flight request once that call site is wired in.
 *
 * `pathLower` is the only path field ever compared here (docs/SPEC.md section 6, hard
 * rule): a scenario author writes `pathPattern` in lowercase, and this function never
 * applies a case-insensitive flag, so a pattern written in the wrong case fails loudly in
 * a scenario's own tests rather than silently matching real GitHub's case-insensitive
 * routing by accident.
 */
export interface MatchableRequest {
  method: string;
  pathLower: string;
  query: Record<string, string>;
  /** Lowercased request header names present on the request. */
  headerNames: string[];
}

export function toMatchable(ev: RequestEvent): MatchableRequest {
  return {
    method: ev.method,
    pathLower: ev.pathLower,
    query: ev.query,
    headerNames: Object.keys(ev.reqHeaders).map((h) => h.toLowerCase()),
  };
}

export function matchesRequest(matcher: RequestMatcher, req: MatchableRequest): boolean {
  if (matcher.method) {
    const methods = Array.isArray(matcher.method) ? matcher.method : [matcher.method];
    if (!methods.some((m) => m.toUpperCase() === req.method.toUpperCase())) return false;
  }

  let pathRegex: RegExp;
  try {
    // `pathPattern` is a RegExp source, "anchored by the matcher" (docs/SPEC.md section
    // 8): the matcher itself supplies the ^...$ anchors, so scenario authors write bare
    // patterns like '^/github/user$' without double-anchoring concerns beyond that.
    pathRegex = new RegExp(`^(?:${matcher.pathPattern})$`);
  } catch {
    return false;
  }
  if (!pathRegex.test(req.pathLower)) return false;

  if (matcher.queryIncludes) {
    for (const [key, value] of Object.entries(matcher.queryIncludes)) {
      if (req.query[key] !== value) return false;
    }
  }

  if (matcher.reqHeaderPresent) {
    for (const name of matcher.reqHeaderPresent) {
      if (!req.headerNames.includes(name.toLowerCase())) return false;
    }
  }

  return true;
}

/** Escapes a literal string for safe interpolation into a `pathPattern` or `bodyMatches`
 *  regex source. Per-run repo/org/channel names come from `generate()`'s pools, which are
 *  plain identifiers today, but this is cheap insurance against a future pool entry
 *  containing a regex metacharacter. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
