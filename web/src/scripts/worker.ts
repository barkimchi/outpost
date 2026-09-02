// Vite's `?raw` suffix imports the file as a plain string, typed by `vite/client.d.ts`
// (pulled in via `web/tsconfig.json`'s `"types": ["vite/client"]`). `crypto-js.js` (not
// the package's CommonJS `index.js`) is the single-file UMD bundle described below.
import cryptoJsSource from 'crypto-js/crypto-js.js?raw';

/**
 * The Web Worker script engine (docs/SPEC.md section 14, this task's brief). This worker
 * is created from a Blob URL rather than a bundled module worker file, so its ENTIRE
 * source is exactly this one string: the vendored CryptoJS UMD bundle, a hand-written
 * network sandbox, the `pm` API shim, and the message handler that actually runs a
 * learner's script. Nothing here can `import` anything at runtime; everything the script
 * needs is baked into this string at build time via Vite's `?raw` import of the real
 * `crypto-js` package (spec: "CryptoJS ... backed by the real crypto-js package"), so
 * `CryptoJS.HmacSHA256(...).toString()` and `CryptoJS.SHA256(...)` genuinely run the
 * library, not a hand-rolled stand-in.
 *
 * `cryptoJsSource` is `crypto-js`'s own `crypto-js.js`: a single-file UMD bundle that, when
 * neither CommonJS `exports` nor AMD `define` exist in scope (true inside a classic,
 * Blob-sourced worker script), assigns `root.CryptoJS = factory()` where `root` is the
 * outer `this`. A classic (non-module) top-level script's `this` is the global scope
 * itself, i.e. `self` inside a worker, so this "just works" with zero glue code.
 *
 * Deliberately written as plain, string-embedded ES5-ish JavaScript (`var`, no arrow
 * functions, no template literals, no `let`/`const`) rather than authored TypeScript: this
 * text is never compiled, only concatenated and handed to `new Blob(...)`. `worker.test.ts`
 * executes this exact string (via a small `new Function('self', ..., source)` harness, not
 * a real Worker: jsdom has no Worker implementation, see `vitest.config.ts`'s header
 * comment) so the production string is what gets tested, not a parallel reimplementation
 * that could quietly drift from it.
 */

/** No DOM, no `window`: true for free inside any Worker. "No fetch, no network reachable"
 *  is NOT free: a dedicated Worker has a real, live `fetch`, `XMLHttpRequest`, `WebSocket`,
 *  `EventSource`, `importScripts` (which can itself load a remote script), `caches`,
 *  `indexedDB`, `WebTransport`, `BroadcastChannel`, `RTCPeerConnection`, and
 *  `navigator.sendBeacon`.
 *
 *  Fix round (coordinator review): an earlier version of this file shadowed these with an
 *  OWN property on `self` (`self.fetch = blocked()`). That is not enough. `fetch`,
 *  `importScripts`, `caches`, and `indexedDB` are exposed via a shared prototype in the
 *  chain (the `WindowOrWorkerGlobalScope` mixin, a real JS prototype object in Chromium,
 *  not merely a spec fiction), so `Object.getPrototypeOf(self).fetch` still resolves to the
 *  ORIGINAL implementation; calling it as `Object.getPrototypeOf(self).fetch.call(self,
 *  url)` re-binds `this` to `self` and walks straight past an own-property shadow to
 *  perform a real fetch. Proven against the real production string at the app's own
 *  origin: that exact call, `caches.open(x).then(c => c.add(url))` (not touched by the
 *  own-property fix at all), and `Object.getPrototypeOf(self).importScripts.call(self,
 *  url)` all reached the network. `indexedDB` being unblocked additionally broke the
 *  DIFFERENT, non-security guarantee spec section 14 makes ("a fresh worker per execution,
 *  so no state leaks between runs"): IndexedDB is a persistent, origin-scoped store, so a
 *  value written by run 1's script was readable from run 2's genuinely fresh Worker, even
 *  though every JS variable in that fresh worker started from zero.
 *
 *  The fix walks the ENTIRE prototype chain and replaces the named property at every
 *  level that has it as an OWN property (deleting first, then redefining, so a later
 *  lookup can never fall through to a level this loop skipped), not just on `self` itself.
 *  This runs synchronously, at the very top of this worker's source, before `self.onmessage`
 *  is even defined below, so no script this worker ever runs, not even the first one,
 *  observes the unblocked original.
 *
 *  This is still not a hardened sandbox against a truly hostile script: CPU-bound and
 *  memory-bound denial of service (an infinite loop, or an unbounded allocation loop) are
 *  handled differently, if at all (`run.ts`'s 2000ms `terminate()` stops the former; there
 *  is no reliable browser-level defense against the latter before a real OOM crash, and
 *  `content/docs/scripting.md` says so plainly rather than implying a guarantee that does
 *  not exist). This fix closes the specific, proven network/storage escape; it is not a
 *  claim that no other escape could ever exist. */
