import vm from 'node:vm';
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildWorkerSource } from './worker.js';

/**
 * Exercises the exact runtime string `worker.ts` hands to `new Blob(...)` in the browser,
 * without a real Worker: jsdom (this workspace's Vitest environment, see
 * `vitest.config.ts`'s header comment) has no Worker implementation at all.
 *
 * A real dedicated Worker has exactly ONE global object, and `self` IS that object: a
 * `new Function(...)` call made from ANYWHERE inside the worker (including the source's
 * own handling of a learner's script) resolves unqualified identifiers like `fetch` against
 * that same single global, which is why overwriting `self.fetch` genuinely blocks a bare
 * `fetch(...)` call in the script it later runs. An early version of this harness used
 * `new Function('self', source)` with `self` as an ordinary parameter holding a plain
 * object: that object is NOT the real global scope, so the worker source's own INNER
 * `new Function('pm','console','CryptoJS', script)` call (which always closes over the
 * true global scope, never its caller's lexical scope) resolved `fetch` against the real
 * Node/jsdom global instead of the harness's fake one, and the sandbox looked broken when
 * it was not. `node:vm`'s `createContext` gives a genuinely separate realm with its own
 * global object and its own `Function` constructor bound to it, so this harness runs the
 * worker source AS that realm's global script (after seeding `self = this`, matching a
 * classic script's top-level `this` inside a real Worker), which reproduces the
 * single-global-object property a real Worker has. This still runs the PRODUCTION string
 * unmodified, not a parallel reimplementation of it.
 */

interface FakeSelf {
  console: Record<string, unknown>;
  navigator?: { sendBeacon?: unknown };
  fetch?: unknown;
  XMLHttpRequest?: unknown;
  WebSocket?: unknown;
  EventSource?: unknown;
  importScripts?: unknown;
  Worker?: unknown;
  CryptoJS?: {
    HmacSHA256: (message: string, key: string) => { toString: () => string };
    SHA256: (message: string) => { toString: (enc?: unknown) => string };
    enc: { Hex: unknown };
  };
  postMessage?: (msg: unknown) => void;
  onmessage?: (ev: { data: unknown }) => void;
}

interface WorkerResult {
  testResults: Array<{ name: string; passed: boolean; error?: string }>;
  envPatch: Record<string, string | null>;
  consoleLines: string[];
  error: string | null;
}

function createHarness(): { self: FakeSelf; run: (script: string, context: unknown) => WorkerResult } {
  const source = buildWorkerSource();
  const sandbox: FakeSelf = { console: {} };
  const context = vm.createContext(sandbox as unknown as Record<string, unknown>);
  // Top-level `this` in a non-strict classic script equals the global object; seeding a
  // `self` global that way (rather than passing it as a parameter) matches how the
  // identifier resolves inside a real Worker, where `self` is not a parameter either.
  vm.runInContext('var self = this;', context);
  vm.runInContext(source, context);

  return {
    self: sandbox,
    run(script: string, context2: unknown): WorkerResult {
      let captured: WorkerResult | undefined;
      sandbox.postMessage = (msg) => {
        captured = msg as WorkerResult;
      };
      if (!sandbox.onmessage) throw new Error('worker source never installed self.onmessage');
      sandbox.onmessage({ data: { script, context: context2 } });
      if (!captured) throw new Error('worker source never called self.postMessage');
      return captured;
    },
  };
}

const baseContext = { environment: {}, request: { method: 'GET', url: 'http://127.0.0.1:4600/github/user', headers: {} } };

describe('worker runtime source: CryptoJS', () => {
  it('is exposed as a global backed by the real crypto-js package', () => {
    const { self } = createHarness();
    expect(self.CryptoJS).toBeDefined();
  });

  it('HmacSHA256(...).toString() matches a known-good HMAC-SHA256 implementation', () => {
    const { self } = createHarness();
    const sig = self.CryptoJS!.HmacSHA256('v0:1:{}', 'secret').toString();
    const expected = createHmac('sha256', 'secret').update('v0:1:{}').digest('hex');
    expect(sig).toBe(expected);
  });

  it('SHA256(...).toString(enc.Hex) matches a known-good SHA-256 implementation', () => {
    const { self } = createHarness();
    const hash = self.CryptoJS!.SHA256('hello').toString(self.CryptoJS!.enc.Hex);
    const expected = createHash('sha256').update('hello').digest('hex');
    expect(hash).toBe(expected);
  });
});

