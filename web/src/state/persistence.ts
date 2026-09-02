/**
 * UI persistence for `state/store.ts`'s `ui` slice (demo mode, divider position, active
 * reference tab, response view mode, notes draft).
 *
 * docs/SPEC.md section 13 says demo mode is "persisted in workspace.json", via
 * `GET/PUT /_trainer/api/workspace`. That endpoint is Task 5's build (it does not exist
 * on the server yet: `server/src/trainer/router.ts` has no `/api/workspace` route as of
 * this task, and this dispatch scopes Task 4 to `web/**` only, so the endpoint cannot be
 * added here). This module is a small, swappable persistence boundary: everything reads
 * and writes through `loadPersistedUi`/`savePersistedUi`, both defined only in this file,
 * so swapping the backing store to `PUT /_trainer/api/workspace` once Task 5 defines it is
 * a one-file change, not a store rewrite. Flagged in the task report.
 */

export interface PersistedUi {
  demoMode: boolean;
  dividerPct: number;
}

const STORAGE_KEY = 'outpost:ui';

export const DEFAULT_DIVIDER_PCT = 62; // matches spec section 13's "left column ~62%"

function isPersistedUi(value: unknown): value is PersistedUi {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.demoMode === 'boolean' && typeof v.dividerPct === 'number';
}

export function loadPersistedUi(): PersistedUi {
  const fallback: PersistedUi = { demoMode: false, dividerPct: DEFAULT_DIVIDER_PCT };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedUi(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function savePersistedUi(ui: PersistedUi): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ui));
  } catch {
    // localStorage can throw in private-browsing/quota-exceeded situations; losing the
    // UI persistence is not worth crashing the app over.
  }
}