const NETWORK_SANDBOX_SOURCE = `
function __pmBlockedMessage(name) {
  return '"' + name + '" is not available in a Outpost script: scripts run in a network-isolated worker (see the Scripting doc).';
}
function __pmBlockedFn(name) {
  return function () { throw new Error(__pmBlockedMessage(name)); };
}
function __pmBlockedObj(name) {
  var msg = __pmBlockedMessage(name);
  if (typeof Proxy === 'undefined') return __pmBlockedFn(name);
  return new Proxy({}, {
    get: function () { throw new Error(msg); },
    apply: function () { throw new Error(msg); },
    construct: function () { throw new Error(msg); }
  });
}

/* Replaces the own property "name" with "replacement" at EVERY level of obj's prototype
   chain that currently defines it, then guarantees obj itself ends up with it as an own
   property too, even if nothing in the chain matched. See the file-level comment above for
   why a single "self.NAME = blocked" assignment is not sufficient. */
function __pmNuke(obj, name, replacement) {
  var cur = obj;
  while (cur) {
    if (Object.prototype.hasOwnProperty.call(cur, name)) {
      try { delete cur[name]; } catch (e) {}
      try {
        Object.defineProperty(cur, name, { value: replacement, writable: true, configurable: true, enumerable: false });
      } catch (e) {
        try { cur[name] = replacement; } catch (e2) {}
      }
    }
    cur = Object.getPrototypeOf(cur);
  }
  try {
    Object.defineProperty(obj, name, { value: replacement, writable: true, configurable: true, enumerable: false });
  } catch (e) {
    try { obj[name] = replacement; } catch (e2) {}
  }
}

var __pmFnBlocklist = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker',
  'WebTransport', 'BroadcastChannel', 'RTCPeerConnection'
];
for (var __pmI = 0; __pmI < __pmFnBlocklist.length; __pmI++) {
  try { __pmNuke(self, __pmFnBlocklist[__pmI], __pmBlockedFn(__pmFnBlocklist[__pmI])); } catch (e) {}
}
var __pmObjBlocklist = ['caches', 'indexedDB'];
for (var __pmJ = 0; __pmJ < __pmObjBlocklist.length; __pmJ++) {
  try { __pmNuke(self, __pmObjBlocklist[__pmJ], __pmBlockedObj(__pmObjBlocklist[__pmJ])); } catch (e) {}
}
try {
  if (self.navigator) __pmNuke(self.navigator, 'sendBeacon', __pmBlockedFn('navigator.sendBeacon'));
} catch (e) {}
`;

