import type { TrainerEvent } from '@gym/shared';

/**
 * The single `EventSource` for the whole app (docs/SPEC.md section 10: "The UI keeps
 * ONE EventSource for the whole app"). Multiple connections would duplicate log lines and
 * double-count attempts, since every open connection replays `bus.recent()` independently
 * and then streams live events on top.
 *
 * `createSSEClient` is the generic, dependency-injected piece (testable in isolation:
 * pass a fake `EventSourceImpl`). `startLiveConnection` below is the one production call
 * site, invoked exactly once from `main.tsx` before React renders, guarded by a
 * module-level flag so a stray second call (a hot reload, a defensive re-import) can never
 * open a second connection.
 */

export type SSEConnectionStatus = 'connecting' | 'open' | 'closed';

/** The subset of the browser `EventSource` API this client depends on, so tests can
 *  supply a fake implementation without touching the DOM. */
export interface EventSourceLike {
  onopen: ((this: EventSourceLike, ev: Event) => unknown) | null;
  onmessage: ((this: EventSourceLike, ev: MessageEvent<string>) => unknown) | null;
  onerror: ((this: EventSourceLike, ev: Event) => unknown) | null;
  close(): void;
}

export type EventSourceLikeConstructor = new (url: string) => EventSourceLike;

export interface SSEClientOptions {
  url?: string;
  /** Defaults to the real browser `EventSource`. Tests inject a fake. */
  EventSourceImpl?: EventSourceLikeConstructor;
  onEvent: (event: TrainerEvent) => void;
  onStatusChange?: (status: SSEConnectionStatus) => void;
  /** Starting reconnect delay in ms. Doubles on each consecutive failure, capped at
   *  `maxBackoffMs`, and resets back to this value after a successful connection. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface SSEClient {
  close: () => void;
  /** Current backoff delay, exposed for tests. Not meant for UI use. */
  currentBackoffMs: () => number;
}

const DEFAULT_URL = '/_trainer/events';
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 10_000;

export function createSSEClient(options: SSEClientOptions): SSEClient {
  const {
    url = DEFAULT_URL,
    EventSourceImpl = (globalThis as { EventSource?: EventSourceLikeConstructor }).EventSource,
    onEvent,
    onStatusChange,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  } = options;

  if (!EventSourceImpl) {
    throw new Error('createSSEClient: no EventSource implementation available (pass EventSourceImpl in tests)');
  }
  // Rebind to a definitely-assigned const: TS does not narrow a destructured binding's
  // "possibly undefined" default across the closures defined below, even though it can
  // never be reassigned after this point.
  const Ctor: EventSourceLikeConstructor = EventSourceImpl;

  let closed = false;
  let current: EventSourceLike | null = null;
  let backoff = baseBackoffMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(): void {
    if (closed) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(backoff * 2, maxBackoffMs);
      connect();
    }, backoff);
  }

  function connect(): void {
    if (closed) return;
    onStatusChange?.('connecting');
    const es = new Ctor(url);
    current = es;

    es.onopen = () => {
      backoff = baseBackoffMs; // a clean connection earns back the fast reconnect speed
      onStatusChange?.('open');
    };

    es.onmessage = (ev) => {
      let parsed: TrainerEvent;
      try {
        parsed = JSON.parse(ev.data) as TrainerEvent;
      } catch {
        return; // malformed frame; never let a bad event crash the stream
      }
      onEvent(parsed);
    };

    es.onerror = () => {
      es.close();
      if (current === es) current = null;
      onStatusChange?.('closed');
      scheduleReconnect();
    };
  }

  connect();

  return {
    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      current?.close();
      current = null;
    },
    currentBackoffMs: () => backoff,
  };
}

let started = false;
let liveClient: SSEClient | null = null;

/**
 * Production entry point. Called exactly once from `main.tsx`, before `ReactDOM.render`,
 * so it is unaffected by React StrictMode's double-invoked effects. `onEvent` should be
 * the store's single event-dispatch function; see `state/store.ts`.
 */
export function startLiveConnection(onEvent: (event: TrainerEvent) => void, onStatusChange?: (status: SSEConnectionStatus) => void): SSEClient {
  if (started && liveClient) return liveClient;
  started = true;
  liveClient = createSSEClient({ onEvent, onStatusChange });
  return liveClient;
}
