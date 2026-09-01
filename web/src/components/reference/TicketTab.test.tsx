import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useStore } from '../../state/store.js';
import { TicketTab } from './TicketTab.js';

/**
 * Finding 3 (final-review dispatch): docs/SPEC.md section 9 says an active Drill run
 * exposes only `ticketMd` and the step count, with title and fault identity hidden. The
 * Ticket tab was showing Tier and Platform tags regardless of `scenario.drill`, which
 * narrows the fault space (which of the 4 mock platforms, which difficulty band) well
 * past "closest rep to a real cold escalation." These tests assert the rendered tags, not
 * the underlying scenario slice, since the slice itself was never wrong.
 */

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState(initialState, true);
});

afterEach(() => {
  // RTL's automatic afterEach-cleanup (registered via `vitest.config.ts`'s
  // `test.globals: true`) unmounts the render; only the store needs resetting here.
  useStore.setState(initialState, true);
});

function activateNonDrill(): void {
  useStore.setState({
    scenario: {
      ...useStore.getState().scenario,
      state: 'active',
      scenarioId: 't2-revoked-pat',
      title: 'Revoked PAT',
      tier: 2,
      platform: 'github',
      drill: false,
      seed: 'seed-1',
      ticketMd: '## Ticket\n\nSomething is broken.',
      stepCount: 1,
    },
  });
}

function activateDrill(): void {
  useStore.setState({
    scenario: {
      ...useStore.getState().scenario,
      state: 'active',
      scenarioId: undefined,
      title: undefined,
      tier: 3,
      platform: 'google',
      drill: true,
      seed: 'seed-2',
      ticketMd: '## Ticket\n\nSomething is broken.',
      stepCount: 4,
    },
  });
}

describe('TicketTab: drill mode hides tier and platform badges', () => {
  it('shows Tier and platform tags for an ordinary (non-drill) activation', () => {
    activateNonDrill();
    render(<TicketTab />);
    expect(screen.getByText('Tier 2')).toBeInTheDocument();
    expect(screen.getByText('github')).toBeInTheDocument();
    expect(screen.queryByText('Drill')).not.toBeInTheDocument();
  });

  it('hides Tier and platform tags during a drill, showing only the Drill tag', () => {
    activateDrill();
    render(<TicketTab />);
    expect(screen.queryByText('Tier 3')).not.toBeInTheDocument();
    expect(screen.queryByText('google')).not.toBeInTheDocument();
    expect(screen.getByText('Drill')).toBeInTheDocument();
  });
});
