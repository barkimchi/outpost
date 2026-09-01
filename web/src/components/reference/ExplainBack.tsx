import { useState } from 'react';
import type { FormEvent } from 'react';
import { useStore } from '../../state/store.js';

/**
 * docs/SPEC.md section 13: "on scenario:explaining, the reference panel prompts for a
 * 2-3 sentence root cause and a short customer-facing reply. Submitting persists both,
 * then reveals solutionMd." Only after a successful submit does the scenario finalize as
 * solved (`state/store.ts`'s `explain()` flips `scenario.state` to `'solved'`).
 */
export function ExplainBack(): React.JSX.Element {
  const explain = useStore((s) => s.explain);
  const [rootCause, setRootCause] = useState('');
  const [customerReply, setCustomerReply] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    const ok = await explain(rootCause.trim(), customerReply.trim());
    setSubmitting(false);
    if (ok) {
      setRootCause('');
      setCustomerReply('');
    }
  }

  const disabled = submitting || rootCause.trim() === '' || customerReply.trim() === '';

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 rounded-lg border border-gym-accent-dim bg-gym-accent-dim/15 p-3">
      <p className="mb-3 text-xs font-semibold text-gym-accent-soft">All steps passed. Explain it back before this counts as solved.</p>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint" htmlFor="explain-root-cause">
        Root cause, two or three sentences
      </label>
      <textarea
        id="explain-root-cause"
        value={rootCause}
        onChange={(e) => setRootCause(e.target.value)}
        rows={3}
        placeholder="What was actually broken, and why did it produce this symptom."
        className="mb-3 w-full resize-none rounded-md border border-gym-border bg-gym-panel2 p-2 text-xs leading-relaxed text-gym-text placeholder:text-gym-text-faint focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
      />
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint" htmlFor="explain-customer-reply">
        Customer-facing reply
      </label>
      <textarea
        id="explain-customer-reply"
        value={customerReply}
        onChange={(e) => setCustomerReply(e.target.value)}
        rows={2}
        placeholder="A short, plain-language reply you would actually send."
        className="mb-3 w-full resize-none rounded-md border border-gym-border bg-gym-panel2 p-2 text-xs leading-relaxed text-gym-text placeholder:text-gym-text-faint focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
      />
      <button
        type="submit"
        disabled={disabled}
        className="rounded-md bg-gym-accent px-3.5 py-1.5 text-xs font-semibold text-gym-bg transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {submitting ? 'Submitting' : 'Submit'}
      </button>
    </form>
  );
}
