import { useRef, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { useStore } from '../state/store.js';
import { MenuPopover } from './MenuPopover.js';

/** Reveals hints one at a time (docs/SPEC.md section 9: unlock at 3/6/9 attempts). A dot
 *  marks an unrevealed hint waiting to be claimed; clicking claims it and opens the
 *  review popover, which stays useful afterward for re-reading earlier hints. */
export function HintButton(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const scenario = useStore((s) => s.scenario);
  const requestHint = useStore((s) => s.requestHint);

  const hasUnclaimed = scenario.hintsRevealed < scenario.hintsUnlocked;
  const disabled = scenario.state === 'idle' || scenario.hintsUnlocked === 0;

  async function handleClick(): Promise<void> {
    if (hasUnclaimed) await requestHint();
    setOpen(true);
  }

  return (
    <div ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void handleClick()}
        title={disabled ? 'Unlocks after 3 failed attempts on the current step' : 'Show a hint'}
        className={`relative flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
          disabled
            ? 'cursor-not-allowed border-gym-border text-gym-text-faint'
            : 'border-gym-border bg-gym-panel2 text-gym-text hover:border-gym-accent-dim hover:text-gym-accent-soft'
        }`}
      >
        <Lightbulb size={13} />
        Hint
        {hasUnclaimed && !disabled && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-gym-accent" />}
      </button>
      <MenuPopover
        anchorRef={rootRef}
        open={open && scenario.hints.length > 0}
        onClose={() => setOpen(false)}
        align="right"
        className="w-72 p-3"
      >
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Hints</p>
          <ol className="space-y-2.5">
            {scenario.hints
              .slice()
              .sort((a, b) => a.index - b.index)
              .map((h) => (
                <li key={h.index} className="text-xs leading-relaxed text-gym-text-dim">
                  <span className="mr-1.5 font-mono text-gym-accent">{h.index + 1}.</span>
                  {h.text}
                </li>
              ))}
          </ol>
      </MenuPopover>
    </div>
  );
}