/** The `pm` API shim (spec section 14's exact surface) plus the message handler that runs
 *  one script per `postMessage` and reports back `{testResults, envPatch, consoleLines,
 *  error}`. A fresh Worker per execution (`worker.ts`'s `createSandboxedWorker`, below) is
 *  what actually guarantees no state leaks between runs; this handler also resets its own
 *  module-level state at the top of every message, for defense in depth against a future
 *  change that reuses a worker.
 *
 *  `pm.variables` is deliberately backed by the SAME store as `pm.environment` (both
 *  `get`/`set` are the literal same functions): this app has no separate global/local
 *  variable scope the way real Postman does, and aliasing the two is simpler and more
 *  useful than a `pm.variables` that silently discards what a script writes to it. This is
 *  documented in `content/docs/scripting.md`. `pm.collectionVariables` is a genuinely
 *  separate, in-run-only store per spec (`get`/`set`, no `unset`, matching the exact
 *  listed surface): nothing in this app's data model persists a collection-scoped variable,
 *  so it does not feed `envPatch` and does not survive past this one script run. */
const PM_SHIM_SOURCE = `
var __pmTestResults = [];
var __pmConsoleLines = [];
var __pmEnvStore = {};
var __pmEnvPatch = {};
var __pmCollectionVars = {};

function __pmStringify(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function __pmCapture(tag, args) {
  var parts = [];
  for (var i = 0; i < args.length; i++) parts.push(__pmStringify(args[i]));
  var line = parts.join(' ');
  __pmConsoleLines.push(tag ? '[' + tag + '] ' + line : line);
}

self.console.log = function () { __pmCapture(null, arguments); };
self.console.info = function () { __pmCapture('info', arguments); };
self.console.warn = function () { __pmCapture('warn', arguments); };
self.console.error = function () { __pmCapture('error', arguments); };

function __pmAssertionError(message) {
  var err = new Error(message);
  err.name = 'AssertionError';
  return err;
}

function __pmDeepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  var aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (var i = 0; i < aKeys.length; i++) {
    var k = aKeys[i];
    if (!Object.prototype.hasOwnProperty.call(b, k) || !__pmDeepEqual(a[k], b[k])) return false;
  }
  return true;
}

function __pmExpect(value) {
  return {
    to: {
      eql: function (expected) {
        if (!__pmDeepEqual(value, expected)) throw __pmAssertionError('expected ' + __pmStringify(value) + ' to eql ' + __pmStringify(expected));
      },
      equal: function (expected) {
        if (value !== expected) throw __pmAssertionError('expected ' + __pmStringify(value) + ' to equal ' + __pmStringify(expected));
      },
      include: function (expected) {
        var ok;
        if (typeof value === 'string') ok = value.indexOf(expected) !== -1;
        else if (Array.isArray(value)) ok = value.indexOf(expected) !== -1;
        else throw __pmAssertionError('"include" only supports strings and arrays');
        if (!ok) throw __pmAssertionError('expected ' + __pmStringify(value) + ' to include ' + __pmStringify(expected));
      },
      be: {
        get ok() {
          if (!value) throw __pmAssertionError('expected ' + __pmStringify(value) + ' to be truthy');
          return true;
        }
      },
      have: {
        status: function (n) {
          if (!value || typeof value.code === 'undefined') throw __pmAssertionError('"to.have.status" expects a response object');
          if (value.code !== n) throw __pmAssertionError('expected response to have status ' + n + ' but got ' + value.code);
        },
        property: function (key, expected) {
          if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) {
            throw __pmAssertionError('expected object to have property "' + key + '"');
          }
          if (arguments.length > 1 && !__pmDeepEqual(value[key], expected)) {
            throw __pmAssertionError('expected property "' + key + '" to eql ' + __pmStringify(expected) + ' but got ' + __pmStringify(value[key]));
          }
        }
      }
    }
  };
}

function __pmTest(name, fn) {
  try {
    fn();
    __pmTestResults.push({ name: String(name), passed: true });
  } catch (err) {
    __pmTestResults.push({ name: String(name), passed: false, error: err && err.message ? String(err.message) : String(err) });
  }
}

function __pmEnvGet(k) { return Object.prototype.hasOwnProperty.call(__pmEnvStore, k) ? __pmEnvStore[k] : undefined; }
function __pmEnvSet(k, v) { var s = String(v); __pmEnvStore[k] = s; __pmEnvPatch[k] = s; }
function __pmEnvUnset(k) { delete __pmEnvStore[k]; __pmEnvPatch[k] = null; }
function __pmCollGet(k) { return Object.prototype.hasOwnProperty.call(__pmCollectionVars, k) ? __pmCollectionVars[k] : undefined; }
function __pmCollSet(k, v) { __pmCollectionVars[k] = String(v); }

self.onmessage = function (ev) {
  var data = ev.data || {};
  var script = typeof data.script === 'string' ? data.script : '';
  var context = data.context || {};

  __pmTestResults = [];
  __pmConsoleLines = [];
  __pmEnvStore = {};
  __pmEnvPatch = {};
  __pmCollectionVars = {};

  var srcEnv = context.environment || {};
  for (var k in srcEnv) { if (Object.prototype.hasOwnProperty.call(srcEnv, k)) __pmEnvStore[k] = srcEnv[k]; }

  var reqCtx = context.request || {};
  var pmRequest = {
    method: reqCtx.method || '',
    url: reqCtx.url || '',
    headers: reqCtx.headers || {},
    body: typeof reqCtx.body === 'string' ? reqCtx.body : null
  };

  var pmResponse = null;
  if (context.response) {
    var resCtx = context.response;
    var resHeaders = resCtx.headers || {};
    var resBody = typeof resCtx.body === 'string' ? resCtx.body : '';
    pmResponse = {
      code: resCtx.status,
      status: resCtx.statusText || '',
      responseTime: resCtx.timeMs,
      json: function () { return JSON.parse(resBody); },
      text: function () { return resBody; },
      headers: {
        get: function (name) {
          var lower = String(name).toLowerCase();
          for (var hk in resHeaders) {
            if (Object.prototype.hasOwnProperty.call(resHeaders, hk) && hk.toLowerCase() === lower) return resHeaders[hk];
          }
          return undefined;
        }
      },
      to: {
        have: {
          status: function (n) {
            if (resCtx.status !== n) throw __pmAssertionError('expected response to have status ' + n + ' but got ' + resCtx.status);
          }
        }
      }
    };
  }

  var pm = {
    test: __pmTest,
    expect: __pmExpect,
    response: pmResponse,
    request: pmRequest,
    environment: { get: __pmEnvGet, set: __pmEnvSet, unset: __pmEnvUnset },
    variables: { get: __pmEnvGet, set: __pmEnvSet },
    collectionVariables: { get: __pmCollGet, set: __pmCollSet }
  };

  var topError = null;
  try {
    var fn = new Function('pm', 'console', 'CryptoJS', script);
    fn(pm, self.console, self.CryptoJS);
  } catch (err) {
    topError = err && err.message ? String(err.message) : String(err);
  }

  self.postMessage({
    testResults: __pmTestResults,
    envPatch: __pmEnvPatch,
    consoleLines: __pmConsoleLines,
    error: topError
  });
};
`;

/** The full Blob source: vendored CryptoJS, then the network sandbox, then the `pm` shim
 *  and message handler. Exported (not inlined into `createSandboxedWorker`) so
 *  `worker.test.ts` can execute the exact production string through its `new Function`
 *  harness. */
export function buildWorkerSource(): string {
  return `${cryptoJsSource}\n${NETWORK_SANDBOX_SOURCE}\n${PM_SHIM_SOURCE}`;
}

/** One fresh Worker per execution (spec: "so no state leaks between runs"), built from a
 *  Blob URL rather than a file Vite serves as a separate chunk, so the entire runtime is
 *  exactly the string above and nothing else can reach in. The caller (`run.ts`) is
 *  responsible for revoking the returned object URL once the worker either finishes or is
 *  terminated. */
export function createSandboxedWorker(): { worker: Worker; url: string } {
  const blob = new Blob([buildWorkerSource()], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  return { worker, url };
}
