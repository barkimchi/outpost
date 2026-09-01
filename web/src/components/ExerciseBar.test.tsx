import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useStore } from '../state/store.js';
import { ExerciseBar } from './ExerciseBar.js';

/**
 * Finding 3 (final-review dispatch): a step chip's tooltip used to show `chip.title`
 * whenever it was present, with no regard for `scenario.drill`. docs/SPEC.md section 9
 * says a Drill run exposes only `ticketMd` and the step COUNT, title and fault identity
 * hidden; a step title in a tooltip ("Send the identical refresh again", the capstone's
 * step 4) is exactly that identity leaking one hover at a time. This test sets
 * `scenario.steps` with REAL titles alongside `drill: true` (the shape a leak would take
 * regardless of which upstream layer produced it), so it guards the rendering layer
 * directly rather than trusting that titles never reach the client during a drill.
 */

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState(initialState, true);
});

afterEach(() => {
  // No `test.globals: true` in this project's vitest config, so RTL's automatic
  // afterEach-cleanup never registers; without this, `screen`-scoped queries below would
  // see leftover DOM from the previous test's render.
  cleanup();
  useStore.setState(initialState, true);
});

function activate(overrides: { drill: boolean }): void {
  useStore.setState({
    scenario: {
      ...useStore.getState().scenario,
      state: 'active',
      scenarioId: overrides.drill ? undefined : 't6-capstone',
      title: overrides.drill ? undefined : 'Full go-live: Google OAuth into Glean',
      tier: 6,
      platform: 'mixed',
      drill: overrides.drill,
      seed: 'seed-1',
      ticketMd: '## Ticket',
      stepCount: 6,
      currentStepIndex: 3,
      steps: [
        { id: 'step-1', title: 'Complete consent and exchange the code for a token', done: true },
        { id: 'step-2', title: 'Prove access via userinfo', done: true },
        { id: 'step-3', title: 'Refresh the access token, and watch it work', done: true },
        { id: 'step-4', title: 'Send the identical refresh again, and see what changed', done: false },
        { id: 'step-5', title: 'Get a genuinely fresh access and refresh pair', done: false },
        { id: 'step-6', title: 'Confirm the document is genuinely indexed', done: false },
      ],
    },
  });
}

describe('ExerciseBar step chips: drill mode hides step titles from the tooltip', () => {
  it('shows the real step title in the tooltip for an ordinary (non-drill) run', () => {
    activate({ drill: false });
    render(<ExerciseBar />);
    const chip4 = screen.getByTitle('Send the identical refresh again, and see what changed');
    expect(chip4).toBeInTheDocument();
  });

  it('never exposes a step title during a drill, even when the chip data carries one', () => {
    activate({ drill: true });
    render(<ExerciseBar />);
    expect(screen.queryByTitle(/Send the identical refresh again/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Complete consent/)).not.toBeInTheDocument();
    // Step count/progress must still be visible: 6 anonymous chips, step 4 addressable by
    // its generic "Step N" tooltip.
    expect(screen.getByTitle('Step 4')).toBeInTheDocument();
  });
});
