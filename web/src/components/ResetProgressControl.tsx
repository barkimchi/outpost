import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useStore } from '../state/store.js';
import { Modal } from './Modal.js';

const CONFIRM_PHRASE = 'RESET PROGRESS';

/**
 * The one control in this app that deletes something not reconstructable: every
 * scenario's solve history AND its explain-back writeups (root cause + customer reply),
 * both stored in `data/progress.json` and wiped together by `DELETE /_trainer/api/progress`
 * (`server/src/trainer/router.ts`). Deliberately placed in the Sidebar's footer, away from
 * `ExerciseBar`'s `Reset` (which re-activates the current scenario with a fresh seed and is
 * used constantly), and deliberately built with more friction than this app's other
 * confirmations (`window.confirm` for deleting a collection or a request): typing the exact
 * phrase the server itself requires, not a click, is what unlocks the button, per the
 * coordinator's dispatch that this is "the one control in the product that deserves
 * friction."
 */
function ResetProgressModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const resetAllProgress = useStore((s) => s.resetAllProgress);
  const [typed, setTyped] = useState('');
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canConfirm = typed === CONFIRM_PHRASE;

  async function handleConfirm(): Promise<void> {
    if (!canConfirm || resetting) return;
    setResetting(true);
    setError(null);
    const ok = await resetAllProgress();
    setResetting(false);
    if (ok) setDone(true);
    else setError('The reset did not go through. Nothing on disk changed; try again.');
  }

  if (done) {
    return (
      <Modal title="Progress Reset" onClose={onClose}>
        <div className="space-y-3 text-xs">
          <p className="rounded-md border border-gym-green-dim bg-gym-green-dim/20 px-3 py-2 text-gym-green">
            Done. Every scenario&apos;s solve history and explain-back writeups are gone. Solved checkmarks in the
            scenario picker are already cleared.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-gym-accent px-3.5 py-1.5 font-semibold text-gym-bg transition-opacity hover:opacity-90"
          >
            Close
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Reset All Progress" onClose={onClose}>
      <div className="space-y-4 text-xs">
        <div className="flex gap-2.5 rounded-md border border-gym-red-dim bg-gym-red-dim/15 px-3 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-gym-red" />
          <p className="leading-relaxed text-gym-red">
            This permanently deletes <span className="font-semibold">every scenario&apos;s solve history</span> and{' '}
            <span className="font-semibold">every explain-back writeup</span> (each root cause and customer reply
            you&apos;ve submitted), for every tier. It does not touch collections, environments, notes, or the
            request builder. There is no undo: the writeups are not reconstructable.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block font-medium text-gym-text-dim" htmlFor="reset-progress-confirm">
            Type <code className="rounded bg-gym-panel3 px-1 py-0.5 font-mono text-gym-accent-soft">{CONFIRM_PHRASE}</code> to
            confirm.
          </label>
          <input
            id="reset-progress-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={CONFIRM_PHRASE}
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1.5 font-mono text-xs text-gym-text placeholder:text-gym-text-faint focus:outline-none focus:ring-1 focus:ring-gym-red-dim"
          />
        </div>

        {error && <p className="rounded-md border border-gym-red-dim bg-gym-red-dim/20 px-3 py-2 text-gym-red">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gym-border bg-gym-panel2 px-3 py-1.5 font-medium text-gym-text-dim hover:border-gym-border-strong hover:text-gym-text"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm || resetting}
            onClick={() => void handleConfirm()}
            className="rounded-md bg-gym-red px-3.5 py-1.5 font-semibold text-gym-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {resetting ? 'Resetting.' : 'Reset progress'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The trigger: small, muted, in the Sidebar footer, never the current scenario's `Reset`
 *  in `ExerciseBar`. */
export function ResetProgressControl(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-gym-border px-2.5 py-1.5">
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Permanently delete all solve history and explain-back writeups"
        className="flex items-center gap-1.5 text-[10px] text-gym-text-faint hover:text-gym-red"
      >
        <AlertTriangle size={11} />
        Reset all progress.
      </button>
      {open && <ResetProgressModal onClose={() => setOpen(false)} />}
    </div>
  );
}
