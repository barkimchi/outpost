import { useEffect, useMemo } from 'react';
import { Check } from 'lucide-react';
import { useStore } from '../../state/store.js';
import { Markdown } from '../../lib/markdown.js';
import type { DocSummary } from '../../types.js';

/**
 * The Docs tab (docs/SPEC.md section 10/13), wired to `GET /_trainer/api/docs` and
 * `GET /_trainer/api/docs/:id`. This is the single source the implementation track (Task 8)
 * is meant to be solvable from alone, so it gets a real two-pane reference layout (doc list
 * left, rendered markdown right), not a dropdown bolted onto a text block.
 *
 * Fix round (this task's finding 1): `scenario.docsRef` (the active scenario's own list of
 * which doc(s) it touches, e.g. the capstone's `['google-oauth', 'glean']`) had been
 * authored, typed, and plumbed all the way to the wire across an entire prior fix round,
 * and still had zero consumers: this tab always auto-selected `docs[0]`, so the capstone
 * opened on GitHub every time. `docsRef` now decides both the doc LIST order (its docs
 * float to the top) and the initial SELECTION (the first of them), while every other doc
 * stays listed and clickable below, since a learner may genuinely want another platform's
 * page (`impl-glean` referencing `glean` docs mid-`impl-oauth` googling, for instance).
 */
/**
 * The active scenario's steps, rendered as a readable checklist.
 *
 * Before this, the ONLY place a step was visible anywhere in the app was `ExerciseBar`'s
 * `StepChips`: a row of 20px circles whose titles existed solely as a native `title=`
 * tooltip, so reading your own checklist meant hovering each circle and waiting on an OS
 * tooltip. Nothing in the right-hand panel rendered steps at all.
 *
 * Drill mode (docs/SPEC.md section 9) applies here exactly as it does to `StepChips`:
 * "only ticketMd and step count are exposed". A step title is fault identity, so a drill
 * run renders the anonymous "Step N" form and never `step.title`, no matter what the
 * store happens to carry. Progress (count, which one is current, which are done) stays
 * visible, since that is not identity.
 */
function StepList(): React.JSX.Element | null {
  const scenario = useStore((s) => s.scenario);
  if (scenario.state === 'idle' || scenario.stepCount === 0) return null;

  // Same fallback shape as StepChips: a run may carry a stepCount without titles.
  const items =
    scenario.steps.length > 0
      ? scenario.steps
      : Array.from({ length: scenario.stepCount }, (_, i) => ({
          id: `anon-${i}`,
          title: undefined as string | undefined,
          done: i < scenario.currentStepIndex,
        }));

  return (
    <div className="shrink-0 border-b border-gym-border px-4 py-3">
      <p className="mb-2 font-mono text-[9px] uppercase tracking-wide text-gym-text-faint">Steps</p>
      <ol className="flex flex-col gap-1.5">
        {items.map((step, i) => {
          const isCurrent = scenario.state === 'active' && i === scenario.currentStepIndex;
          const label = scenario.drill ? `Step ${i + 1}` : (step.title ?? `Step ${i + 1}`);
          return (
            <li key={step.id} className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[9px] font-semibold ${
                  step.done
                    ? 'bg-gym-green-dim text-gym-green'
                    : isCurrent
                      ? 'border border-gym-accent text-gym-accent-soft'
                      : 'border border-gym-border text-gym-text-faint'
                }`}
              >
                {step.done ? <Check size={10} strokeWidth={3} /> : i + 1}
              </span>
              <span
                className={`text-xs leading-4 ${
                  step.done
                    ? 'text-gym-text-faint line-through'
                    : isCurrent
                      ? 'text-gym-text'
                      : 'text-gym-text-dim'
                }`}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function DocsTab(): React.JSX.Element {
  const docs = useStore((s) => s.docs);
  const activeDocId = useStore((s) => s.activeDocId);
  const activeDoc = useStore((s) => s.activeDoc);
  const docsError = useStore((s) => s.docsError);
  const selectDoc = useStore((s) => s.selectDoc);
  const docsRef = useStore((s) => s.scenario.docsRef);

  const orderedDocs = useMemo(() => {
    if (docsRef.length === 0) return docs;
    const byId = new Map(docs.map((d) => [d.id, d]));
    const referenced = docsRef.map((id) => byId.get(id)).filter((d): d is DocSummary => d !== undefined);
    const referencedIds = new Set(referenced.map((d) => d.id));
    return [...referenced, ...docs.filter((d) => !referencedIds.has(d.id))];
  }, [docs, docsRef]);

  const preferredDocId = docsRef.find((id) => docs.some((d) => d.id === id));

  useEffect(() => {
    if (docs.length === 0) return;
    const target = preferredDocId ?? docs[0]?.id;
    // Re-select whenever the doc list first loads, or the active scenario's `docsRef`
    // identity changes (a new scenario activated, a drill drew a different one); the
    // `activeDocId !== target` guard means a learner's manual pick of another platform's
    // doc survives untouched through the rest of THAT scenario's run.
    if (target !== undefined && target !== activeDocId) void selectDoc(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.length, docsRef.join(',')]);

  if (docs.length === 0) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <StepList />
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-gym-text-faint">
          {docsError ? `Could not load docs: ${docsError}` : 'No docs available yet.'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <StepList />
      <div className="grid min-h-0 flex-1 grid-cols-[160px_1fr] overflow-hidden">
        <div className="min-h-0 overflow-y-auto border-r border-gym-border py-1.5">
          {orderedDocs.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => void selectDoc(d.id)}
              className={`block w-full px-3 py-1.5 text-left text-xs transition-colors ${
                activeDocId === d.id ? 'bg-gym-panel2 text-gym-text' : 'text-gym-text-dim hover:bg-gym-panel2/60 hover:text-gym-text'
              }`}
            >
              <span className="block truncate">{d.title}</span>
              <span className="block truncate font-mono text-[9px] uppercase tracking-wide text-gym-text-faint">{d.platform}</span>
            </button>
          ))}
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          {!activeDoc && !docsError && <p className="text-xs text-gym-text-faint">Loading.</p>}
          {docsError && <p className="text-xs text-gym-red">{docsError}</p>}
          {activeDoc && (
            <div className="mx-auto max-w-[68ch]">
              <Markdown text={activeDoc.md} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
