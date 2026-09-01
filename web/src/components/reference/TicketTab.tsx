import type { ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Markdown } from '../../lib/markdown.js';
import { ExplainBack } from './ExplainBack.js';

function Tag({ children, accent }: { children: ReactNode; accent?: boolean }): React.JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
        accent ? 'bg-gym-accent-dim text-gym-accent-soft' : 'bg-gym-panel3 text-gym-text-faint'
      }`}
    >
      {children}
    </span>
  );
}

/** The ticket (spec section 13's editor-styled reference panel), the Explain-back prompt
 *  once every step passes, and the revealed solution once solved. */
export function TicketTab(): React.JSX.Element {
  const scenario = useStore((s) => s.scenario);
  const revealSolution = useStore((s) => s.revealSolution);

  if (scenario.state === 'idle' || !scenario.ticketMd) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-gym-text-faint">
        Pick a scenario from the bar above to load a ticket.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      {/* A real prose measure (docs/SPEC.md section 13, fix round): without a cap, ticket
       *  text ran the full width of whatever column it happened to be given, ragged and
       *  hard to read at Demo mode's full 1440px. `mx-auto` centers this block when the
       *  column is wider than 68ch (Demo mode); it is a no-op in the narrower normal-mode
       *  reference panel, which is already close to 68ch itself. */}
      <div className="mx-auto max-w-[68ch]">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {/* Drill mode (docs/SPEC.md section 9): "only ticketMd and step count are
           *  exposed." Tier and platform are fault-adjacent identity (they narrow which of
           *  the four mock platforms and which difficulty band this run is), so both stay
           *  hidden for the length of a drill, the same way title and scenarioId already
           *  do server-side. */}
          {!scenario.drill && scenario.tier !== undefined && <Tag>Tier {scenario.tier}</Tag>}
          {!scenario.drill && scenario.platform && <Tag>{scenario.platform}</Tag>}
          {scenario.drill && <Tag accent>Drill</Tag>}
          {scenario.seed && <span className="ml-auto font-mono text-[10px] text-gym-text-faint">run #{scenario.seed}</span>}
        </div>

        <Markdown text={scenario.ticketMd} />

        {scenario.state === 'explaining' && <ExplainBack />}

        {scenario.state === 'solved' && (
          <div className="mt-5 rounded-lg border border-gym-green-dim bg-gym-green-dim/15 p-3">
            <p className="mb-2 text-xs font-semibold text-gym-green">Solved.</p>
            {scenario.solutionMd ? (
              <Markdown text={scenario.solutionMd} />
            ) : (
              <button
                type="button"
                onClick={() => void revealSolution()}
                className="text-xs text-gym-text-dim underline decoration-gym-border underline-offset-2 hover:text-gym-text"
              >
                Reveal the solution
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
