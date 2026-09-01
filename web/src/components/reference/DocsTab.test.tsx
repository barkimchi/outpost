import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ActivatedPayload } from '../../types.js';

/**
 * Finding 1 (this task's final-review dispatch): `docsRef` was authored on every
 * scenario, typed, and plumbed all the way to the wire across an entire prior fix round,
 * and still had zero consumers on the web side. `DocsTab` always auto-selected `docs[0]`,
 * so the capstone (`docsRef: ['google-oauth', 'glean']`) opened on GitHub every time. That
 * bug survived three rounds of "is the field present/typed/plumbed" checks precisely
 * because none of them asked what actually RENDERS; these tests assert the observable
 * selection (which doc's markdown is on screen), not that `scenario.docsRef` merely holds
 * the right array, so a regression that reintroduces the "authored but unread" pattern
 * fails here even if every layer up to the store still looks correct in isolation.
 */

vi.mock('../../api/client.js', () => ({
  trainerApi: {
    listDocs: vi.fn(),
    getDoc: vi.fn(),
  },
}));

const { trainerApi } = await import('../../api/client.js');
const { useStore } = await import('../../state/store.js');
const { DocsTab } = await import('./DocsTab.js');

const mocked = trainerApi as unknown as {
  listDocs: ReturnType<typeof vi.fn>;
  getDoc: ReturnType<typeof vi.fn>;
};

const initialState = useStore.getState();

const DOCS = [
  { id: 'github', title: 'GitHub REST API', platform: 'github' as const },
  { id: 'google-oauth', title: 'Google OAuth 2.0', platform: 'google' as const },
  { id: 'glean', title: 'Glean', platform: 'glean' as const },
];

beforeEach(() => {
  useStore.setState(initialState, true);
  vi.clearAllMocks();
  mocked.listDocs.mockResolvedValue(DOCS);
  mocked.getDoc.mockImplementation((id: string) => Promise.resolve({ id, title: `${id} doc`, md: `# ${id} heading` }));
});

afterEach(() => {
  // This project's vitest config does not set `test.globals: true`, so
  // `@testing-library/react`'s automatic afterEach-cleanup (which detects a global
  // `afterEach`) never registers; without an explicit `cleanup()` here, each render in
  // this file would pile onto the previous one, and `screen`-scoped queries would start
  // seeing multiple matches across tests.
  cleanup();
  vi.restoreAllMocks();
});

function activatedPayload(overrides: Partial<ActivatedPayload> = {}): ActivatedPayload {
  return {
    seed: 'seed-1',
    tier: 6,
    track: 'troubleshoot',
    platform: 'mixed',
    scenarioId: 't6-capstone',
    title: 'Full go-live: Google OAuth into Glean',
    ticketMd: '## Ticket',
    steps: [{ id: 'step-1', title: 'Step one' }],
    stepCount: 6,
    drill: false,
    docsRef: ['google-oauth', 'glean'],
    ...overrides,
  };
}

async function activate(payload: ActivatedPayload): Promise<void> {
  useStore.getState().handleTrainerEvent({ type: 'scenario:activated', ts: 1, ...payload });
}

function activeHeadingText(): string | undefined {
  return screen.queryByRole('heading', { level: 1 })?.textContent ?? undefined;
}

describe('DocsTab: consumes scenario.docsRef', () => {
  it('opens the capstone on its first referenced doc (google-oauth), not docs[0] (github)', async () => {
    await useStore.getState().loadDocs();
    await activate(activatedPayload());

    render(<DocsTab />);

    await waitFor(() => expect(activeHeadingText()).toBe('google-oauth heading'));
    // Never GitHub: the exact regression this finding describes.
    expect(activeHeadingText()).not.toBe('github heading');
  });

  it('keeps every doc reachable in the list, including ones the active scenario does not reference', async () => {
    await useStore.getState().loadDocs();
    await activate(activatedPayload());

    render(<DocsTab />);
    await waitFor(() => expect(activeHeadingText()).toBe('google-oauth heading'));

    // GitHub is not referenced by the capstone, but a learner must still be able to find
    // and open it.
    const githubRow = screen.getByText('GitHub REST API');
    expect(githubRow).toBeInTheDocument();
    fireEvent.click(githubRow);
    await waitFor(() => expect(activeHeadingText()).toBe('github heading'));
  });

  it('a manual pick of another platform survives until the next activation, which re-opens on the new docsRef', async () => {
    await useStore.getState().loadDocs();
    await activate(activatedPayload({ scenarioId: 't2-revoked-pat', title: 'Revoked PAT', docsRef: ['github'], platform: 'github', tier: 2 }));

    render(<DocsTab />);
    await waitFor(() => expect(activeHeadingText()).toBe('github heading'));

    // Learner manually opens Glean mid-scenario (say, to compare something). It must stick.
    fireEvent.click(screen.getByText('Glean'));
    await waitFor(() => expect(activeHeadingText()).toBe('glean heading'));

    // Activating a new scenario resets the selection to ITS docsRef, overriding the
    // learner's earlier manual pick from the previous scenario.
    await activate(activatedPayload());
    await waitFor(() => expect(activeHeadingText()).toBe('google-oauth heading'));
  });

  it('a scenario with no docsRef (idle/none loaded yet) falls back to the plain doc list order', async () => {
    await useStore.getState().loadDocs();

    render(<DocsTab />);

    await waitFor(() => expect(activeHeadingText()).toBe('github heading'));
  });
});
