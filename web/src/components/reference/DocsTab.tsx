import { useEffect } from 'react';
import { useStore } from '../../state/store.js';
import { Markdown } from '../../lib/markdown.js';

/**
 * The Docs tab (docs/SPEC.md section 10/13), wired to `GET /_trainer/api/docs` and
 * `GET /_trainer/api/docs/:id`. This is the single source the implementation track (Task 8)
 * is meant to be solvable from alone, so it gets a real two-pane reference layout (doc list
 * left, rendered markdown right), not a dropdown bolted onto a text block.
 */
export function DocsTab(): React.JSX.Element {
  const docs = useStore((s) => s.docs);
  const activeDocId = useStore((s) => s.activeDocId);
  const activeDoc = useStore((s) => s.activeDoc);
  const docsError = useStore((s) => s.docsError);
  const selectDoc = useStore((s) => s.selectDoc);

  useEffect(() => {
    if (docs.length > 0 && activeDocId === null) void selectDoc(docs[0]?.id ?? '');
    // Only auto-select once, the first time the doc list becomes available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.length]);

  if (docs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-gym-text-faint">
        {docsError ? `Could not load docs: ${docsError}` : 'No docs available yet.'}
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-[160px_1fr] overflow-hidden">
      <div className="min-h-0 overflow-y-auto border-r border-gym-border py-1.5">
        {docs.map((d) => (
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
  );
}
