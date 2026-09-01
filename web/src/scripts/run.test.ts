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
});
