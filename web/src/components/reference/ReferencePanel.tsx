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
 *
 * Fix round (design): the plain single-tab layout, stretched to Demo mode's full ~1440px
 * with no prose measure anywhere, left roughly 60% of the screen as black void with
 * ragged, full-width ticket text. Demo mode is the capstone recording a viewer
 * actually watches, so it gets a real second-column layout here rather than
 * the normal layout with the Postman column merely hidden: Ticket/Docs/Notes on the
 * left, capped at a readable measure, paired with a permanently-visible live Logs rail on
 * the right, exactly the "ticket + proof of the API call happening" pairing a viewer of
 * that recording wants side by side. The Logs tab itself is redundant once that rail is
 * always on screen, so it drops out of the tab strip in Demo mode; a session that had
 * "Logs" selected before Demo mode was toggled on falls back to Ticket rather than
 * rendering nothing.
 */

const TABS: Array<{ id: ReferenceTab; label: string }> = [
  { id: 'ticket', label: 'Ticket' },
  { id: 'docs', label: 'Docs' },
  { id: 'logs', label: 'Logs' },
  { id: 'notes', label: 'Notes' },
];

function TabContent({ tab }: { tab: ReferenceTab }): React.JSX.Element {
  if (tab === 'ticket') return <TicketTab />;
  if (tab === 'docs') return <DocsTab />;
  if (tab === 'logs') return <LogsTab />;
  return <NotesTab />;
}

export function ReferencePanel(): React.JSX.Element {
  const activeTab = useStore((s) => s.ui.activeReferenceTab);
  const setReferenceTab = useStore((s) => s.setReferenceTab);
  const logCount = useStore((s) => s.logs.length);
  const demoMode = useStore((s) => s.ui.demoMode);

  const tabs = demoMode ? TABS.filter((t) => t.id !== 'logs') : TABS;
  // Logs is always on screen in the side rail in Demo mode, so it is never a valid main
  // tab there; a tab selection made before Demo mode was toggled on falls back to Ticket
  // instead of rendering an empty pane.
  const mainTab: ReferenceTab = demoMode && activeTab === 'logs' ? 'ticket' : activeTab;

  const tabStrip = (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-gym-border bg-gym-panel px-2 pt-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setReferenceTab(t.id)}
          className={`flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium transition-colors ${
            mainTab === t.id
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
  );

  if (!demoMode) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-gym-bg">
        {tabStrip}
        <div className="min-h-0 flex-1 overflow-hidden">
          <TabContent tab={mainTab} />
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 bg-gym-bg lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-h-0 min-w-0 flex-col border-gym-border lg:border-r">
        {tabStrip}
        <div className="min-h-0 flex-1 overflow-hidden">
          <TabContent tab={mainTab} />
        </div>
      </div>
      <div className="flex min-h-0 flex-col border-t border-gym-border bg-gym-panel/30 lg:border-t-0">
        <div className="flex shrink-0 items-center gap-2 border-b border-gym-border bg-gym-panel px-3 py-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gym-green" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Live requests</span>
          {logCount > 0 && (
            <span className="ml-auto rounded-full bg-gym-panel3 px-1.5 py-0.5 font-mono text-[9px] text-gym-text-faint">{logCount}</span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <LogsTab />
        </div>
      </div>
    </div>
  );
}

