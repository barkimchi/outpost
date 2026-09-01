import type { Request, Response } from 'express';
import { bus } from '../bus.js';
import type { RequestEvent, TrainerEvent } from '@gym/shared';

const HEARTBEAT_MS = 15_000;

function toLogEvent(event: RequestEvent): TrainerEvent {
  return { type: 'log', event };
}

function writeEvent(res: Response, event: TrainerEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * `GET /_trainer/events`, spec section 6/10. Headers set exactly per spec's hard
 * constraint 10 so proxies (and Vite's dev proxy) do not buffer the stream. Replays
 * `bus.recent()` as `log` events on connect so a client attaching mid-session sees the
 * trailing request history, then streams new `log` events live plus a 15s heartbeat.
 *
 * Task 3's engine publishes scenario lifecycle and hint:unlocked events via
 * `bus.emit('trainer-event', ev)` (see bus.ts); this handler forwards those verbatim, so
 * wiring the engine in later requires no change here.
 */
export function sseHandler(req: Request, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  for (const ev of bus.recent()) {
    writeEvent(res, toLogEvent(ev));
  }

  const onRequest = (ev: RequestEvent): void => writeEvent(res, toLogEvent(ev));
  const onTrainerEvent = (ev: TrainerEvent): void => writeEvent(res, ev);
  bus.on('request', onRequest);
  bus.on('trainer-event', onTrainerEvent);

  const heartbeat = setInterval(() => {
    writeEvent(res, { type: 'heartbeat', ts: Date.now() });
  }, HEARTBEAT_MS);

  function cleanup(): void {
    clearInterval(heartbeat);
    bus.off('request', onRequest);
    bus.off('trainer-event', onTrainerEvent);
  }

  req.on('close', cleanup);
  res.on('close', cleanup);
}
