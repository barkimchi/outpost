import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { X } from 'lucide-react';
import { useStore } from './state/store.js';
import { ExerciseBar } from './components/ExerciseBar.js';
import { RequestBuilder } from './components/postman/RequestBuilder.js';
import { ResponsePanel } from './components/postman/ResponsePanel.js';
import { ReferencePanel } from './components/reference/ReferencePanel.js';

/**
 * The CSS grid shell (docs/SPEC.md section 13): `ExerciseBar` (48px) over a row that is
 * either Postman column / draggable divider / `ReferencePanel`, or, in Demo mode, just
 * `ReferencePanel` full width. Demo mode and the divider position are the `ui` slice in
 * `state/store.ts`, persisted through `state/persistence.ts`.
 */
export default function App(): React.JSX.Element {
  const init = useStore((s) => s.init);
  const demoMode = useStore((s) => s.ui.demoMode);
  const dividerPct = useStore((s) => s.ui.dividerPct);
  const setDividerPct = useStore((s) => s.setDividerPct);
  const toggleDemoMode = useStore((s) => s.toggleDemoMode);
  const errorMessage = useStore((s) => s.errorMessage);
  const setErrorMessage = useStore((s) => s.setErrorMessage);

  const rowRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    void init();
    // Runs once on mount; `init` is a stable action reference from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggleDemoMode();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleDemoMode]);

  useEffect(() => {
    if (!errorMessage) return;
    const timer = setTimeout(() => setErrorMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [errorMessage, setErrorMessage]);

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current || !rowRef.current) return;
    const rect = rowRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setDividerPct(pct);
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return (
    <div className="grid h-screen grid-rows-[48px_1fr] overflow-hidden bg-gym-bg">
      <ExerciseBar />

      <div
        ref={rowRef}
        className="grid min-h-0"
        style={{ gridTemplateColumns: demoMode ? '1fr' : `${dividerPct}% 6px 1fr` }}
      >
        {!demoMode && (
          <>
            <div className="flex min-h-0 min-w-0 flex-col border-r border-gym-border">
              <RequestBuilder />
              <ResponsePanel />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize Postman column"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              className="group flex cursor-col-resize items-stretch justify-center"
            >
              <div className="w-px bg-gym-border transition-colors group-hover:bg-gym-accent-dim group-active:bg-gym-accent" />
            </div>
          </>
        )}
        <div className="min-h-0 min-w-0">
          <ReferencePanel />
        </div>
      </div>

      {errorMessage && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-gym-red-dim bg-gym-panel2 px-3.5 py-2.5 shadow-popover">
          <div className="flex items-start gap-2.5">
            <p className="flex-1 text-xs leading-relaxed text-gym-text-dim">{errorMessage}</p>
            <button type="button" onClick={() => setErrorMessage(null)} className="shrink-0 text-gym-text-faint hover:text-gym-text" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
