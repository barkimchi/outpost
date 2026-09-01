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
      finish(ev.data as ScriptRunResult);
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
