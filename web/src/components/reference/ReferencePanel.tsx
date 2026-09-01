import { useStore } from '../../state/store.js';
import type { ReferenceTab } from '../../state/store.js';
import { TicketTab } from './TicketTab.js';
import { LogsTab } from './LogsTab.js';
import { DocsTab } from './DocsTab.js';
import { NotesTab } from './NotesTab.js';

/**
 * Right column, styled like a text editor with tabs (docs/SPEC.md section 13): Ticket
 * live, Logs live (both this task), Docs and Notes as placeholders Task 5 fills in.
 * Doubles as the entire right side of Demo mode: the whole reason Ticket + Logs must be
 * genuinely functional here, not stubbed, is that Demo mode has nothing else on screen.
 */

const TABS: Array<{ id: ReferenceTab; label: string }> = [
  { id: 'ticket', label: 'Ticket' },
  { id: 'docs', label: 'Docs' },
  { id: 'logs', label: 'Logs' },
  { id: 'notes', label: 'Notes' },
];

export function ReferencePanel(): React.JSX.Element {
  const activeTab = useStore((s) => s.ui.activeReferenceTab);
  const setReferenceTab = useStore((s) => s.setReferenceTab);
  const logCount = useStore((s) => s.logs.length);

  return (
    <div className="flex h-full min-h-0 flex-col bg-gym-bg">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-gym-border bg-gym-panel px-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setReferenceTab(t.id)}
            className={`flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === t.id
                ? 'border-gym-border bg-gym-bg text-gym-text'
                : 'border-transparent text-gym-text-faint hover:text-gym-text-dim'
            }`}
          >
            {t.label}
            {t.id === 'logs' && logCount > 0 && (
              <span className="rounded-full bg-gym-panel3 px-1.5 py-0.5 font-mono text-[9px] text-gym-text-faint">{logCount}</span>
            )}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'ticket' && <TicketTab />}
        {activeTab === 'docs' && <DocsTab />}
        {activeTab === 'logs' && <LogsTab />}
        {activeTab === 'notes' && <NotesTab />}
      </div>
    </div>
  );
}