describe('worker runtime source: pm.test / pm.expect', () => {
  it('registers a passing row when the callback does not throw', () => {
    const { run } = createHarness();
    const result = run('pm.test("ok", function () { pm.expect(1).to.equal(1); });', baseContext);
    expect(result.testResults).toEqual([{ name: 'ok', passed: true }]);
    expect(result.error).toBeNull();
  });

  it('registers a failing row with the assertion message when the callback throws', () => {
    const { run } = createHarness();
    const result = run('pm.test("bad", function () { pm.expect(1).to.equal(2); });', baseContext);
    expect(result.testResults).toHaveLength(1);
    expect(result.testResults[0]?.passed).toBe(false);
    expect(result.testResults[0]?.error).toMatch(/expected 1 to equal 2/);
  });

  it('a failing test does not stop later pm.test calls from running', () => {
    const { run } = createHarness();
    const result = run(
      'pm.test("a", function () { throw new Error("boom"); }); pm.test("b", function () { pm.expect(true).to.be.ok; });',
      baseContext,
    );
    expect(result.testResults).toEqual([
      { name: 'a', passed: false, error: 'boom' },
      { name: 'b', passed: true },
    ]);
  });

  it('to.eql does a deep comparison, to.equal is strict', () => {
    const { run } = createHarness();
    const result = run(
      'pm.test("eql", function () { pm.expect({a:1}).to.eql({a:1}); }); ' +
        'pm.test("not-equal", function () { pm.expect({a:1}).to.equal({a:1}); });',
      baseContext,
    );
    expect(result.testResults[0]).toEqual({ name: 'eql', passed: true });
    expect(result.testResults[1]?.passed).toBe(false);
  });

  it('to.have.property checks existence and, when given a second argument, the value', () => {
    const { run } = createHarness();
    const result = run(
      'pm.test("has", function () { pm.expect({ok:true}).to.have.property("ok"); }); ' +
        'pm.test("wrong-value", function () { pm.expect({ok:true}).to.have.property("ok", false); });',
      baseContext,
    );
    expect(result.testResults[0]).toEqual({ name: 'has', passed: true });
    expect(result.testResults[1]?.passed).toBe(false);
  });
});

describe('worker runtime source: pm.response', () => {
  const withResponse = {
    environment: {},
    request: { method: 'GET', url: 'http://127.0.0.1:4600/github/user', headers: {} },
    response: { status: 200, statusText: 'OK', headers: { 'X-Test': 'abc' }, body: '{"login":"octocat"}', timeMs: 12.5 },
  };

  it('pm.response.to.have.status passes for a matching status', () => {
    const { run } = createHarness();
    const result = run('pm.test("status", function () { pm.response.to.have.status(200); });', withResponse);
    expect(result.testResults).toEqual([{ name: 'status', passed: true }]);
  });

  it('pm.response.to.have.status fails with the actual status in the message', () => {
    const { run } = createHarness();
    const result = run('pm.test("status", function () { pm.response.to.have.status(404); });', withResponse);
    expect(result.testResults[0]?.passed).toBe(false);
    expect(result.testResults[0]?.error).toMatch(/expected response to have status 404 but got 200/);
  });

  it('pm.response.json(), .headers.get() (case-insensitive), and .responseTime all work', () => {
    const { run } = createHarness();
    const result = run(
      'pm.test("body", function () { ' +
        'pm.expect(pm.response.json().login).to.equal("octocat"); ' +
        'pm.expect(pm.response.headers.get("x-test")).to.equal("abc"); ' +
        'pm.expect(pm.response.responseTime).to.equal(12.5); ' +
        '});',
      withResponse,
    );
    expect(result.testResults).toEqual([{ name: 'body', passed: true }]);
  });

  it('pm.response is null in a pre-request context (no response key)', () => {
    const { run } = createHarness();
    const result = run('pm.test("no-response", function () { pm.response.to.have.status(200); });', baseContext);
    expect(result.testResults[0]?.passed).toBe(false);
  });
});

