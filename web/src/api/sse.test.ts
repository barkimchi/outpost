import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrainerEvent } from '@gym/shared';
import { createSSEClient, type EventSourceLike, type EventSourceLikeConstructor } from './sse.js';

/**
 * A fake `EventSource` the test fully controls: construction is observable (so we can
 * assert exactly one connection attempt at a time and a fresh URL/instance per retry),
 * and `emitOpen`/`emitMessage`/`emitError` let a test drive the same three callbacks the
 * real browser API would invoke.
 */
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }

  onopen: EventSourceLike['onopen'] = null;
  onmessage: EventSourceLike['onmessage'] = null;
  onerror: EventSourceLike['onerror'] = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.call(this, new Event('open'));
  }

  emitMessage(data: string): void {
    this.onmessage?.call(this, new MessageEvent('message', { data }));
  }

  emitError(): void {
    this.onerror?.call(this, new Event('error'));
  }
}

const FakeCtor = FakeEventSource as unknown as EventSourceLikeConstructor;

describe('createSSEClient', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens exactly one connection and reports status transitions', () => {
    const statuses: string[] = [];
    const client = createSSEClient({
      EventSourceImpl: FakeCtor,
      onEvent: () => {},
      onStatusChange: (s) => statuses.push(s),
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(statuses).toEqual(['connecting']);

    FakeEventSource.instances[0]?.emitOpen();
    expect(statuses).toEqual(['connecting', 'open']);

    client.close();
  });

  it('parses a message frame and forwards the decoded TrainerEvent', () => {
    const received: TrainerEvent[] = [];
    const client = createSSEClient({
      EventSourceImpl: FakeCtor,
      onEvent: (ev) => received.push(ev),
    });

    const instance = FakeEventSource.instances[0];
    expect(instance).toBeDefined();
    const payload: TrainerEvent = { type: 'heartbeat', ts: 12345 };
    instance?.emitMessage(JSON.stringify(payload));

    expect(received).toEqual([payload]);
    client.close();
  });

  it('ignores a malformed message frame instead of throwing', () => {
    const received: TrainerEvent[] = [];
    const client = createSSEClient({
      EventSourceImpl: FakeCtor,
      onEvent: (ev) => received.push(ev),
    });

    expect(() => FakeEventSource.instances[0]?.emitMessage('not json{{')).not.toThrow();
    expect(received).toEqual([]);
    client.close();
  });

  it('reconnects after an error, doubling the backoff on repeated failures', () => {
    const statuses: string[] = [];
    const client = createSSEClient({
      EventSourceImpl: FakeCtor,
      onEvent: () => {},
      onStatusChange: (s) => statuses.push(s),
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
    });

    expect(client.currentBackoffMs()).toBe(100);

    // First failure: the dead connection closes itself, and a reconnect is scheduled at
    // the base backoff.
    FakeEventSource.instances[0]?.emitError();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(statuses.at(-1)).toBe('closed');
    expect(FakeEventSource.instances).toHaveLength(1); // no new connection until the timer fires

    vi.advanceTimersByTime(100);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(client.currentBackoffMs()).toBe(200); // doubled after the first failed attempt

    // Second failure in a row: backoff doubles again before the next attempt.
    FakeEventSource.instances[1]?.emitError();
    vi.advanceTimersByTime(200);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(client.currentBackoffMs()).toBe(400);

    client.close();
  });

  it('caps backoff at maxBackoffMs and resets it after a clean reconnect', () => {
    const client = createSSEClient({
      EventSourceImpl: FakeCtor,
      onEvent: () => {},
      baseBackoffMs: 1_000,
      maxBackoffMs: 3_000,
    });

    FakeEventSource.instances[0]?.emitError();
    vi.advanceTimersByTime(1_000); // -> attempt 2, backoff now 2000
    FakeEventSource.instances[1]?.emitError();
    vi.advanceTimersByTime(2_000); // -> attempt 3, backoff now min(4000,3000)=3000
    expect(client.currentBackoffMs()).toBe(3_000);

    // This attempt succeeds: backoff resets to the base value.
    FakeEventSource.instances[2]?.emitOpen();
    expect(client.currentBackoffMs()).toBe(1_000);

    client.close();
  });

  it('stops reconnecting once closed, even if a pending timer was already scheduled', () => {
    const client = createSSEClient({
      EventSourceImpl: FakeCtor,
      onEvent: () => {},
      baseBackoffMs: 50,
    });

    FakeEventSource.instances[0]?.emitError();
    client.close();
    vi.advanceTimersByTime(10_000);

    expect(FakeEventSource.instances).toHaveLength(1); // the scheduled reconnect never fired
  });

  it('closing the client closes the live underlying connection', () => {
    const client = createSSEClient({ EventSourceImpl: FakeCtor, onEvent: () => {} });
    const instance = FakeEventSource.instances[0];
    client.close();
    expect(instance?.closed).toBe(true);
  });
});
