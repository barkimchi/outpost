import { createSandboxedWorker } from './worker.js';

/**
 * Main-thread driver for the script engine (docs/SPEC.md section 14, this task's brief).
 * `runScript` is the one entry point `state/store.ts`'s `sendRequest` calls, once for a
 * Pre-request script and once for a Tests script, each against a fresh worker
 * (`worker.ts`'s `createSandboxedWorker`), so nothing from one execution can leak into the
 * next.
 */

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

/** `null` unsets the key; anything else is the new resolved string value. Applied onto the
 *  active environment by `state/store.ts`'s `sendRequest` (spec: "Its envPatch is applied
 *  to the environment, and the request is then resolved against the updated environment,
 *  so a script that computes a signature or refreshes a token genuinely changes what goes
 *  over the wire"). */
export type EnvPatch = Record<string, string | null>;

export interface ScriptRequestContext {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ScriptResponseContext {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timeMs: number;
}

export interface ScriptContext {
  environment: Record<string, string>;
  request: ScriptRequestContext;
  /** Present for the Tests script only; absent for Pre-request (spec: "Tests runs after
   *  the response arrives, with pm.response populated"). Its presence, not a separate
   *  phase flag, is what the worker checks to decide whether `pm.response` exists. */
  response?: ScriptResponseContext;
}

export interface ScriptRunResult {
  testResults: TestResult[];
  envPatch: EnvPatch;
  consoleLines: string[];
  /** Set when the script itself threw outside any `pm.test` callback (a syntax error, an
   *  uncaught exception, or the hard timeout below). `testResults` and `consoleLines` may
   *  still hold whatever ran before the failure. */
  error: string | null;
}

/** docs/SPEC.md section 14: "Hard timeout of 2000ms enforced by worker.terminate()". */
const HARD_TIMEOUT_MS = 2000;

function emptyResult(error: string | null = null): ScriptRunResult {
  return { testResults: [], envPatch: {}, consoleLines: [], error };
}

/**
 * Fix round (coordinator review, finding 2): `worker.onmessage` used to trust
 * `ev.data as ScriptRunResult` unconditionally. `postMessage` is a legitimate, never-
 * blocked channel a learner's own script can call directly (it is how the worker itself
 * reports back), so a script doing `self.postMessage({})` mid-run resolves `runScript`
 * with whatever shape it sent. Before this fix, that flowed straight into
 * `state/store.ts`'s `sendRequest`, which does `consoleLines.push(...result.consoleLines)`
 * and `testResults.push(...result.testResults)` unconditionally; `{}` has neither, so
 * `.push(...undefined)` threw `consoleLines is not iterable`, the throw escaped the
 * `async sendRequest` before its `finally`-equivalent `set({ sending: false, ... })` ever
 * ran, and Send stayed disabled until a page reload. Spec section 14 promises "never a
 * hung UI"; validating the shape at this boundary and treating anything that fails it as
 * a normal failed run (not a thrown exception) is what actually delivers that promise
 * against a message this code does not fully control the shape of.
 */
function isTestResult(value: unknown): value is TestResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || typeof v.passed !== 'boolean') return false;
  if ('error' in v && v.error !== undefined && typeof v.error !== 'string') return false;
  return true;
}

function isEnvPatch(value: unknown): value is EnvPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => v === null || typeof v === 'string');
}

function isScriptRunResult(value: unknown): value is ScriptRunResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.testResults) &&
    v.testResults.every(isTestResult) &&
    isEnvPatch(v.envPatch) &&
    Array.isArray(v.consoleLines) &&
    v.consoleLines.every((l) => typeof l === 'string') &&
    (v.error === null || typeof v.error === 'string')
  );
}

/**
 * Runs one script (Pre-request or Tests) in a fresh, network-isolated Web Worker and
 * resolves with its result. Never rejects (spec: "A timed-out or throwing script surfaces
 * as a failed run with the error text, never a hung UI"): a timeout, a worker-level parse
 * error, and a caught in-script exception all resolve normally with `error` set, so a
 * caller never needs a try/catch around this call.
 *
 * An empty/whitespace-only script resolves immediately without spawning a worker at all:
 * most requests have neither script filled in, and paying for a Blob URL and a Worker
 * spin-up on every single send when there is nothing to run would be wasted work on the
 * hot path.
 */
export function runScript(script: string, context: ScriptContext): Promise<ScriptRunResult> {
  if (script.trim() === '') return Promise.resolve(emptyResult());

  return new Promise((resolve) => {
    const { worker, url } = createSandboxedWorker();
    let settled = false;

    function finish(result: ScriptRunResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(result);
    }

    const timer = setTimeout(() => {
      finish(emptyResult(`Script timed out after ${HARD_TIMEOUT_MS}ms (an infinite loop is the usual cause).`));
    }, HARD_TIMEOUT_MS);

    worker.onmessage = (ev: MessageEvent) => {
      if (!isScriptRunResult(ev.data)) {
        finish(emptyResult('The script worker sent an unexpected result shape (a script may have called postMessage itself); treating this run as failed.'));
        return;
      }
      finish(ev.data);
    };
    worker.onerror = (ev: ErrorEvent) => {
      // Without this, an uncaught error in the Blob-sourced script also surfaces as a
      // browser-level "Uncaught ..." console error and (in some environments) can bubble
      // to window.onerror; this is a fully handled, expected outcome here, not a crash.
      ev.preventDefault();
      finish(emptyResult(ev.message || 'The script worker failed to run.'));
    };

    worker.postMessage({ script, context });
  });
}