describe('worker runtime source: pm.environment / pm.variables / pm.collectionVariables', () => {
  it('pm.environment.set records an envPatch entry and pm.environment.get reads it back', () => {
    const { run } = createHarness();
    const result = run('pm.environment.set("sig", "abc123"); pm.test("get", function () { pm.expect(pm.environment.get("sig")).to.equal("abc123"); });', baseContext);
    expect(result.envPatch).toEqual({ sig: 'abc123' });
    expect(result.testResults).toEqual([{ name: 'get', passed: true }]);
  });

  it('pm.environment.unset records a null envPatch entry', () => {
    const { run } = createHarness();
    const result = run('pm.environment.unset("token");', { ...baseContext, environment: { token: 'x' } });
    expect(result.envPatch).toEqual({ token: null });
  });

  it('coerces set values to strings, matching real Postman', () => {
    const { run } = createHarness();
    const result = run('pm.environment.set("n", 42);', baseContext);
    expect(result.envPatch).toEqual({ n: '42' });
  });

  it('pm.variables aliases the same store as pm.environment', () => {
    const { run } = createHarness();
    const result = run('pm.variables.set("v", "via-variables"); pm.test("t", function () { pm.expect(pm.environment.get("v")).to.equal("via-variables"); });', baseContext);
    expect(result.envPatch).toEqual({ v: 'via-variables' });
    expect(result.testResults).toEqual([{ name: 't', passed: true }]);
  });

  it('pm.collectionVariables is independent and never appears in envPatch', () => {
    const { run } = createHarness();
    const result = run(
      'pm.collectionVariables.set("cv", "1"); pm.test("t", function () { pm.expect(pm.collectionVariables.get("cv")).to.equal("1"); });',
      baseContext,
    );
    expect(result.envPatch).toEqual({});
    expect(result.testResults).toEqual([{ name: 't', passed: true }]);
  });
});

describe('worker runtime source: console capture', () => {
  it('console.log is captured into consoleLines, joined and stringified', () => {
    const { run } = createHarness();
    const result = run('console.log("hello", 42, {a:1});', baseContext);
    expect(result.consoleLines).toEqual(['hello 42 {"a":1}']);
  });

  it('console.warn/error/info are tagged', () => {
    const { run } = createHarness();
    const result = run('console.warn("careful"); console.error("bad"); console.info("fyi");', baseContext);
    expect(result.consoleLines).toEqual(['[warn] careful', '[error] bad', '[info] fyi']);
  });
});

describe('worker runtime source: network sandbox', () => {
  it('fetch(...) throws a clear error instead of reaching the network', () => {
    const { run } = createHarness();
    const result = run('fetch("http://example.com");', baseContext);
    expect(result.error).toMatch(/"fetch" is not available/);
  });

  it('a network attempt inside a pm.test callback fails that test, not the whole run', () => {
    const { run } = createHarness();
    const result = run('pm.test("no-network", function () { fetch("http://example.com"); });', baseContext);
    expect(result.testResults[0]?.passed).toBe(false);
    expect(result.testResults[0]?.error).toMatch(/"fetch" is not available/);
    expect(result.error).toBeNull();
  });

  it('XMLHttpRequest is also blocked', () => {
    const { run } = createHarness();
    const result = run('new XMLHttpRequest();', baseContext);
    expect(result.error).toMatch(/"XMLHttpRequest" is not available/);
  });
});

describe('worker runtime source: top-level failures', () => {
  it('a syntax error surfaces as a top-level error, not a crash, with no test results', () => {
    const { run } = createHarness();
    const result = run('this is not valid js (((', baseContext);
    expect(result.error).toBeTruthy();
    expect(result.testResults).toEqual([]);
  });

  it('an uncaught throw outside any pm.test surfaces as a top-level error', () => {
    const { run } = createHarness();
    const result = run('throw new Error("outside a test");', baseContext);
    expect(result.error).toBe('outside a test');
  });
});

describe('worker runtime source: pm.request', () => {
  it('exposes the method/url/headers/body passed in on context.request', () => {
    const { run } = createHarness();
    const context = {
      environment: {},
      request: { method: 'POST', url: 'http://127.0.0.1:4600/github/user/repos', headers: { Authorization: 'Bearer abc' }, body: '{"name":"x"}' },
    };
    const result = run(
      'pm.test("t", function () { ' +
        'pm.expect(pm.request.method).to.equal("POST"); ' +
        'pm.expect(pm.request.url).to.equal("http://127.0.0.1:4600/github/user/repos"); ' +
        'pm.expect(pm.request.headers.Authorization).to.equal("Bearer abc"); ' +
        'pm.expect(JSON.parse(pm.request.body).name).to.equal("x"); ' +
        '});',
      context,
    );
    expect(result.testResults).toEqual([{ name: 't', passed: true }]);
  });
});
