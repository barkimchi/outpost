import { isDeepStrictEqual } from 'node:util';
import type { Assertion, RequestEvent } from '@gym/shared';

/**
 * `Assertion` evaluation (docs/SPEC.md section 8, section 9). Every assertion returns a
 * human `reason` on failure: `engine.ts` uses the first failing assertion's reason as the
 * `scenario:attempt` event's `reason` field (docs/SPEC.md hard constraint 9, "Attempt
 * feedback always says why it didn't count").
 *
 * Includes the minimal dotted/bracket `jsonPath` (`a.b[0].c`) required by spec section 8,
 * implemented here with no external jsonpath dependency, per the task-3 brief.
 */
export interface AssertResult {
  pass: boolean;
  reason?: string;
}

export type CustomAssertion = (ev: RequestEvent) => AssertResult;

function tokenizePath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  let current = '';
  let i = 0;
  const flush = (): void => {
    if (current !== '') {
      tokens.push(current);
      current = '';
    }
  };
  while (i < path.length) {
    const ch = path[i] as string;
    if (ch === '.') {
      flush();
      i += 1;
      continue;
    }
    if (ch === '[') {
      flush();
      const end = path.indexOf(']', i);
      if (end === -1) throw new Error(`malformed jsonPath "${path}": unmatched [`);
      const inner = path.slice(i + 1, end);
      const idx = Number(inner);
      if (!Number.isInteger(idx)) {
        throw new Error(`malformed jsonPath "${path}": non-integer index "${inner}"`);
      }
      tokens.push(idx);
      i = end + 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();
  return tokens;
}

/** Resolves a dotted/bracket path (`a.b[0].c`) against a parsed JSON value. Empty string
 *  resolves to the root value itself, so `jsonArrayLength` can target a top-level array. */
export function resolveJsonPath(root: unknown, path: string): { found: boolean; value: unknown } {
  if (path === '') return { found: true, value: root };
  const tokens = tokenizePath(path);
  let cur: unknown = root;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (typeof tok === 'number') {
      if (!Array.isArray(cur) || tok < 0 || tok >= cur.length) return { found: false, value: undefined };
      cur = cur[tok];
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) return { found: false, value: undefined };
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return { found: false, value: undefined };
      cur = (cur as Record<string, unknown>)[tok];
    }
  }
  return { found: true, value: cur };
}

