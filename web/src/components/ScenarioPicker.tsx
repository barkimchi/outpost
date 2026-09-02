import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useStore } from '../state/store.js';
import { MenuPopover } from './MenuPopover.js';
import type { ScenarioListEntry } from '../types.js';

const TIER_LABEL: Record<number, string> = {
  1: 'Tier 1, Warm-ups',
  2: 'Tier 2, GitHub',
  3: 'Tier 3, Google OAuth',
  4: 'Tier 4, Glean',
  5: 'Tier 5, Slack',
  6: 'Tier 6, Capstone',
};

const PLATFORM_TAG: Record<string, string> = {
  github: 'GH',
  google: 'GO',
  glean: 'GL',
  slack: 'SL',
  mixed: 'MX',
};

function ScenarioRow({ entry, active, onSelect }: { entry: ScenarioListEntry; active: boolean; onSelect: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-gym-panel3 ${active ? 'bg-gym-panel3' : ''}`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          entry.solved ? 'border-gym-green bg-gym-green-dim text-gym-green' : 'border-gym-border text-transparent'
        }`}
      >
        <Check size={10} strokeWidth={3} />
      </span>
      <span className="flex-1 truncate text-gym-text">{entry.title}</span>
      <span className="rounded bg-gym-panel3 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide text-gym-text-faint">
        {PLATFORM_TAG[entry.platform] ?? entry.platform}
      </span>
      <span className="w-7 text-right font-mono text-[10px] text-gym-text-faint">{entry.runs}x</span>
    </button>
  );
}

/** Scenario picker: solved checkmarks, grouped by tier, spec section 13's "scenario
 *  picker with solved checkmarks". */
export function ScenarioPicker(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const scenarios = useStore((s) => s.scenarios);
  const current = useStore((s) => s.scenario);
  const loadScenarios = useStore((s) => s.loadScenarios);
  const activateScenario = useStore((s) => s.activateScenario);

  const { byTier, impl } = useMemo(() => {
    const troubleshoot = scenarios.filter((s) => s.track === 'troubleshoot');
    const implementation = scenarios.filter((s) => s.track === 'implementation');
    const grouped = new Map<number, ScenarioListEntry[]>();
    for (const s of troubleshoot) {
      const list = grouped.get(s.tier) ?? [];
      list.push(s);
      grouped.set(s.tier, list);
    }
    return { byTier: grouped, impl: implementation };
  }, [scenarios]);

  const currentEntry = scenarios.find((s) => s.id === current.scenarioId);
  // Drill mode (docs/SPEC.md section 9): tier is fault-adjacent identity, hidden for the
  // length of a drill same as title/platform in TicketTab, so the label just says "Drill",
  // never "Drill, tier 3".
  const label = current.drill
    ? 'Drill'
    : current.scenarioId
      ? (currentEntry?.title ?? current.title ?? current.scenarioId)
      : 'Select a scenario';

  function toggle(): void {
    const next = !open;
    setOpen(next);
    if (next) void loadScenarios();
  }

  function select(id: string): void {
    void activateScenario(id);
    setOpen(false);
  }

  return (
    <div ref={rootRef}>
      <button
        type="button"
        onClick={toggle}
        aria-label="Scenario picker"
        className="flex items-center gap-1.5 rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1 text-xs font-medium text-gym-text transition-colors hover:border-gym-border-strong hover:bg-gym-panel3"
      >
        <span className="max-w-[200px] truncate">{label}</span>
        <ChevronDown size={13} className="text-gym-text-faint" />
      </button>
      <MenuPopover anchorRef={rootRef} open={open} onClose={() => setOpen(false)} align="left" className="w-80 p-1.5">
          {scenarios.length === 0 && <p className="px-2 py-3 text-xs text-gym-text-faint">No scenarios registered yet.</p>}
          {[...byTier.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([tier, list]) => (
              <div key={tier} className="mb-1">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">
                  {TIER_LABEL[tier] ?? `Tier ${tier}`}
                </div>
                {list.map((sc) => (
                  <ScenarioRow key={sc.id} entry={sc} active={sc.id === current.scenarioId} onSelect={() => select(sc.id)} />
                ))}
              </div>
            ))}
          {impl.length > 0 && (
            <div className="mb-1">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Implementation track</div>
              {impl.map((sc) => (
                <ScenarioRow key={sc.id} entry={sc} active={sc.id === current.scenarioId} onSelect={() => select(sc.id)} />
              ))}
            </div>
          )}
      </MenuPopover>
    </div>
  );
}
