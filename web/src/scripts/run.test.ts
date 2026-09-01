import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `run.ts`'s orchestration logic (timeout, worker lifecycle, message/error handling) can be
 * tested without a real Worker or Blob URL by mocking `worker.ts`'s `createSandboxedWorker`
 * with a plain object driven by hand. The runtime string itself (the `pm` shim, the network
 * sandbox, CryptoJS) is covered separately in `worker.test.ts`, against a Function-based
 * harness that runs the exact production string.
 */

interface FakeWorker {
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function makeFakeWorker(): FakeWorker {
  return { onmessage: null, onerror: null, postMessage: vi.fn(), terminate: vi.fn() };
}

let fakeWorker: FakeWorker;

vi.mock('./worker.js', () => ({
  createSandboxedWorker: vi.fn(() => ({ worker: fakeWorker, url: 'blob:fake-url' })),
}));

const { runScript } = await import('./run.js');
const { createSandboxedWorker } = await import('./worker.js');

const baseContext = { environment: {}, request: { method: 'GET', url: 'http://127.0.0.1:4600/github/user', headers: {} } };

beforeEach(() => {
  fakeWorker = makeFakeWorker();
  vi.clearAllMocks();
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runScript', () => {
  it('resolves immediately without spawning a worker for an empty or whitespace-only script', async () => {
    const result = await runScript('', baseContext);
    expect(result).toEqual({ testResults: [], envPatch: {}, consoleLines: [], error: null });
    expect(createSandboxedWorker).not.toHaveBeenCalled();

    const result2 = await runScript('   \n  ', baseContext);
    expect(result2.error).toBeNull();
    expect(createSandboxedWorker).not.toHaveBeenCalled();
  });

  it('posts {script, context} to a fresh worker and resolves with its message', async () => {
    const promise = runScript('pm.test("x", function(){})', baseContext);
    expect(createSandboxedWorker).toHaveBeenCalledTimes(1);
    expect(fakeWorker.postMessage).toHaveBeenCalledWith({ script: 'pm.test("x", function(){})', context: baseContext });

    const workerResult = { testResults: [{ name: 'x', passed: true }], envPatch: {}, consoleLines: [], error: null };
    fakeWorker.onmessage?.({ data: workerResult } as MessageEvent);

    const result = await promise;
    expect(result).toEqual(workerResult);
    expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });

  it('resolves with an error when the worker itself errors (e.g. a Blob source parse failure)', async () => {
    const promise = runScript('script text', baseContext);
    fakeWorker.onerror?.({ message: 'boom', preventDefault: () => undefined } as unknown as ErrorEvent);
    const result = await promise;
    expect(result.error).toBe('boom');
    expect(result.testResults).toEqual([]);
    expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker and resolves with a timeout error at the 2000ms hard timeout', async () => {
    vi.useFakeTimers();
    const promise = runScript('while(true){}', baseContext);
    vi.advanceTimersByTime(2000);
    const result = await promise;
    expect(result.error).toMatch(/timed out/i);
    expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('a message arriving after the timeout is ignored (already settled)', async () => {
    vi.useFakeTimers();
    const promise = runScript('while(true){}', baseContext);
    vi.advanceTimersByTime(2000);
    const timeoutResult = await promise;
    // A late message must not double-resolve or throw; onmessage was nulled out by finish().
    expect(fakeWorker.onmessage).toBeNull();
    expect(timeoutResult.error).toMatch(/timed out/i);
  });

  /**
   * Fix round (coordinator review, finding 2): `postMessage` is a legitimate channel a
   * learner's own script can call directly (it is how the worker reports its real result),
   * so a script doing `self.postMessage({})` mid-run used to resolve `runScript` with
   * `ev.data` cast straight to `ScriptRunResult` with no validation. `state/store.ts`'s
   * `sendRequest` then did `consoleLines.push(...result.consoleLines)` on `undefined`,
   * threw `TypeError: consoleLines is not iterable`, and the throw escaped before
   * `set({ sending: false })` ever ran: Send stayed disabled until a page reload, directly
   * contradicting spec section 14's "never a hung UI". These tests drive the exact
   * malformed shapes a careless or adversarial script could send and confirm `runScript`
   * resolves (never throws, never hangs) with a failed-run result instead.
   */
  describe('malformed worker messages (finding 2)', () => {
    it('an empty object resolves as a failed run, not a thrown exception', async () => {
      const promise = runScript('self.postMessage({});', baseContext);
      fakeWorker.onmessage?.({ data: {} } as MessageEvent);
      const result = await promise;
      expect(result.error).toMatch(/unexpected result shape/i);
      expect(result.testResults).toEqual([]);
      expect(result.consoleLines).toEqual([]);
      expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);
    });

    it('null resolves as a failed run', async () => {
      const promise = runScript('self.postMessage(null);', baseContext);
      fakeWorker.onmessage?.({ data: null } as MessageEvent);
      const result = await promise;
      expect(result.error).toMatch(/unexpected result shape/i);
    });

    it('a testResults entry missing "passed" resolves as a failed run', async () => {
      const promise = runScript('x', baseContext);
      fakeWorker.onmessage?.({ data: { testResults: [{ name: 'x' }], envPatch: {}, consoleLines: [], error: null } } as MessageEvent);
      const result = await promise;
      expect(result.error).toMatch(/unexpected result shape/i);
    });

    it('an envPatch value that is neither a string nor null resolves as a failed run', async () => {
      const promise = runScript('x', baseContext);
      fakeWorker.onmessage?.({ data: { testResults: [], envPatch: { sig: 42 }, consoleLines: [], error: null } } as unknown as MessageEvent);
      const result = await promise;
      expect(result.error).toMatch(/unexpected result shape/i);
    });

    it('a well-formed result still resolves normally (the validator does not reject valid shapes)', async () => {
      const promise = runScript('x', baseContext);
      const good = { testResults: [{ name: 'ok', passed: true }], envPatch: { a: 'b', c: null }, consoleLines: ['hi'], error: null };
      fakeWorker.onmessage?.({ data: good } as MessageEvent);
      const result = await promise;
      expect(result).toEqual(good);
    });
  });
});
