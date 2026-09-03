import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * The Docs tab step list. Added because the only prior rendering of a step anywhere in the
 * app was `ExerciseBar`'s 20px `StepChips` circles, whose titles lived solely in a native
 * `title=` tooltip: reading your own checklist meant hovering each circle in turn.
 *
 * The load-bearing test here is the drill one. docs/SPEC.md section 9 restricts a drill run
 * to `ticketMd` and the step COUNT, because a step title IS the fault identity, and the
 * identical leak was already caught once in `ExerciseBar.test.tsx` (a chip tooltip rendering
 * `chip.title` regardless of `scenario.drill`). A second surface rendering the same array is
 * a second chance to reintroduce it, so this asserts the rendering layer directly rather
 * than trusting that titles never reach the client during a drill.
 */

vi.mock('../../api/client.js', () => ({
  trainerApi: { listDocs: vi.fn(), getDoc: vi.fn() },
}));

const { useStore } = await import('../../state/store.js');
const { DocsTab } = await import('./DocsTab.js');

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState(initialState, true);
});
afterEach(() => {
  useStore.setState(initialState, true);
});

function activate(overrides: { drill: boolean }): void {
  useStore.setState({
    scenario: {
      ...useStore.getState().scenario,
      state: 'active',
      scenarioId: overrides.drill ? undefined : 'impl-github',
      title: overrides.drill ? undefined : 'GitHub go-live',
      tier: 2,
      platform: 'github',
      drill: overrides.drill,
      seed: 'seed-1',
      ticketMd: '## Ticket',
      docsRef: [],
      stepCount: 3,
      currentStepIndex: 2,
      steps: [
        { id: 'step-1', title: 'Authenticate and confirm identity', done: true },
        { id: 'step-2', title: 'Confirm access to the org', done: true },
        { id: 'step-3', title: 'Retrieve every repo in the org, not just the first page', done: false },
      ],
    },
  });
}

describe('DocsTab step list', () => {
  it('renders every step title as readable text, not a hover-only tooltip', () => {
    activate({ drill: false });
    render(<DocsTab />);
    expect(screen.getByText('Authenticate and confirm identity')).toBeInTheDocument();
    expect(screen.getByText('Confirm access to the org')).toBeInTheDocument();
    expect(
      screen.getByText('Retrieve every repo in the org, not just the first page'),
    ).toBeInTheDocument();
  });

  it('never exposes a step title during a drill, even when the store carries one', () => {
    activate({ drill: true });
    render(<DocsTab />);
    expect(screen.queryByText(/Retrieve every repo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Confirm access to the org/)).not.toBeInTheDocument();
    // Progress is not identity: the count and position must still be visible.
    expect(screen.getByText('Step 3')).toBeInTheDocument();
  });

  it('renders nothing at all when no scenario is active', () => {
    render(<DocsTab />);
    expect(screen.queryByText('Steps')).not.toBeInTheDocument();
  });
});
