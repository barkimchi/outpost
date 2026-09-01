import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { RequestEvent } from '@gym/shared';
import { useStore } from '../../state/store.js';
import { CodeBlock } from '../CodeBlock.js';
import { formatClockTime, statusBand } from '../../lib/format.js';
import { STATUS_BAND_CLASSES } from '../../lib/statusColors.js';

/**
 * The Logs tab: "evidence a learner reads" (this task's brief). Shows the verbatim
 * `path` (spec section 6: never `pathLower`, which is match-only and can silently differ
 * from what was actually sent), status, timing, and a source badge distinguishing traffic
 * that came through the built-in proxy from traffic that arrived from outside the
 * process, real Postman desktop or curl, which is Demo mode's entire point. Newest last,
 * replayed from the bus's 200-entry ring buffer on connect plus everything live since.
 */

function SourceBadge({ source }: { source: RequestEvent['source'] }): React.JSX.Element {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide ${
        source === 'proxy' ? 'bg-gym-blue-dim text-gym-blue' : 'bg-gym-purple/20 text-gym-purple'
      }`}
      title={source === 'proxy' ? 'Sent from this app, the request builder' : 'Arrived from outside this app (real Postman, curl, ...)'}
    >
      {source}
    </span>
  );
}

function LogRow({ event }: { event: RequestEvent }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gym-border/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-gym-panel2"
      >
        <ChevronRight size={12} className={`shrink-0 text-gym-text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="w-[84px] shrink-0 font-mono text-[10px] text-gym-text-faint">{formatClockTime(event.ts)}</span>
        <span className="w-14 shrink-0 font-mono text-[10px] font-bold text-gym-text-dim">{event.method}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-gym-text" title={event.path}>
          {event.path}
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${STATUS_BAND_CLASSES[statusBand(event.status)]}`}>
          {event.status}
        </span>
        <span className="w-14 shrink-0 text-right font-mono text-[10px] text-gym-text-faint">{Math.round(event.durationMs)}ms</span>
        <SourceBadge source={event.source} />
      </button>
      {open && (
        <div className="space-y-3 bg-gym-panel/40 px-3 pb-3 pt-1">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Request headers</p>
            <CodeBlock text={JSON.stringify(event.reqHeaders, null, 2)} mode="json" />
          </div>
          {event.reqBody !== null && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">
                Request body{event.reqBodyTruncated ? ' (truncated at 8KB)' : ''}
              </p>
              <CodeBlock text={event.reqBody} />
            </div>
          )}
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Response headers</p>
            <CodeBlock text={JSON.stringify(event.resHeaders, null, 2)} mode="json" />
          </div>
          {event.resBody !== null && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">
                Response body{event.resBodyTruncated ? ' (truncated at 8KB)' : ''}
              </p>
              <CodeBlock text={event.resBody} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LogsTab(): React.JSX.Element {
  const logs = useStore((s) => s.logs);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [logs.length]);

  function handleScroll(): void {
    const el = containerRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  if (logs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-gym-text-faint">
        No requests yet. Fire one from the builder, or point real Postman, curl, or anything else at this server.
      </div>
    );
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto">
      {logs.map((ev) => (
        <LogRow key={ev.id} event={ev} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
