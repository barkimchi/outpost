import { EventEmitter } from 'node:events';
import type { RequestEvent } from '@gym/shared';

const RING_SIZE = 200;

/**
 * EventEmitter plus a 200-entry ring buffer (docs/SPEC.md section 6: "Bus: EventEmitter
 * + a 200-entry ring buffer replayed to each new SSE client").
 *
 * `requestLog` calls `bus.emit('request', ev)` on every captured RequestEvent, exactly
 * as spec section 6 names it. This class listens to its own `'request'` event to keep
 * the ring buffer populated regardless of how many other listeners (SSE connections,
 * later the engine's `observe()`) are also attached, and `recent()` returns a snapshot
 * for a newly connecting SSE client to replay as `log` events.
 *
 * Task 3's engine and later tasks emit their own trainer events (scenario:*,
 * hint:unlocked) through `bus.emit('trainer-event', ev: TrainerEvent)`, a second,
 * un-buffered channel `sse.ts` also forwards. Those are ambient state changes, not
 * request history, so they are not replayed on reconnect; a reconnecting client reads
 * current state from `GET /_trainer/api/state` instead (Task 3).
 */
class Bus extends EventEmitter {
  private readonly ring: RequestEvent[] = [];

  constructor() {
    super();
    this.setMaxListeners(0); // many concurrent SSE clients is expected, not a leak
    this.on('request', (ev: RequestEvent) => {
      this.ring.push(ev);
      if (this.ring.length > RING_SIZE) {
        this.ring.shift();
      }
    });
  }

  /** Most recent request events, oldest first, capped at 200. */
  recent(): RequestEvent[] {
    return this.ring.slice();
  }
}

export const bus = new Bus();
