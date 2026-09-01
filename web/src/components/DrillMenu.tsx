import { useRef, useState } from 'react';
import { ChevronDown, Shuffle } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useOutsideClick } from '../lib/useOutsideClick.js';

const TIERS = [1, 2, 3, 4, 5, 6];

/** Drill mode: activation with `{drill:{tier?}}` (docs/SPEC.md section 9). The activated
 *  payload hides the title and fault identity, tested by the scenario slice mapping in
 *  `state/store.ts`. */
export function DrillMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activateDrill = useStore((s) => s.activateDrill);

  useOutsideClick(rootRef, open, () => setOpen(false));

  function pick(tier?: number): void {
    void activateDrill(tier);
    setOpen(false);
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1 text-xs font-medium text-gym-text transition-colors hover:border-gym-border-strong hover:bg-gym-panel3"
      >
        <Shuffle size={13} />
        Drill
        <ChevronDown size={11} className="text-gym-text-faint" />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-40 rounded-lg border border-gym-border bg-gym-panel2 p-1.5 shadow-popover">
          <button
            type="button"
            onClick={() => pick(undefined)}
            className="block w-full rounded px-2 py-1.5 text-left text-xs font-medium text-gym-text hover:bg-gym-panel3"
          >
            Any tier
          </button>
          <div className="my-1 h-px bg-gym-border" />
          {TIERS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => pick(t)}
              className="block w-full rounded px-2 py-1.5 text-left text-xs text-gym-text-dim hover:bg-gym-panel3 hover:text-gym-text"
            >
              Tier {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