function parseJson(text: string | null): { ok: boolean; value?: unknown } {
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function describeLengthConstraint(a: { min?: number; max?: number; equals?: number }): string {
  if (a.equals !== undefined) return `exactly ${a.equals}`;
  const parts: string[] = [];
  if (a.min !== undefined) parts.push(`at least ${a.min}`);
  if (a.max !== undefined) parts.push(`at most ${a.max}`);
  return parts.length > 0 ? parts.join(' and ') : 'any number of';
}

function asDisplayText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function evaluateAssertion(
  a: Assertion,
  ev: RequestEvent,
  custom: Record<string, CustomAssertion> = {},
): AssertResult {
  switch (a.kind) {
    case 'status':
      return a.equals === ev.status
        ? { pass: true }
        : { pass: false, reason: `expected status ${a.equals}, got ${ev.status}` };

    case 'statusIn':
      return a.oneOf.includes(ev.status)
        ? { pass: true }
        : { pass: false, reason: `expected status in [${a.oneOf.join(', ')}], got ${ev.status}` };

    case 'jsonPath': {
      const parsed = parseJson(ev.resBody);
      if (!parsed.ok) {
        return { pass: false, reason: `response body is not valid JSON, cannot check '${a.path}'` };
      }
      const { found, value } = resolveJsonPath(parsed.value, a.path);
      if (a.exists !== undefined) {
        if (found === a.exists) return { pass: true };
        return {
          pass: false,
          reason: a.exists
            ? `expected '${a.path}' to exist in the response body`
            : `expected '${a.path}' to be absent from the response body`,
        };
      }
      if (!found) return { pass: false, reason: `response body has no '${a.path}'` };
      if (a.equals !== undefined) {
        return isDeepStrictEqual(value, a.equals)
          ? { pass: true }
          : {
              pass: false,
              reason: `expected '${a.path}' to equal ${JSON.stringify(a.equals)}, got ${JSON.stringify(value)}`,
            };
      }
      if (a.matches !== undefined) {
        const text = asDisplayText(value);
        return new RegExp(a.matches).test(text)
          ? { pass: true }
          : { pass: false, reason: `expected '${a.path}' to match ${a.matches}, got ${text}` };
      }
      return { pass: true };
    }

    case 'jsonArrayLength': {
      const parsed = parseJson(ev.resBody);
      if (!parsed.ok) {
        return { pass: false, reason: `response body is not valid JSON, cannot check length at '${a.path}'` };
      }
      const { found, value } = resolveJsonPath(parsed.value, a.path);
      if (!found || !Array.isArray(value)) {
        return {
          pass: false,
          reason: `expected an array at '${a.path}', found ${found ? typeof value : 'nothing'}`,
        };
      }
      const len = value.length;
      const ok =
        (a.equals === undefined || len === a.equals) &&
        (a.min === undefined || len >= a.min) &&
        (a.max === undefined || len <= a.max);
      return ok
        ? { pass: true }
        : { pass: false, reason: `expected ${describeLengthConstraint(a)} item(s) at '${a.path}', got ${len}` };
    }

    case 'headerEquals': {
      const actual = findHeader(ev.resHeaders, a.name);
      return actual === a.equals
        ? { pass: true }
        : {
            pass: false,
            reason: `expected response header '${a.name}' to equal '${a.equals}', got ${
              actual === undefined ? '(missing)' : `'${actual}'`
            }`,
          };
    }

    case 'headerMatches': {
      const actual = findHeader(ev.resHeaders, a.name);
      return actual !== undefined && new RegExp(a.matches).test(actual)
        ? { pass: true }
        : {
            pass: false,
            reason: `expected response header '${a.name}' to match ${a.matches}, got ${
              actual === undefined ? '(missing)' : `'${actual}'`
            }`,
          };
    }

    case 'bodyMatches': {
      const text = ev.resBody ?? '';
      return new RegExp(a.matches).test(text)
        ? { pass: true }
        : { pass: false, reason: `expected response body to match ${a.matches}` };
    }

    case 'reqHeaderMatches': {
      const actual = findHeader(ev.reqHeaders, a.name);
      return actual !== undefined && new RegExp(a.matches).test(actual)
        ? { pass: true }
        : {
            pass: false,
            reason: `expected request header '${a.name}' to match ${a.matches}, got ${
              actual === undefined ? '(missing)' : `'${actual}'`
            }`,
          };
    }

    case 'reqJsonPath': {
      const parsed = parseJson(ev.reqBody);
      if (!parsed.ok) {
        return { pass: false, reason: `request body is not valid JSON, cannot check '${a.path}'` };
      }
      const { found, value } = resolveJsonPath(parsed.value, a.path);
      if (a.exists !== undefined) {
        if (found === a.exists) return { pass: true };
        return {
          pass: false,
          reason: a.exists ? `expected request '${a.path}' to exist` : `expected request '${a.path}' to be absent`,
        };
      }
      if (!found) return { pass: false, reason: `request body has no '${a.path}'` };
      if (a.equals !== undefined) {
        return isDeepStrictEqual(value, a.equals)
          ? { pass: true }
          : {
              pass: false,
              reason: `expected request '${a.path}' to equal ${JSON.stringify(a.equals)}, got ${JSON.stringify(value)}`,
            };
      }
      if (a.matches !== undefined) {
        const text = asDisplayText(value);
        return new RegExp(a.matches).test(text)
          ? { pass: true }
          : { pass: false, reason: `expected request '${a.path}' to match ${a.matches}, got ${text}` };
      }
      return { pass: true };
    }

    case 'custom': {
      const fn = custom[a.id];
      if (!fn) return { pass: false, reason: `unknown custom assertion id '${a.id}'` };
      return fn(ev);
    }
  }
}

/** Evaluates a step's assertions in order and stops at the first failure (docs/SPEC.md
 *  section 9: the attempt reason is built from "the first failing assertion"). */
export function evaluateAssertions(
  assertions: Assertion[],
  ev: RequestEvent,
  custom: Record<string, CustomAssertion> = {},
): AssertResult {
  for (const a of assertions) {
    const result = evaluateAssertion(a, ev, custom);
    if (!result.pass) return result;
  }
  return { pass: true };
}

/**
 * Registry for `Assertion{kind:'custom'}` (docs/SPEC.md section 8: "resolved by id in
 * engine/assert.ts against a small registry"). Empty through scenarios 1-7, which are all
 * expressible with the declarative kinds.
 *
 * `t3-redirect-progress` (Task 6 fix round, finding 1): `t3-redirect-mismatch`'s step 1
 * matches BOTH `GET` and `POST /google/o/oauth2/v2/auth`, because the wrong-URI failure
 * mode is a GET returning 400 (the consent page never renders at all, so there is no form
 * to POST), and a matcher that only accepted POST left that entire failure path invisible
 * to the engine: three wrong GETs produced zero attempts and never unlocked a hint, a
 * violation of hard constraint 9 in the flagship tier-3 scenario's primary failure mode.
 * Widening the matcher's `method` alone is not enough, though: GET and POST have two
 * DIFFERENT success shapes (a correct GET renders the consent page, 200, no `Location`
 * header at all; a correct POST-approve redirects, 302, WITH one), so a single declarative
 * `status`/`headerMatches` pair cannot express "pass" for both without also either
 * false-failing a correct GET (no Location header to match) or false-passing a POST that
 * merely DENIED consent (also a 302, just without a code). This custom assertion expresses
 * that logic directly: fail on any 400 (the mismatch, whichever method produced it, with a
 * reason naming the method); for a POST, additionally require the redirect to actually
 * carry `code=` (so a deliberate `approve=0` denial cannot pass); anything else (a plain,
 * correct GET) passes.
 */
export const customAssertions: Record<string, CustomAssertion> = {
  't3-redirect-progress': (ev) => {
    if (ev.status === 400) {
      return {
        pass: false,
        reason: `${ev.method} to the authorize endpoint returned 400: the callback URL does not exactly match one of the registered ones`,
      };
    }
    if (ev.method === 'POST') {
      const location = ev.resHeaders['location'] ?? '';
      if (!/[?&]code=/.test(location)) {
        return {
          pass: false,
          reason: 'the consent POST did not come back with a code-bearing redirect (check that approve=1 was actually sent)',
        };
      }
    }
    return { pass: true };
  },
};
